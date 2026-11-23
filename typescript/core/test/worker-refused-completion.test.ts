import { afterEach, describe, expect, it } from "vitest";
import { registerTelemetryProvider, type WorkhorseTelemetryProvider } from "../src/telemetry.js";
import type { ClaimedTask } from "../src/types.js";
import { abortWorkerHandlers } from "../src/worker-failure.js";
import { Worker, type WorkerQueueApi } from "../src/worker.js";

const task: ClaimedTask = {
  id: "refused-completion-task",
  queue: "default",
  type: "refused-completion",
  priority: 0,
  payload: null,
  contractVersion: null,
  resultMaxBytes: 1_048_576,
  redactErrorDetails: false,
  traceContext: null,
  attempt: 1,
  maxAttempts: 3,
  retryPolicy: null,
  deadlineAt: null,
  executionTimeoutMs: null,
  attemptTimeoutAt: null,
  fenceToken: 1n,
  leaseExpiresAt: new Date(Date.now() + 30_000),
};

interface Recorded {
  handlerSpan: Record<string, unknown>;
  handlerErrors: number;
  durationOutcomes: unknown[];
  executionOutcomes: unknown[];
  logs: string[];
}

function recordTelemetry(): { recorded: Recorded; unregister: () => void } {
  const recorded: Recorded = {
    handlerSpan: {},
    handlerErrors: 0,
    durationOutcomes: [],
    executionOutcomes: [],
    logs: [],
  };
  const provider: WorkhorseTelemetryProvider = {
    emitLog: (log) => {
      recorded.logs.push(log.eventName);
      if (log.eventName === "workhorse.task.execution_finished") {
        recorded.executionOutcomes.push(log.attributes?.["workhorse.handler.outcome"]);
      }
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
          if (name === "workhorse.handler") recorded.handlerErrors += 1;
          return this;
        },
        recordException() {
          if (name === "workhorse.handler") recorded.handlerErrors += 1;
        },
      }),
  };
  return { recorded, unregister: registerTelemetryProvider(provider) };
}

