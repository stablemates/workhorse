import { describe, expect, it } from "vitest";
import type { ClaimedJob } from "../src/types.js";
import { Worker, type WorkerQueueApi } from "../src/worker.js";

async function unsupportedWorkerQueueOperation(): Promise<never> {
  throw new Error("Unexpected worker queue operation");
}

describe("worker suspension", () => {
  it.each([
    ["waitForSignal", "runChild"],
    ["runChild", "waitForSignal"],
    ["waitForSignal", "waitForHuman"],
  ] as const)("keeps a %s winner from letting %s return missing data", async (first, second) => {
    const job: ClaimedJob = {
      id: `concurrent-${first}-${second}`,
      queue: "default",
      type: "concurrent-suspension",
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
    const continued: string[] = [];
    const queue = {
      defaultQueue: "default",
      claim: async () => job,
      waitForSignal: async () => ({ status: "waiting", payload: null }),
      waitForHuman: async () => ({ status: "waiting", result: null }),
      createChild: async () => ({
        status: "created",
        child: {
          parentJobId: job.id,
          childJobId: "concurrent-suspension-child",
          name: "side",
          type: "side-effect",
          createdAt: new Date(),
          joinedAt: null,
          result: null,
        },
      }),
      complete: unsupportedWorkerQueueOperation,
      fail: unsupportedWorkerQueueOperation,
      tick: async () => [],
      prepareHistoryPartitions: async () => [],
      rollupStatistics: async () => [],
      retainHistory: async () => [],
      pruneTerminalStorage: async () => [],
    } as unknown as WorkerQueueApi;
    const worker = new Worker(queue, {
      registryIntervalMs: 0,
    }).handle("concurrent-suspension", async (_payload, context) => {
      const operations = {
        waitForSignal: () => context.waitForSignal("approval"),
        waitForHuman: () => context.waitForHuman("review", { prompt: "Continue?" }),
        runChild: () => context.runChild("side", "side-effect", null),
      };
      await Promise.all(
        [first, second].map((operation) =>
          operations[operation]().then(
            () => continued.push(operation),
            () => undefined,
          ),
        ),
      );
      return null;
    });

    await expect(worker.runOnce()).resolves.toBe(true);

    expect(continued).toEqual([]);
  });
});
