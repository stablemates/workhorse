import { randomUUID } from "node:crypto";
import {
  AggregationTemporality,
  type DataPoint,
  InMemoryMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
} from "@opentelemetry/sdk-metrics";
import { metrics, trace } from "@opentelemetry/api";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { registerOpenTelemetry } from "@stablemates/workhorse-otel";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { Worker } from "../src/index.js";
import { createIntegrationTestContext } from "./support/integration.js";

// SM-1884: a lease lapses under an unchanged fence, so fail_v1 and release_owned_v1 answer stale.
// expire_owned_v1 does not read expires_at, so a due deadline or attempt timeout still settles
// under that fence. The cases are the lapsed-lease cases of the Go test
// worker_refused_completion_outcome_test.go.

registerOpenTelemetry();

const { pool, queue } = createIntegrationTestContext(import.meta.url);

const spanExporter = new InMemorySpanExporter();
const metricExporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
const meterProvider = new MeterProvider({
  readers: [
    new PeriodicExportingMetricReader({ exporter: metricExporter, exportIntervalMillis: 60_000 }),
  ],
});

beforeAll(() => {
  metrics.setGlobalMeterProvider(meterProvider);
  trace.setGlobalTracerProvider(
    new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(spanExporter)] }),
  );
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await spanExporter.shutdown();
  await meterProvider.shutdown();
  trace.disable();
  metrics.disable();
});

const lapsedLeaseCases = [
  {
    boundary: "deadline_at",
    state: "failed",
    span: "deadline_exceeded",
    metric: "deadline_exceeded",
  },
  { boundary: "attempt_timeout_at", state: "failed", span: "timeout_exceeded", metric: "timeout" },
  { boundary: undefined, state: "active", span: "stale", metric: "lease_lost" },
] as const;

/** Lets the lease of `taskId` lapse under an unchanged fence, and makes `boundary` due. */
async function lapse(taskId: string, boundary: string | undefined): Promise<void> {
  const past = "clock_timestamp() - interval '1 second'";
  const change = boundary ? `expires_at = ${past}, ${boundary} = ${past}` : `expires_at = ${past}`;
  await pool.query(`UPDATE workhorse.task_runtime SET ${change} WHERE task_id = $1`, [taskId]);
}

async function state(taskId: string): Promise<string> {
  const { rows } = await pool.query<{ state: string }>(
    `SELECT COALESCE(outcome.state, runtime.state) AS state FROM workhorse.task task
       LEFT JOIN workhorse.task_runtime runtime ON runtime.task_id = task.id
       LEFT JOIN workhorse.task_outcome outcome ON outcome.task_id = task.id
      WHERE task.id = $1`,
    [taskId],
  );
  return rows[0]!.state;
}

async function executions(queueName: string): Promise<string[]> {
  await meterProvider.forceFlush();
  const points = metricExporter
    .getMetrics()
    .flatMap((resource) => resource.scopeMetrics)
    .flatMap((scope) => scope.metrics)
    .filter((metric) => metric.descriptor.name === "workhorse.handler.executions")
    .flatMap((metric) => metric.dataPoints as DataPoint<number>[]);
  return points
    .filter((point) => point.attributes["workhorse.queue.name"] === queueName)
    .map((point) => String(point.attributes["workhorse.handler.outcome"]));
}

function spanOutcome(taskId: string): unknown {
  return spanExporter
    .getFinishedSpans()
    .find(
      (span) =>
        span.name === "workhorse.handler" && span.attributes["workhorse.task.id"] === taskId,
    )?.attributes["workhorse.handler.outcome"];
}

describe.each(["fail", "release"] as const)("a stale %s after a lapsed lease", (settlement) => {
  it.each(lapsedLeaseCases)(
    "reports $metric when $boundary is due",
    async ({ boundary, state: settled, span, metric }) => {
      const queueName = `stale-${settlement}-${randomUUID()}`;
      // The boundaries are an hour away, so the worker's own timers cannot reach them.
      const taskId = await queue.enqueue("lapsing", null, {
        queue: queueName,
        maxAttempts: 1,
        deadline: new Date(Date.now() + 3_600_000),
        executionTimeoutMs: 3_600_000,
      });
      const worker = new Worker(queue, {
        queue: queueName,
        registryIntervalMs: 0,
        leaseMs: 60_000,
        heartbeatMs: 30_000,
        maintenanceIntervalMs: 3_600_000,
      });
      if (settlement === "fail") {
        worker.handle("lapsing", async () => {
          await lapse(taskId, boundary);
          throw new Error("the handler failed");
        });
      } else {
        // No handler is registered, so the worker releases the claim through release_owned_v1.
        const releaseOwned = queue.releaseOwned.bind(queue);
        vi.spyOn(queue, "releaseOwned").mockImplementation(async (task, workerId) => {
          await lapse(taskId, boundary);
          return releaseOwned(task, workerId);
        });
      }

      await worker.runOnce();

      expect(await state(taskId)).toBe(settled);
      expect(spanOutcome(taskId)).toBe(span);
      expect(await executions(queueName)).toEqual([metric]);
    },
  );
});

// fail_v1 answers cancel_requested, and acknowledge_cancel_v1 refuses. The worker settles nothing,
// so the handler outcome is a lost lease, not unknown. A trigger of this test database keeps the
// acknowledgement from deleting the runtime row.
it("reports lease_lost when the cancellation acknowledgement after fail_v1 is refused", async () => {
  const queueName = `stale-ack-${randomUUID()}`;
  const taskId = await queue.enqueue("lapsing", null, { queue: queueName, maxAttempts: 1 });
  await pool.query(
    "CREATE FUNCTION public.keep_runtime() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END; $$",
  );
  await pool.query(
    `CREATE TRIGGER keep_runtime BEFORE DELETE ON workhorse.task_runtime FOR EACH ROW
     WHEN (OLD.task_id = '${taskId}') EXECUTE FUNCTION public.keep_runtime()`,
  );
  try {
    const worker = new Worker(queue, {
      queue: queueName,
      registryIntervalMs: 0,
      leaseMs: 60_000,
      heartbeatMs: 30_000,
      maintenanceIntervalMs: 3_600_000,
    }).handle("lapsing", async () => {
      await pool.query("SELECT workhorse.cancel_v1($1, 'test', 'no longer needed')", [taskId]);
      throw new Error("the handler failed");
    });
    await worker.runOnce();
  } finally {
    await pool.query("DROP TRIGGER keep_runtime ON workhorse.task_runtime");
    await pool.query("DROP FUNCTION public.keep_runtime()");
  }

  expect(spanOutcome(taskId)).toBe("stale");
  expect(await executions(queueName)).toEqual(["lease_lost"]);
});
