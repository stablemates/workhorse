import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_TIMER_DELAY_MS, setUnrefTimeoutAt } from "../src/timers.js";
import type { ClaimedTask } from "../src/types.js";
import { Worker, type WorkerQueueApi } from "../src/worker.js";

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

async function unsupportedWorkerQueueOperation(): Promise<never> {
  throw new Error("Unexpected worker queue operation");
}

describe("worker expiration timer", () => {
  const warnings: Error[] = [];
  const recordWarning = (warning: Error): void => {
    warnings.push(warning);
  };
  beforeEach(() => {
    warnings.length = 0;
    process.on("warning", recordWarning);
  });
  afterEach(() => {
    process.off("warning", recordWarning);
  });

  it.each([
    ["executionTimeoutMs", "attemptTimeoutAt"],
    ["deadline", "deadlineAt"],
  ] as const)(
    "runs the handler to completion under a 30-day %s",
    async (_label, expirationField) => {
      const expiresAt = new Date(Date.now() + THIRTY_DAYS_MS);
      const task: ClaimedTask = {
        id: `thirty-day-${expirationField}`,
        queue: "default",
        type: "long-lived",
        priority: 0,
        payload: null,
        contractVersion: null,
        resultMaxBytes: 1_048_576,
        redactErrorDetails: false,
        traceContext: null,
        attempt: 1,
        maxAttempts: 1,
        retryPolicy: null,
        deadlineAt: expirationField === "deadlineAt" ? expiresAt : null,
        executionTimeoutMs: expirationField === "attemptTimeoutAt" ? THIRTY_DAYS_MS : null,
        attemptTimeoutAt: expirationField === "attemptTimeoutAt" ? expiresAt : null,
        fenceToken: 1n,
        leaseExpiresAt: new Date(Date.now() + 30_000),
      };
      const completed: string[] = [];
      const queue = {
        defaultQueue: "default",
        claim: async () => task,
        complete: async (claimed: ClaimedTask) => {
          completed.push(claimed.id);
          return true;
        },
        fail: unsupportedWorkerQueueOperation,
        expireOwned: unsupportedWorkerQueueOperation,
        releaseOwned: unsupportedWorkerQueueOperation,
        tick: async () => [],
        runMaintenance: async () => [],
      } as unknown as WorkerQueueApi;
      let abortedBy: unknown;
      const worker = new Worker(queue, { registryIntervalMs: 0 }).handle(
        "long-lived",
        async (_payload, context) => {
          // An overflowing timer fires after about one millisecond, well inside this pause.
          await sleep(50);
          if (context.signal.aborted) abortedBy = context.signal.reason;
          return null;
        },
      );

      await expect(worker.runOnce()).resolves.toBe(true);

      expect(abortedBy).toBeUndefined();
      expect(completed).toEqual([task.id]);
      expect(warnings.filter((warning) => warning.name === "TimeoutOverflowWarning")).toEqual([]);
    },
  );
});

describe("worker lease window", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not run a handler whose claim answer arrived after a full lease", async () => {
    // Only the monotonic clock is fake, so the claim can take a full lease without the test waiting.
    vi.useFakeTimers({ toFake: ["performance"] });
    const task: ClaimedTask = {
      id: "late-claim",
      queue: "default",
      type: "late",
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
      leaseExpiresAt: new Date(Date.now() + 1_000),
    };
    const queue = {
      defaultQueue: "default",
      claim: async () => {
        vi.advanceTimersByTime(1_000);
        return task;
      },
      complete: unsupportedWorkerQueueOperation,
      fail: unsupportedWorkerQueueOperation,
      expireOwned: unsupportedWorkerQueueOperation,
      releaseOwned: unsupportedWorkerQueueOperation,
      tick: async () => [],
      runMaintenance: async () => [],
    } as unknown as WorkerQueueApi;
    let handlerRuns = 0;
    const worker = new Worker(queue, {
      registryIntervalMs: 0,
      leaseMs: 1_000,
      heartbeatMs: 500,
    }).handle("late", async () => {
      handlerRuns += 1;
      return null;
    });

    await expect(worker.runOnce()).resolves.toBe(true);

    expect(handlerRuns).toBe(0);
  });
});

describe("setUnrefTimeoutAt", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("re-arms past the Node timer limit and fires at the target time", () => {
    vi.useFakeTimers({ now: 0 });
    let fired = 0;
    setUnrefTimeoutAt(THIRTY_DAYS_MS, () => fired++);

    vi.advanceTimersByTime(MAX_TIMER_DELAY_MS);
    expect(fired).toBe(0);
    vi.advanceTimersByTime(THIRTY_DAYS_MS - MAX_TIMER_DELAY_MS - 1);
    expect(fired).toBe(0);
    vi.advanceTimersByTime(1);
    expect(fired).toBe(1);
    vi.advanceTimersByTime(THIRTY_DAYS_MS);
    expect(fired).toBe(1);
  });

  it("fires on time when the wall clock jumps backward", () => {
    vi.useFakeTimers({ now: 0 });
    let fired = 0;
    setUnrefTimeoutAt(1_000, () => fired++);

    vi.setSystemTime(-60_000);
    vi.advanceTimersByTime(1_000);

    expect(fired).toBe(1);
  });

  it("cancels a re-armed timer", () => {
    vi.useFakeTimers({ now: 0 });
    let fired = 0;
    const cancel = setUnrefTimeoutAt(THIRTY_DAYS_MS, () => fired++);

    vi.advanceTimersByTime(MAX_TIMER_DELAY_MS + 1);
    cancel();
    vi.advanceTimersByTime(THIRTY_DAYS_MS);
    expect(fired).toBe(0);
  });
});
