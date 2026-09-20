import { describe, expect, it } from "vitest";
import type { ClaimedTask } from "../src/types.js";
import { Worker, type WorkerQueueApi } from "../src/worker.js";

async function unsupportedWorkerQueueOperation(): Promise<never> {
  throw new Error("Unexpected worker queue operation");
}

function claimedTask(queue: string): ClaimedTask {
  return {
    id: `claimed-from-${queue}`,
    queue,
    type: "partial-claim",
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

// The first queue yields one task; the claim on the second queue fails.
function partiallyFailingQueue(mode: "claimMany" | "claim") {
  const claimError = new Error("claim failed on the second queue");
  const completed: string[] = [];
  const claimFrom = (queue: string | undefined): ClaimedTask | null => {
    if (queue === "second") throw claimError;
    if (completed.length > 0) return null;
    return claimedTask(queue ?? "default");
  };
  const queue = {
    defaultQueue: "first",
    claim: async (_workerId: string, options?: { queue?: string }) => claimFrom(options?.queue),
    ...(mode === "claimMany"
      ? {
          claimMany: async (_workerId: string, _limit: number, options?: { queue?: string }) => {
            const task = claimFrom(options?.queue);
            return task ? [task] : [];
          },
        }
      : {}),
    complete: async (task: ClaimedTask) => {
      completed.push(task.id);
      return true;
    },
    fail: unsupportedWorkerQueueOperation,
    expireOwned: unsupportedWorkerQueueOperation,
    releaseOwned: unsupportedWorkerQueueOperation,
    tick: async () => [],
    runMaintenance: async () => [],
  } as unknown as WorkerQueueApi;
  return { queue, claimError, completed };
}

describe("worker partial claims", () => {
  it.each(["claimMany", "claim"] as const)(
    "runOnce executes a task claimed before a later %s failure",
    async (mode) => {
      const { queue, claimError, completed } = partiallyFailingQueue(mode);
      const worker = new Worker(queue, {
        queues: ["first", "second"],
        concurrency: 2,
        registryIntervalMs: 0,
      }).handle("partial-claim", async () => null);

      await expect(worker.runOnce()).rejects.toBe(claimError);

      expect(completed).toEqual(["claimed-from-first"]);
    },
  );

  it.each(["claimMany", "claim"] as const)(
    "run executes a task claimed before a later %s failure",
    async (mode) => {
      const { queue, claimError, completed } = partiallyFailingQueue(mode);
      const worker = new Worker(queue, {
        queues: ["first", "second"],
        concurrency: 2,
        registryIntervalMs: 0,
      }).handle("partial-claim", async () => null);

      await expect(worker.run()).rejects.toBe(claimError);

      expect(completed).toEqual(["claimed-from-first"]);
    },
  );
});
