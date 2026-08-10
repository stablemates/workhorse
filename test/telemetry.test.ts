import {
  AggregationTemporality,
  InMemoryMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
} from "@opentelemetry/sdk-metrics";
import {
  context,
  metrics,
  propagation,
  trace,
  type Context,
  type TextMapGetter,
} from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Queue } from "../src/queue.js";
import type { ClaimedJob, Queryable } from "../src/types.js";
import { Worker } from "../src/worker.js";
import { registerQueueMetrics, type QueueMetricSource } from "../src/telemetry.js";

const spanExporter = new InMemorySpanExporter();
const contextManager = new AsyncLocalStorageContextManager();
const metricExporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
const metricReader = new PeriodicExportingMetricReader({
  exporter: metricExporter,
  exportIntervalMillis: 60_000,
});
const meterProvider = new MeterProvider({ readers: [metricReader] });

const carrierGetter: TextMapGetter<Record<string, string>> = {
  keys: (carrier) => Object.keys(carrier),
  get: (carrier, key) => carrier[key],
};

beforeAll(() => {
  context.setGlobalContextManager(contextManager.enable());
  propagation.setGlobalPropagator(new W3CTraceContextPropagator());
  metrics.setGlobalMeterProvider(meterProvider);
  trace.setGlobalTracerProvider(
    new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(spanExporter)] }),
  );
});

afterAll(() => {
  spanExporter.shutdown();
  meterProvider.shutdown();
  context.disable();
  propagation.disable();
  trace.disable();
  metrics.disable();
});

function queryable(
  query: (text: string, values?: readonly unknown[]) => Promise<{ rows: never[] }>,
): Queryable {
  return { query } as unknown as Queryable;
}

