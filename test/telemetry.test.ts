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
    metricExporter.reset();
    let acceptedRequest: Record<string, unknown> | undefined;
    const database = queryable(
      vi.fn(async (sql: string, values?: readonly unknown[]) => {
        if (sql.includes("enqueue_many_v2")) {
          acceptedRequest = JSON.parse(values?.[0] as string)[0] as Record<string, unknown>;
          return {
            rows: [
              {
                ordinal: 1,
                job_id: "00000000-0000-4000-8000-000000000001",
                outcome: "accepted",
              },
            ] as never[],
          };
        }
        if (sql.includes("claim_v3")) {
          return {
            rows: [
              {
                job_id: "00000000-0000-4000-8000-000000000001",
                job_type: "mail.send",
                payload: { recipient: "reader@example.com", accessToken: "trace-secret" },
                contract_version: "mail-current",
                result_max_bytes: 1_048_576,
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
    const queue = new Queue(database, "mail", {
      contracts: {
        "mail.send": {
          currentVersion: "mail-current",
          versions: {
            "mail-current": {
              validatePayload: () => true,
              sensitivePayloadKeys: ["accessToken"],
            },
          },
        },
      },
    });
    const caller = trace.getTracer("test").startSpan("caller");
    const callerContext: Context = trace.setSpan(context.active(), caller);

    const jobId = await context.with(callerContext, () =>
      queue.enqueue("mail.send", {
        recipient: "reader@example.com",
        accessToken: "trace-secret",
      }),
    );
    caller.end();
    const claimed = await queue.claim("worker-a");

    expect(jobId).toBe("00000000-0000-4000-8000-000000000001");
    expect(acceptedRequest?.payload).toEqual({
      recipient: "reader@example.com",
      accessToken: "trace-secret",
    });
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
      "workhorse.enqueue.outcome": "accepted",
    });
    expect(JSON.stringify(enqueueSpan?.attributes)).not.toContain("trace-secret");

    const extracted = propagation.extract(context.active(), claimed!.traceContext, carrierGetter);
    expect(trace.getSpanContext(extracted)?.spanId).toBe(enqueueSpan?.spanContext().spanId);

    await meterProvider.forceFlush();
    const enqueuedMetric = metricExporter
      .getMetrics()
      .flatMap((resource) => resource.scopeMetrics)
      .flatMap((scope) => scope.metrics)
      .find((metric) => metric.descriptor.name === "workhorse.jobs.enqueued");
    expect(enqueuedMetric?.dataPoints).toContainEqual(
      expect.objectContaining({
        attributes: {
          "workhorse.job.type": "mail.send",
          "workhorse.queue.name": "mail",
        },
      }),
    );
  });

  it("runs the handler and completion spans under the persisted remote parent", async () => {
    spanExporter.reset();
    metricExporter.reset();
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
        if (sql.includes("claim_v3")) {
          if (claimed) return { rows: [] };
          claimed = true;
          return {
            rows: [
              {
                job_id: "00000000-0000-4000-8000-000000000002",
                job_type: "mail.send",
                payload: { recipient: "reader@example.com" },
                contract_version: null,
                result_max_bytes: 1_048_576,
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

    await meterProvider.forceFlush();
    const metricsData = metricExporter
      .getMetrics()
      .flatMap((resource) => resource.scopeMetrics)
      .flatMap((scope) => scope.metrics);
    for (const metricName of [
      "workhorse.jobs.claimed",
      "workhorse.jobs.completed",
      "workhorse.handler.runtime",
    ]) {
      const metric = metricsData.find((candidate) => candidate.descriptor.name === metricName);
      expect(metric?.dataPoints).toContainEqual(
        expect.objectContaining({
          attributes: {
            "workhorse.job.type": "mail.send",
            "workhorse.queue.name": "mail",
          },
        }),
      );
    }
    // Handler duration is the one instrument that carries the activation outcome, so it replaces
    // the retired outcome-dimensioned duration histogram without double-counting an activation.
    expect(
      metricsData.find((candidate) => candidate.descriptor.name === "workhorse.handler.duration")
        ?.dataPoints,
    ).toContainEqual(
      expect.objectContaining({
        attributes: {
          "workhorse.job.type": "mail.send",
          "workhorse.queue.name": "mail",
          "workhorse.handler.outcome": "succeeded",
        },
      }),
    );
  });

  it("does not count an idempotent replay as a newly enqueued job", async () => {
    spanExporter.reset();
    metricExporter.reset();
    const database = queryable(
      vi.fn(async (sql: string) => {
        expect(sql).toContain("enqueue_many_v2");
        return {
          rows: [
            {
              ordinal: 1,
              job_id: "00000000-0000-4000-8000-000000000004",
              outcome: "replayed",
            },
          ] as never[],
        };
      }),
    );

    await new Queue(database, "mail").enqueue(
      "mail.replayed",
      {},
      {
        idempotency: { key: "same-request" },
      },
    );
    expect(
      spanExporter.getFinishedSpans().find((span) => span.name === "workhorse.enqueue")?.attributes,
    ).toMatchObject({ "workhorse.enqueue.outcome": "replayed" });
    await meterProvider.forceFlush();

    const enqueuedMetric = metricExporter
      .getMetrics()
      .flatMap((resource) => resource.scopeMetrics)
      .flatMap((scope) => scope.metrics)
      .find((metric) => metric.descriptor.name === "workhorse.jobs.enqueued");
    expect(enqueuedMetric?.dataPoints).not.toContainEqual(
      expect.objectContaining({
        attributes: expect.objectContaining({ "workhorse.job.type": "mail.replayed" }),
      }),
    );
  });

  it("redacts sensitive handler errors before traces and failure persistence", async () => {
    spanExporter.reset();
    const secret = "handler-trace-secret";
    let claimed = false;
    let persistedError: string | undefined;
    const database = queryable(
      vi.fn(async (sql: string, values?: readonly unknown[]) => {
        if (
          sql.includes("tick_v1") ||
          sql.includes("prepare_history_partitions_v1") ||
          sql.includes("retain_history_v1") ||
          sql.includes("prune_terminal_storage_v1")
        ) {
          return { rows: [] };
        }
        if (sql.includes("claim_v3")) {
          if (claimed) return { rows: [] };
          claimed = true;
          return {
            rows: [
              {
                job_id: "00000000-0000-4000-8000-000000000004",
                job_type: "mail.send",
                payload: { accessToken: secret },
                contract_version: "1",
                result_max_bytes: 1_048_576,
                redact_error_details: true,
                trace_context: null,
                attempt: 1,
                max_attempts: 1,
                retry_policy: null,
                deadline_at: null,
                execution_timeout_ms: null,
                attempt_timeout_at: null,
                fence_token: "4",
                lease_expires_at: new Date(Date.now() + 30_000),
              },
            ] as never[],
          };
        }
        if (sql.includes("fail_v1")) {
          persistedError = values?.[3] as string;
          return { rows: [{ state: "failed" }] as never[] };
        }
        throw new Error(`Unexpected query: ${sql}`);
      }),
    );
    const worker = new Worker(new Queue(database, "mail"), {
      workerId: "worker-redaction",
      registryIntervalMs: 0,
      statisticsRollupIntervalMs: 0,
    }).handle("mail.send", async () => {
      throw new Error(`provider rejected ${secret}`);
    });

    expect(await worker.runOnce()).toBe(true);

    expect(persistedError).not.toContain(secret);
    const spans = spanExporter.getFinishedSpans();
    expect(JSON.stringify(spans.map((span) => span.events))).not.toContain(secret);
    expect(JSON.stringify(spans.map((span) => span.events))).toContain(
      "Job handler failed; details redacted",
    );
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
              retry_dimensions: [
                { queue: "mail", type: "mail.recover" },
                { queue: "mail", type: "mail.recover" },
              ],
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
      metricsData.find((metric) => metric.descriptor.name === "workhorse.jobs.retried")?.dataPoints,
    ).toContainEqual(
      expect.objectContaining({
        value: 2,
        attributes: {
          "workhorse.job.type": "mail.recover",
          "workhorse.queue.name": "mail",
        },
      }),
    );
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
      queue: "mail",
      type: "mail.send",
      priority: 0,
      payload: { recipient: "reader@example.com" },
      contractVersion: null,
      resultMaxBytes: 1_048_576,
      redactErrorDetails: false,
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
    expect(retriedMetric?.dataPoints).toContainEqual(
      expect.objectContaining({
        attributes: {
          "workhorse.job.type": "mail.send",
          "workhorse.queue.name": "mail",
        },
      }),
    );
  });

  it("exports queue depth and age without per-job metric attributes", async () => {
    metricExporter.reset();
    const unregister = registerQueueMetrics({
      queueMetricSnapshot: vi.fn<QueueMetricSource["queueMetricSnapshot"]>(async () => [
        {
          queue: "mail",
          readyDepth: 7,
          scheduledDepth: 3,
          activeLeases: 2,
          dependencyBlockedDepth: 8,
          dependencyPendingEdges: 9,
          dependencyFailedResolutions: 3,
          dependencyCountsCapped: false,
          childWaitingParents: 5,
          childPendingChildren: 6,
          childUnjoinedResults: 2,
          childFailedParents: 3,
          childCanceledParents: 1,
          childCountsCapped: false,
          oldestReadyAgeMs: 1_250,
          concurrencyLimit: 5,
          concurrencyActive: 2,
          blockedReadyDepth: 4,
          rateLimitPerSecond: 5,
          rateLimitAvailableTokens: 0.5,
          rateLimitThrottledReadyDepth: 6,
          rateLimitNextEligibleDelayMs: 100,
        },
        {
          queue: "billing",
          readyDepth: 1,
          scheduledDepth: 0,
          activeLeases: 4,
          dependencyBlockedDepth: 0,
          dependencyPendingEdges: 0,
          dependencyFailedResolutions: 0,
          dependencyCountsCapped: true,
          childWaitingParents: 0,
          childPendingChildren: 0,
          childUnjoinedResults: 0,
          childFailedParents: 0,
          childCanceledParents: 0,
          childCountsCapped: true,
          oldestReadyAgeMs: 250,
          concurrencyLimit: null,
          concurrencyActive: 0,
          blockedReadyDepth: 0,
          rateLimitPerSecond: null,
          rateLimitAvailableTokens: 0,
          rateLimitThrottledReadyDepth: 0,
          rateLimitNextEligibleDelayMs: null,
        },
      ]),
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
    const concurrencyLimit = metricsData.find(
      (metric) => metric.descriptor.name === "workhorse.queue.concurrency.limit",
    );
    const dependencyBlocked = metricsData.find(
      (metric) => metric.descriptor.name === "workhorse.queue.dependencies.blocked",
    );
    const dependencyPending = metricsData.find(
      (metric) => metric.descriptor.name === "workhorse.queue.dependencies.pending_edges",
    );
    const dependencyFailed = metricsData.find(
      (metric) => metric.descriptor.name === "workhorse.queue.dependencies.failed_resolutions",
    );
    const dependencyCapped = metricsData.find(
      (metric) => metric.descriptor.name === "workhorse.queue.dependencies.capped",
    );
    const childWaiting = metricsData.find(
      (metric) => metric.descriptor.name === "workhorse.queue.children.waiting_parents",
    );
    const childFailed = metricsData.find(
      (metric) => metric.descriptor.name === "workhorse.queue.children.failed_parents",
    );
    const childCapped = metricsData.find(
      (metric) => metric.descriptor.name === "workhorse.queue.children.capped",
    );
    const concurrencyActive = metricsData.find(
      (metric) => metric.descriptor.name === "workhorse.queue.concurrency.active",
    );
    const concurrencyBlocked = metricsData.find(
      (metric) => metric.descriptor.name === "workhorse.queue.concurrency.blocked_ready",
    );
    const rateConfigured = metricsData.find(
      (metric) => metric.descriptor.name === "workhorse.queue.rate_limit.configured",
    );
    const rateAvailable = metricsData.find(
      (metric) => metric.descriptor.name === "workhorse.queue.rate_limit.available_tokens",
    );
    const rateThrottled = metricsData.find(
      (metric) => metric.descriptor.name === "workhorse.queue.rate_limit.throttled_ready",
    );
    expect(metricsData.map((metric) => metric.descriptor.name)).toContain("workhorse.queue.depth");
    expect(depth?.dataPoints).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          value: 7,
          attributes: { "workhorse.job.state": "ready", "workhorse.queue.name": "mail" },
        }),
        expect.objectContaining({
          value: 3,
          attributes: { "workhorse.job.state": "scheduled", "workhorse.queue.name": "mail" },
        }),
        expect.objectContaining({
          value: 4,
          attributes: { "workhorse.job.state": "active", "workhorse.queue.name": "billing" },
        }),
      ]),
    );
    expect(age?.dataPoints).toContainEqual(
      expect.objectContaining({
        value: 1_250,
        attributes: { "workhorse.queue.name": "mail" },
      }),
    );
    expect(dependencyBlocked?.dataPoints).toContainEqual(
      expect.objectContaining({ value: 8, attributes: { "workhorse.queue.name": "mail" } }),
    );
    expect(dependencyPending?.dataPoints).toContainEqual(
      expect.objectContaining({ value: 9, attributes: { "workhorse.queue.name": "mail" } }),
    );
    expect(dependencyFailed?.dataPoints).toContainEqual(
      expect.objectContaining({ value: 3, attributes: { "workhorse.queue.name": "mail" } }),
    );
    expect(dependencyCapped?.dataPoints).toContainEqual(
      expect.objectContaining({ value: 0, attributes: { "workhorse.queue.name": "mail" } }),
    );
    expect(childWaiting?.dataPoints).toContainEqual(
      expect.objectContaining({ value: 5, attributes: { "workhorse.queue.name": "mail" } }),
    );
    expect(childFailed?.dataPoints).toContainEqual(
      expect.objectContaining({ value: 3, attributes: { "workhorse.queue.name": "mail" } }),
    );
    expect(childCapped?.dataPoints).toContainEqual(
      expect.objectContaining({ value: 1, attributes: { "workhorse.queue.name": "billing" } }),
    );
    expect(dependencyCapped?.dataPoints).toContainEqual(
      expect.objectContaining({ value: 1, attributes: { "workhorse.queue.name": "billing" } }),
    );
    expect(concurrencyLimit?.dataPoints).toContainEqual(
      expect.objectContaining({
        value: 5,
        attributes: { "workhorse.queue.name": "mail" },
      }),
    );
    expect(concurrencyActive?.dataPoints).toContainEqual(
      expect.objectContaining({
        value: 2,
        attributes: { "workhorse.queue.name": "mail" },
      }),
    );
    expect(concurrencyBlocked?.dataPoints).toContainEqual(
      expect.objectContaining({
        value: 4,
        attributes: { "workhorse.queue.name": "mail" },
      }),
    );
    expect(rateConfigured?.dataPoints).toContainEqual(
      expect.objectContaining({ value: 5, attributes: { "workhorse.queue.name": "mail" } }),
    );
    expect(rateAvailable?.dataPoints).toContainEqual(
      expect.objectContaining({ value: 0.5, attributes: { "workhorse.queue.name": "mail" } }),
    );
    expect(rateThrottled?.dataPoints).toContainEqual(
      expect.objectContaining({ value: 6, attributes: { "workhorse.queue.name": "mail" } }),
    );
    for (const metric of metricsData) {
      for (const point of metric.dataPoints) {
        expect(Object.keys(point.attributes)).not.toContain("workhorse.job.id");
      }
    }
  });
});
