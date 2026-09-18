import { setTimeout as sleep } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import type { ClaimedTask, HeartbeatStatus } from "../src/types.js";
import { Worker, type WorkerQueueApi } from "../src/worker.js";

function claimedTask(id: string): ClaimedTask {
  return {
    id,
    queue: "default",
    type: "heartbeat-failure",
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

function fakeQueue(task: ClaimedTask, heartbeatStatus: WorkerQueueApi["heartbeatStatus"]) {
  const completed: string[] = [];
  const fail = vi.fn<WorkerQueueApi["fail"]>(async () => "failed");
  const queue = {
    defaultQueue: "default",
    claim: async () => task,
    heartbeatStatus,
    complete: async (claimed: ClaimedTask) => {
      completed.push(claimed.id);
      return true;
    },
    fail,
    tick: async () => [],
    runMaintenance: async () => [],
  } as unknown as WorkerQueueApi;
  return { queue, completed, fail };
}

describe("worker heartbeat failures", () => {
  it("keeps a task running through one failed heartbeat and renews it on the next round", async () => {
    let calls = 0;
    const { queue, completed, fail } = fakeQueue(
      claimedTask("survives-one-heartbeat-error"),
      async (): Promise<HeartbeatStatus> => {
        calls += 1;
        if (calls === 1) throw new Error("heartbeat connection reset");
        return "accepted";
      },
    );
    let abortedBy: unknown;
    const worker = new Worker(queue, {
      registryIntervalMs: 0,
      leaseMs: 1_000,
      heartbeatMs: 10,
    }).handle("heartbeat-failure", async (_payload, context) => {
      await vi.waitFor(() => expect(calls).toBeGreaterThanOrEqual(3), { timeout: 2_000 });
      abortedBy = context.signal.reason;
      return null;
    });

    await expect(worker.runOnce()).resolves.toBe(true);

    expect(abortedBy).toBeUndefined();
    expect(fail).not.toHaveBeenCalled();
    expect(completed).toEqual(["survives-one-heartbeat-error"]);
  });

  it("aborts a handler locally once no heartbeat has been accepted for one lease", async () => {
    let calls = 0;
    const { queue, completed, fail } = fakeQueue(
      claimedTask("hung-heartbeat"),
      (): Promise<HeartbeatStatus> => {
        calls += 1;
        // A heartbeat that never answers, like a call stuck behind an exhausted pool.
        return new Promise<never>(() => {
          // Never settles.
        });
      },
    );
    const leaseMs = 200;
    let abortedAfterMs: number | undefined;
    const worker = new Worker(queue, {
      registryIntervalMs: 0,
      leaseMs,
      heartbeatMs: 20,
    }).handle("heartbeat-failure", async (_payload, context) => {
      const startedAt = Date.now();
      const aborted = new Promise<boolean>((resolve) => {
        context.signal.addEventListener("abort", () => resolve(true), { once: true });
      });
      if (await Promise.race([aborted, sleep(leaseMs * 10).then(() => false)])) {
        abortedAfterMs = Date.now() - startedAt;
        throw context.signal.reason;
      }
      return null;
    });

    await expect(worker.runOnce()).resolves.toBe(true);

    expect(calls).toBe(1);
    expect(abortedAfterMs).toBeDefined();
    expect(abortedAfterMs!).toBeLessThan(leaseMs * 3);
    expect(completed).toEqual([]);
    expect(fail).not.toHaveBeenCalled();
  });
});
