import { metrics } from "@opentelemetry/api";
import { registerOpenTelemetry } from "@stablemates/workhorse-otel";
import {
  AggregationTemporality,
  InMemoryMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
} from "@opentelemetry/sdk-metrics";
import { afterAll, describe, expect, it, vi } from "vitest";
import { HeartbeatRoundTimeoutError } from "../src/heartbeat-round.js";
import { heartbeatRoundFailureReason } from "../src/telemetry.js";
import type { ClaimedTask, HeartbeatStatus } from "../src/types.js";
import { Worker, type WorkerQueueApi } from "../src/worker.js";

const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
const provider = new MeterProvider({
  readers: [new PeriodicExportingMetricReader({ exporter, exportIntervalMillis: 60_000 })],
});
metrics.setGlobalMeterProvider(provider);
const unregister = registerOpenTelemetry();

afterAll(async () => {
  unregister();
  await provider.shutdown();
  metrics.disable();
});

function metric(name: string) {
  return exporter
    .getMetrics()
    .flatMap((resource) => resource.scopeMetrics)
    .flatMap((scope) => scope.metrics)
    .find((candidate) => candidate.descriptor.name === name);
}

function claimedTask(id: string): ClaimedTask {
  return {
    id,
    queue: "default",
    type: "round-failure",
    priority: 0,
    payload: null,
    contractVersion: null,
    resultMaxBytes: 1_048_576,
    redactErrorDetails: false,
    traceContext: null,
    attempt: 1,
    maxAttempts: 1,
    retryPolicy: null,
    deadlineAt: null,
    executionTimeoutMs: null,
    attemptTimeoutAt: null,
    fenceToken: 1n,
    leaseExpiresAt: new Date(Date.now() + 30_000),
  };
}

function withCode(message: string, code: string): Error {
  return Object.assign(new Error(message), { code });
}

describe("heartbeat round failure reason", () => {
  it.each([
    ["a round deadline", new HeartbeatRoundTimeoutError("deadline"), "timeout"],
    ["statement_timeout", withCode("canceling statement", "57014"), "timeout"],
    ["an idle transaction timeout", withCode("idle", "25P03"), "timeout"],
    ["a socket reset", withCode("read ECONNRESET", "ECONNRESET"), "connection"],
    [
      "a wrapped socket error",
      new Error("query failed", { cause: withCode("connect", "ECONNREFUSED") }),
      "connection",
    ],
    ["SQLSTATE class 08", withCode("connection failure", "08006"), "connection"],
    ["a server shutdown", withCode("terminating connection", "57P01"), "connection"],
    ["a terminated pg client", new Error("Connection terminated unexpectedly"), "connection"],
    ["another SQLSTATE", withCode("deadlock detected", "40P01"), "database"],
    ["an error without a code", new Error("unexpected"), "other"],
    ["a non-error value", "unexpected", "other"],
  ] as const)("reports %s as %s", (_name, error, reason) => {
    expect(heartbeatRoundFailureReason(error)).toBe(reason);
  });
});

describe("failed heartbeat rounds", () => {
  it("counts a rejected round by reason and keeps the task running", async () => {
    let calls = 0;
    const completed: string[] = [];
    const fail = vi.fn<WorkerQueueApi["fail"]>(async () => "failed");
    const queue = {
      defaultQueue: "default",
      claim: async () => claimedTask("survives-a-failed-round"),
      heartbeatStatus: async (): Promise<HeartbeatStatus> => {
        calls += 1;
        if (calls === 1) throw withCode("read ECONNRESET", "ECONNRESET");
        return "accepted";
      },
      complete: async (task: ClaimedTask) => {
        completed.push(task.id);
        return true;
      },
      fail,
      tick: async () => [],
      runMaintenance: async () => [],
    } as unknown as WorkerQueueApi;
    let abortedBy: unknown;
    const worker = new Worker(queue, {
      registryIntervalMs: 0,
      leaseMs: 1_000,
      heartbeatMs: 10,
    }).handle("round-failure", async (_payload, context) => {
      await vi.waitFor(() => expect(calls).toBeGreaterThanOrEqual(3), { timeout: 2_000 });
      abortedBy = context.signal.reason;
      return null;
    });

    await expect(worker.runOnce()).resolves.toBe(true);
    await provider.forceFlush();

    expect(abortedBy).toBeUndefined();
    expect(fail).not.toHaveBeenCalled();
    expect(completed).toEqual(["survives-a-failed-round"]);
    expect(metric("workhorse.worker.heartbeat.round_failure")?.descriptor.unit).toBe("{round}");
    expect(metric("workhorse.worker.heartbeat.round_failure")?.dataPoints).toEqual([
      expect.objectContaining({
        attributes: { "workhorse.heartbeat.failure_reason": "connection" },
        value: 1,
      }),
    ]);
    // A failed round gives no ownership verdict, so the verdict counter stays empty.
    expect(metric("workhorse.worker.heartbeat.failure")?.dataPoints ?? []).toEqual([]);
  });
});