describe("OpenTelemetry", () => {
  it("persists the enqueue span context outside the payload and restores it on claim", async () => {
    spanExporter.reset();
    let acceptedRequest: Record<string, unknown> | undefined;
    const database = queryable(
      vi.fn(async (sql: string, values?: readonly unknown[]) => {
        if (sql.includes("enqueue_many_v1")) {
          acceptedRequest = JSON.parse(values?.[0] as string)[0] as Record<string, unknown>;
          return { rows: [{ job_id: "00000000-0000-4000-8000-000000000001" }] as never[] };
        }
        if (sql.includes("claim_v1")) {
          return {
            rows: [
              {
                job_id: "00000000-0000-4000-8000-000000000001",
                job_type: "mail.send",
                payload: { recipient: "reader@example.com" },
                trace_context: acceptedRequest?.traceContext,
                attempt: 1,
                max_attempts: 25,
                retry_policy: null,
                deadline_at: null,
                execution_timeout_ms: null,
                attempt_timeout_at: null,
                fence_token: "1",
                lease_expires_at: new Date(Date.now() + 30_000),
              },
            ] as never[],
          };
        }
        throw new Error(`Unexpected query: ${sql}`);
      }),
    );
    const queue = new Queue(database, "mail");
    const caller = trace.getTracer("test").startSpan("caller");
    const callerContext: Context = trace.setSpan(context.active(), caller);

    const jobId = await context.with(callerContext, () =>
      queue.enqueue("mail.send", { recipient: "reader@example.com" }),
    );
    caller.end();
    const claimed = await queue.claim("worker-a");

    expect(jobId).toBe("00000000-0000-4000-8000-000000000001");
    expect(acceptedRequest?.payload).toEqual({ recipient: "reader@example.com" });
    expect((acceptedRequest!.payload as Record<string, unknown>).traceContext).toBeUndefined();
    expect(acceptedRequest?.traceContext).toMatchObject({ traceparent: expect.any(String) });
    expect(claimed?.traceContext).toEqual(acceptedRequest?.traceContext);

    const enqueueSpan = spanExporter
      .getFinishedSpans()
      .find((span) => span.name === "workhorse.enqueue");
    expect(enqueueSpan?.parentSpanContext?.spanId).toBe(caller.spanContext().spanId);
    expect(enqueueSpan?.attributes).toMatchObject({
      "workhorse.queue.name": "mail",
      "workhorse.job.type": "mail.send",
      "workhorse.enqueue.count": 1,
    });

    const extracted = propagation.extract(context.active(), claimed!.traceContext, carrierGetter);
    expect(trace.getSpanContext(extracted)?.spanId).toBe(enqueueSpan?.spanContext().spanId);
  });

  it("runs the handler and completion spans under the persisted remote parent", async () => {
    spanExporter.reset();
    const traceContext = {
      traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
    };
    let claimed = false;
    const database = queryable(
      vi.fn(async (sql: string) => {
        if (
          sql.includes("tick_v1") ||
          sql.includes("prepare_history_partitions_v1") ||
          sql.includes("retain_history_v1") ||
          sql.includes("prune_terminal_storage_v1")
        ) {
          return { rows: [] };
        }
        if (sql.includes("claim_v1")) {
          if (claimed) return { rows: [] };
          claimed = true;
          return {
            rows: [
              {
                job_id: "00000000-0000-4000-8000-000000000002",
                job_type: "mail.send",
                payload: { recipient: "reader@example.com" },
                trace_context: traceContext,
                attempt: 2,
                max_attempts: 25,
                retry_policy: null,
                deadline_at: null,
                execution_timeout_ms: null,
                attempt_timeout_at: null,
                fence_token: "2",
                lease_expires_at: new Date(Date.now() + 30_000),
              },
            ] as never[],
          };
        }
        if (sql.includes("complete_v1")) return { rows: [{ accepted: true }] as never[] };
        throw new Error(`Unexpected query: ${sql}`);
      }),
    );
    const worker = new Worker(new Queue(database, "mail"), {
      workerId: "worker-a",
      registryIntervalMs: 0,
      statisticsRollupIntervalMs: 0,
    });
    worker.handle("mail.send", async () => ({ sent: true }));

    expect(await worker.runOnce()).toBe(true);

    const spans = spanExporter.getFinishedSpans();
    const handlerSpan = spans.find((span) => span.name === "workhorse.handler");
    const completionSpan = spans.find((span) => span.name === "workhorse.complete");
    expect(handlerSpan?.parentSpanContext?.spanId).toBe("00f067aa0ba902b7");
    expect(handlerSpan?.attributes).toMatchObject({
      "workhorse.queue.name": "mail",
      "workhorse.job.type": "mail.send",
      "workhorse.job.attempt": 2,
    });
    expect(completionSpan?.parentSpanContext?.spanId).toBe(handlerSpan?.spanContext().spanId);
  });

  it("emits recovery telemetry from the production tick path", async () => {
    spanExporter.reset();
    metricExporter.reset();
    const database = queryable(
      vi.fn(async (sql: string) => {
        expect(sql).toContain("tick_v1");
        return {
          rows: [
            {
              phase: "promote",
              rows_affected: 0,
              duration_ms: 1,
              skipped_lock: false,
              error: null,
              expired_leases: 0,
              retried: 0,
            },
            {
              phase: "recover",
              rows_affected: 4,
              duration_ms: 2,
              skipped_lock: false,
              error: null,
              expired_leases: 3,
              retried: 2,
            },
          ] as never[],
        };
      }),
    );

    await new Queue(database).tick();
    await meterProvider.forceFlush();

    const recoverySpan = spanExporter
      .getFinishedSpans()
      .find((span) => span.name === "workhorse.recovery");
    expect(recoverySpan?.attributes).toMatchObject({
      "workhorse.recovery.rows_affected": 4,
      "workhorse.recovery.expired_leases": 3,
      "workhorse.recovery.retried": 2,
    });
    const metricsData = metricExporter
      .getMetrics()
      .flatMap((resource) => resource.scopeMetrics)
      .flatMap((scope) => scope.metrics);
    expect(
      metricsData.find((metric) => metric.descriptor.name === "workhorse.leases.expired")
        ?.dataPoints[0]?.value,
    ).toBe(3);
    expect(
      metricsData.find((metric) => metric.descriptor.name === "workhorse.jobs.retried")
        ?.dataPoints[0]?.value,
    ).toBe(2);
  });

  it("emits retry telemetry when a worker-owned execution timeout starts another attempt", async () => {
    spanExporter.reset();
    metricExporter.reset();
    const database = queryable(
      vi.fn(async (sql: string) => {
        expect(sql).toContain("expire_owned_telemetry_v1");
        return {
          rows: [{ status: "timeout_exceeded", retry_state: "scheduled" }] as never[],
        };
      }),
    );
    const job: ClaimedJob = {
      id: "00000000-0000-4000-8000-000000000003",
      type: "mail.send",
      payload: { recipient: "reader@example.com" },
      traceContext: null,
      attempt: 1,
      maxAttempts: 2,
      retryPolicy: null,
      deadlineAt: null,
      executionTimeoutMs: 1_000,
      attemptTimeoutAt: new Date(),
      fenceToken: 3n,
      leaseExpiresAt: new Date(),
    };

    expect(await new Queue(database, "mail").expireOwned(job, "worker-a")).toBe("timeout_exceeded");
    await meterProvider.forceFlush();

    const retrySpan = spanExporter
      .getFinishedSpans()
      .find((span) => span.name === "workhorse.retry");
    expect(retrySpan?.attributes).toMatchObject({
      "workhorse.job.id": job.id,
      "workhorse.job.type": job.type,
      "workhorse.job.attempt": job.attempt,
      "workhorse.retry.outcome": "scheduled",
    });
    const retriedMetric = metricExporter
      .getMetrics()
      .flatMap((resource) => resource.scopeMetrics)
      .flatMap((scope) => scope.metrics)
      .find((metric) => metric.descriptor.name === "workhorse.jobs.retried");
    expect(retriedMetric?.dataPoints[0]?.value).toBeGreaterThan(0);
  });

  it("exports queue depth and age with only fixed-cardinality metric attributes", async () => {
    metricExporter.reset();
    const unregister = registerQueueMetrics({
      health: vi.fn<QueueMetricSource["health"]>(async () => ({
        readyDepth: 7,
        scheduledDepth: 3,
        activeLeases: 2,
        oldestReadyAgeMs: 1_250,
      })),
    });

    await meterProvider.forceFlush();
    unregister();

    const metricsData = metricExporter
      .getMetrics()
      .flatMap((resource) => resource.scopeMetrics)
      .flatMap((scope) => scope.metrics);
    const depth = metricsData.find((metric) => metric.descriptor.name === "workhorse.queue.depth");
    const age = metricsData.find(
      (metric) => metric.descriptor.name === "workhorse.queue.oldest_ready_age",
    );
    expect(metricsData.map((metric) => metric.descriptor.name)).toContain("workhorse.queue.depth");
    expect(depth?.dataPoints).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ value: 7, attributes: { "workhorse.job.state": "ready" } }),
        expect.objectContaining({ value: 3, attributes: { "workhorse.job.state": "scheduled" } }),
        expect.objectContaining({ value: 2, attributes: { "workhorse.job.state": "active" } }),
      ]),
    );
    expect(age?.dataPoints).toContainEqual(
      expect.objectContaining({ value: 1_250, attributes: {} }),
    );
    for (const metric of metricsData) {
      for (const point of metric.dataPoints) {
        expect(Object.keys(point.attributes)).not.toContain("workhorse.job.id");
        expect(Object.keys(point.attributes)).not.toContain("workhorse.job.type");
        expect(Object.keys(point.attributes)).not.toContain("workhorse.queue.name");
      }
    }
  });
});
