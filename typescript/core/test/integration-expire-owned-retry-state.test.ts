import { randomUUID } from "node:crypto";
import {
  AggregationTemporality,
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
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ClaimedTask, RetryPolicy } from "../src/index.js";
import { createIntegrationTestContext } from "./support/integration.js";

// expire_owned_telemetry_v1 returns the retry state that a worker turns into a workhorse.retry span
// and a workhorse.tasks.retried count. A fast-tier task keeps its runtime row in
// fast_task_runtime, so these tests hold both tiers to the same retry_state (SM-1694).

registerOpenTelemetry();

const { pool, queue, admin, adminAudit } = createIntegrationTestContext(import.meta.url);

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

afterAll(async () => {
  await spanExporter.shutdown();
  await meterProvider.shutdown();
  trace.disable();
  metrics.disable();
});

type Tier = "full" | "fast";

/** Claim one task on a new queue of `tier` and make its attempt timeout due. */
async function claimWithDueTimeout(
  tier: Tier,
  options: { maxAttempts?: number; retryPolicy?: RetryPolicy } = {},
): Promise<{ task: ClaimedTask; workerId: string }> {
  const queueName = `expire-retry-${tier}-${randomUUID()}`;
  if (tier === "fast") {
    await admin.setQueueTier(queueName, "fast", adminAudit("move to the fast tier"));
  }
  const id = await queue.enqueue("expire-retry", null, {
    queue: queueName,
    executionTimeoutMs: 5_000,
    maxAttempts: options.maxAttempts ?? 3,
    ...(options.retryPolicy === undefined ? {} : { retryPolicy: options.retryPolicy }),
  });
  const workerId = `expire-retry-worker-${randomUUID()}`;
  const [task] = await queue.claimMany(workerId, 1, { queue: queueName, leaseMs: 30_000 });
  expect(task?.id).toBe(id);
  const runtime = tier === "fast" ? "workhorse.fast_task_runtime" : "workhorse.task_runtime";
  const due = await pool.query(
    `UPDATE ${runtime} SET attempt_timeout_at = clock_timestamp() - interval '1 second'
      WHERE task_id = $1`,
    [id],
  );
  expect(due.rowCount, `the task keeps its runtime row in ${runtime}`).toBe(1);
  return { task: task!, workerId };
}

async function expireOwnedTelemetry(task: ClaimedTask, workerId: string) {
  const result = await pool.query<{ status: string; retry_state: string | null }>(
    "SELECT status, retry_state FROM workhorse.expire_owned_telemetry_v1($1, $2, $3)",
    [task.id, workerId, task.fenceToken.toString()],
  );
  return result.rows[0];
}

describe("expire_owned_telemetry_v1 retry state", () => {
  it.each<[Tier, RetryPolicy | undefined, string]>([
    ["fast", undefined, "ready"],
    ["fast", { type: "fixed", delayMs: 60_000 }, "scheduled"],
    ["full", undefined, "ready"],
    ["full", { type: "fixed", delayMs: 60_000 }, "scheduled"],
  ])(
    "returns the retry state of a %s-tier timeout retry with policy %j",
    async (tier, policy, retryState) => {
      const { task, workerId } = await claimWithDueTimeout(tier, { retryPolicy: policy });

      await expect(expireOwnedTelemetry(task, workerId)).resolves.toEqual({
        status: "timeout_exceeded",
        retry_state: retryState,
      });
      await expect(admin.getTask(task.id)).resolves.toMatchObject({
        state: retryState,
        currentAttempt: 2,
      });
    },
  );

  it.each<Tier>(["fast", "full"])(
    "returns no retry state when a %s-tier timeout fails the last attempt",
    async (tier) => {
      const { task, workerId } = await claimWithDueTimeout(tier, { maxAttempts: 1 });

      await expect(expireOwnedTelemetry(task, workerId)).resolves.toEqual({
        status: "timeout_exceeded",
        retry_state: null,
      });
      await expect(admin.getTask(task.id)).resolves.toMatchObject({ state: "failed" });
    },
  );

  it("records the retry span and the retried count for a fast-tier timeout retry", async () => {
    spanExporter.reset();
    metricExporter.reset();
    const { task, workerId } = await claimWithDueTimeout("fast");

    await expect(queue.expireOwned(task, workerId)).resolves.toBe("timeout_exceeded");
    await meterProvider.forceFlush();

    const retrySpan = spanExporter
      .getFinishedSpans()
      .find((span) => span.name === "workhorse.retry");
    expect(retrySpan?.attributes).toMatchObject({
      "workhorse.task.id": task.id,
      "workhorse.task.type": "expire-retry",
      "workhorse.task.attempt": 1,
      "workhorse.retry.outcome": "ready",
    });
    const retried = metricExporter
      .getMetrics()
      .flatMap((resource) => resource.scopeMetrics)
      .flatMap((scope) => scope.metrics)
      .find((metric) => metric.descriptor.name === "workhorse.tasks.retried");
    expect(retried?.dataPoints).toContainEqual(
      expect.objectContaining({
        attributes: { "workhorse.task.type": "expire-retry", "workhorse.queue.name": task.queue },
        value: 1,
      }),
    );
  });
});
