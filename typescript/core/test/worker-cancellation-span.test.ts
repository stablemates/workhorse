import { afterEach, describe, expect, it } from "vitest";
import { registerTelemetryProvider, type WorkhorseTelemetryProvider } from "../src/telemetry.js";
import type { ClaimedTask } from "../src/types.js";
import { Worker, type WorkerQueueApi } from "../src/worker.js";

const task: ClaimedTask = {
  id: "cancellation-span-task",
  queue: "default",
  type: "cancellation-span",
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

interface Recorded {
  handlerSpan: Record<string, unknown>;
  durationOutcomes: unknown[];
  executionRecords: number;
}

function recordTelemetry(): { recorded: Recorded; unregister: () => void } {
  const recorded: Recorded = { handlerSpan: {}, durationOutcomes: [], executionRecords: 0 };
  const provider: WorkhorseTelemetryProvider = {
    emitLog: (log) => {
      if (log.eventName === "workhorse.task.execution_finished") recorded.executionRecords += 1;
    },
    createCounter: () => ({ add() {} }),
    createHistogram: (name) => ({
      record(_value, attributes) {
        if (name === "workhorse.handler.duration") {
          recorded.durationOutcomes.push(attributes?.["workhorse.handler.outcome"]);
        }
      },
    }),
    createGauge: () => ({ record() {} }),
    registerObservations: () => () => {},
    activeContext: () => undefined,
    injectTraceContext: () => null,
    extractTraceContext: () => undefined,
    withSpan: async (name, _attributes, operation) =>
      operation({
        setAttribute(key, value) {
          if (name === "workhorse.handler") recorded.handlerSpan[key] = value;
          return this;
        },
        setAttributes() {
          return this;
        },
        setStatus() {
          return this;
        },
        recordException() {},
      }),
  };
  return { recorded, unregister: registerTelemetryProvider(provider) };
}

// A heartbeat delivers the cancellation, and the handler then returns or throws the abort reason.
// The handler span gets canceled only after PostgreSQL accepts acknowledge_cancel_v1. A refusal
// settles nothing and leaves the task to lease recovery, so the span gets stale, as after a refused
// acknowledgement of a fail_v1 or release_owned_v1 answer.
describe("handler span after a delivered cancellation", () => {
  let unregister: (() => void) | undefined;
  afterEach(() => unregister?.());

  for (const ending of ["returns", "throws"] as const) {
    for (const [acknowledgement, spanOutcome, durationOutcome] of [
      ["accepted", "canceled", "canceled"],
      ["refused", "stale", "unknown"],
    ] as const) {
      it(`gives ${spanOutcome} when the handler ${ending} and PostgreSQL ${acknowledgement} the acknowledgement`, async () => {
        const telemetry = recordTelemetry();
        unregister = telemetry.unregister;
        const queue = {
          defaultQueue: "default",
          claim: async () => task,
          complete: async () => true,
          fail: async () => "failed",
          heartbeatStatus: async () => "cancel_requested",
          acknowledgeCancel: async () => acknowledgement === "accepted",
          tick: async () => [],
          runMaintenance: async () => [],
        } as unknown as WorkerQueueApi;
        const worker = new Worker(queue, {
          registryIntervalMs: 0,
          heartbeatMs: 50,
          leaseMs: 3_000,
        }).handle("cancellation-span", async (_payload, context) => {
          await new Promise<void>((resolve) => {
            context.signal.addEventListener("abort", () => resolve(), { once: true });
          });
          if (ending === "throws") throw context.signal.reason;
          return null;
        });

        await expect(worker.runOnce()).resolves.toBe(true);

        expect(telemetry.recorded.handlerSpan["workhorse.handler.outcome"]).toBe(spanOutcome);
        expect(telemetry.recorded.durationOutcomes).toEqual([durationOutcome]);
        expect(telemetry.recorded.executionRecords).toBe(acknowledgement === "accepted" ? 1 : 0);
      });
    }
  }
});