// complete_v1 refuses the result, and no heartbeat delivered an outcome. As in Python, Ruby, the
// JVM, and .NET, the worker asks expire_owned_v1 for the cause, and acknowledges a requested
// cancellation. It sends nothing to fail_v1. A lost lease is an outcome, not an error, so the
// handler span gets no error status.
describe("reconciliation of a refused completion", () => {
  let unregister: (() => void) | undefined;
  afterEach(() => unregister?.());

  for (const expected of [
    {
      answer: "not_due",
      acknowledgement: undefined,
      span: "stale",
      metric: "lease_lost",
      statements: ["complete", "expireOwned"],
    },
    {
      answer: "stale",
      acknowledgement: undefined,
      span: "stale",
      metric: "lease_lost",
      statements: ["complete", "expireOwned"],
    },
    {
      answer: "deadline_exceeded",
      acknowledgement: undefined,
      span: "deadline_exceeded",
      metric: "deadline_exceeded",
      statements: ["complete", "expireOwned"],
    },
    {
      answer: "timeout_exceeded",
      acknowledgement: undefined,
      span: "timeout_exceeded",
      metric: "timeout",
      statements: ["complete", "expireOwned"],
    },
    {
      answer: "cancel_requested",
      acknowledgement: true,
      span: "canceled",
      metric: "canceled",
      statements: ["complete", "expireOwned", "acknowledgeCancel"],
    },
    {
      answer: "cancel_requested",
      acknowledgement: false,
      span: "stale",
      metric: "lease_lost",
      statements: ["complete", "expireOwned", "acknowledgeCancel"],
    },
  ] as const) {
    const refusal =
      expected.acknowledgement === undefined
        ? ""
        : expected.acknowledgement
          ? " and PostgreSQL accepts the acknowledgement"
          : " and PostgreSQL refuses the acknowledgement";
    it(`gives ${expected.span} when expire_owned_v1 answers ${expected.answer}${refusal}`, async () => {
      const telemetry = recordTelemetry();
      unregister = telemetry.unregister;
      const statements: string[] = [];
      const queue = {
        defaultQueue: "default",
        claim: async () => task,
        complete: async () => {
          statements.push("complete");
          return false;
        },
        fail: async () => {
          statements.push("fail");
          return "stale";
        },
        expireOwned: async () => {
          statements.push("expireOwned");
          return expected.answer;
        },
        acknowledgeCancel: async () => {
          statements.push("acknowledgeCancel");
          return expected.acknowledgement === true;
        },
        heartbeatStatus: async () => "renewed",
        tick: async () => [],
        runMaintenance: async () => [],
      } as unknown as WorkerQueueApi;
      const worker = new Worker(queue, {
        registryIntervalMs: 0,
        heartbeatMs: 1_000,
        leaseMs: 3_000,
      }).handle("refused-completion", async () => ({ done: true }));

      await expect(worker.runOnce()).resolves.toBe(true);

      expect(statements).toEqual(expected.statements);
      expect(telemetry.recorded.handlerSpan["workhorse.handler.outcome"]).toBe(expected.span);
      expect(telemetry.recorded.durationOutcomes).toEqual([expected.metric]);
      expect(telemetry.recorded.executionOutcomes).toEqual([expected.metric]);
      expect(telemetry.recorded.handlerErrors).toBe(0);
    });
  }

  // A stale heartbeat answer arrives after the handler returned, while complete_v1 runs. The local
  // decision is not the verdict of PostgreSQL, so the worker still asks expire_owned_v1, as Python,
  // Go, and Rust do. Here PostgreSQL still holds the lease and a cancellation request.
  it("asks expire_owned_v1 also after a heartbeat reported a lost lease", async () => {
    const telemetry = recordTelemetry();
    unregister = telemetry.unregister;
    const statements: string[] = [];
    let returned = false;
    let reported!: () => void;
    const staleReported = new Promise<void>((resolve) => {
      reported = resolve;
    });
    const queue = {
      defaultQueue: "default",
      claim: async () => task,
      complete: async () => {
        statements.push("complete");
        await staleReported;
        // The worker processes the heartbeat answer before complete_v1 answers.
        await new Promise((resolve) => {
          setTimeout(resolve, 20);
        });
        return false;
      },
      fail: async () => {
        statements.push("fail");
        return "stale";
      },
      expireOwned: async () => {
        statements.push("expireOwned");
        return "cancel_requested";
      },
      acknowledgeCancel: async () => {
        statements.push("acknowledgeCancel");
        return true;
      },
      heartbeatStatus: async () => {
        if (!returned) return "renewed";
        reported();
        return "stale";
      },
      tick: async () => [],
      runMaintenance: async () => [],
    } as unknown as WorkerQueueApi;
    const worker = new Worker(queue, {
      registryIntervalMs: 0,
      heartbeatMs: 50,
      leaseMs: 3_000,
    }).handle("refused-completion", async () => {
      returned = true;
      return { done: true };
    });

    await expect(worker.runOnce()).resolves.toBe(true);

    expect(statements).toEqual(["complete", "expireOwned", "acknowledgeCancel"]);
    expect(telemetry.recorded.handlerSpan["workhorse.handler.outcome"]).toBe("canceled");
    expect(telemetry.recorded.durationOutcomes).toEqual(["canceled"]);
    expect(telemetry.recorded.handlerErrors).toBe(0);
  });

  it("ends the run with the error of a failed expire_owned_v1 request", async () => {
    const telemetry = recordTelemetry();
    unregister = telemetry.unregister;
    const statements: string[] = [];
    const queue = {
      defaultQueue: "default",
      claim: async () => task,
      complete: async () => {
        statements.push("complete");
        return false;
      },
      fail: async () => {
        statements.push("fail");
        return "stale";
      },
      expireOwned: async () => {
        statements.push("expireOwned");
        throw new Error("connection lost");
      },
      acknowledgeCancel: async () => {
        statements.push("acknowledgeCancel");
        return false;
      },
      heartbeatStatus: async () => "renewed",
      tick: async () => [],
      runMaintenance: async () => [],
    } as unknown as WorkerQueueApi;
    const worker = new Worker(queue, {
      registryIntervalMs: 0,
      heartbeatMs: 1_000,
      leaseMs: 3_000,
    }).handle("refused-completion", async () => ({ done: true }));

    await expect(worker.runOnce()).rejects.toThrow("connection lost");

    // The request settled nothing, so the attempt has no outcome.
    expect(statements).toEqual(["complete", "expireOwned"]);
    expect(telemetry.recorded.durationOutcomes).toEqual(["unknown"]);
    expect(telemetry.recorded.executionOutcomes).toEqual([]);
  });

  // The handler returns after the shutdown abort, and complete_v1 refuses the result. A failed
  // statement of the reconciliation is a failed settlement after the shutdown abort, as a failed
  // completion is. The worker logs it, and the run rejects.
  it("logs a failed reconciliation after the shutdown abort", async () => {
    const telemetry = recordTelemetry();
    unregister = telemetry.unregister;
    const statements: string[] = [];
    const queue = {
      defaultQueue: "default",
      claim: async () => task,
      complete: async () => {
        statements.push("complete");
        return false;
      },
      fail: async () => {
        statements.push("fail");
        return "stale";
      },
      expireOwned: async () => {
        statements.push("expireOwned");
        throw new Error("connection lost");
      },
      acknowledgeCancel: async () => {
        statements.push("acknowledgeCancel");
        return false;
      },
      heartbeatStatus: async () => "renewed",
      tick: async () => [],
      runMaintenance: async () => [],
    } as unknown as WorkerQueueApi;
    const worker: Worker = new Worker(queue, {
      registryIntervalMs: 0,
      heartbeatMs: 1_000,
      leaseMs: 3_000,
    }).handle("refused-completion", async () => {
      abortWorkerHandlers(worker);
      return { done: true };
    });

    await expect(worker.runOnce()).rejects.toThrow("connection lost");

    expect(statements).toEqual(["complete", "expireOwned"]);
    expect(telemetry.recorded.logs).toContain("workhorse.worker.shutdown_settlement_failed");
  });
});
