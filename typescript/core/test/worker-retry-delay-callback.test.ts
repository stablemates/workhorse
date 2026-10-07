import { describe, expect, it, vi } from "vitest";
import type { ClaimedTask } from "../src/types.js";
import { WaitConflictError } from "../src/queue/checkpoints-progress-waits.js";
import { Worker, type WorkerQueueApi } from "../src/worker.js";

// SM-1164: fail_v1 reads a retry delay of -1 as the terminal sentinel that only durable replay
// conflicts may send. A retryDelayMs callback that computed -1 failed the task on its first
// attempt instead of retrying it.

const task: ClaimedTask = {
  id: "retry-delay-task",
  queue: "default",
  type: "retry-delay",
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

function failingWorker(retryDelayMs: (attempt: number) => number | undefined, error: Error) {
  const fail = vi.fn<WorkerQueueApi["fail"]>(async () => "ready");
  const queue = {
    defaultQueue: "default",
    claim: async () => task,
    fail,
    tick: async () => [],
    runMaintenance: async () => [],
  } as unknown as WorkerQueueApi;
  const worker = new Worker(queue, { registryIntervalMs: 0, retryDelayMs }).handle(
    "retry-delay",
    async () => {
      throw error;
    },
  );
  return { worker, fail };
}

describe("worker retry delay callback", () => {
  for (const value of [-1, -2, 1.5, Number.NaN, Infinity, 2_147_483_648]) {
    it(`rejects a computed delay of ${value} before fail_v1`, async () => {
      const { worker, fail } = failingWorker(() => value, new Error("transient"));

      await expect(worker.runOnce()).rejects.toThrow(
        "retryDelayMs must return a safe integer between 0 and 2147483647, or undefined",
      );

      expect(fail).not.toHaveBeenCalled();
    });
  }

  it("forwards a valid computed delay and an undefined one", async () => {
    for (const value of [0, 2_147_483_647, undefined]) {
      const { worker, fail } = failingWorker(() => value, new Error("transient"));

      await expect(worker.runOnce()).resolves.toBe(true);

      expect(fail).toHaveBeenCalledWith(task, expect.any(String), expect.any(Error), value);
    }
  });

  it("still sends the terminal sentinel for a durable replay conflict", async () => {
    const retryDelayMs = vi.fn<(attempt: number) => number | undefined>(() => 5);
    const { worker, fail } = failingWorker(
      retryDelayMs,
      new WaitConflictError(
        task.id,
        "pause",
        {} as ConstructorParameters<typeof WaitConflictError>[2],
      ),
    );

    await expect(worker.runOnce()).resolves.toBe(true);

    expect(fail).toHaveBeenCalledWith(task, expect.any(String), expect.any(Error), -1);
    expect(retryDelayMs).not.toHaveBeenCalled();
  });
});
