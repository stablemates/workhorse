import { describe, expect, it, vi } from "vitest";
import type { ClaimedTask } from "../src/types.js";
import { Worker, type WorkerQueueApi } from "../src/worker.js";

const task: ClaimedTask = {
  id: "settlement-task",
  queue: "default",
  type: "settlement",
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

describe("worker settlement", () => {
  it("surfaces a completion error from a custom queue without charging it to the handler", async () => {
    const writeError = new Error("completion transport failed");
    const fail = vi.fn<WorkerQueueApi["fail"]>(async () => "failed");
    const queue = {
      defaultQueue: "default",
      claim: async () => task,
      complete: async () => {
        throw writeError;
      },
      fail,
      tick: async () => [],
      runMaintenance: async () => [],
    } as unknown as WorkerQueueApi;
    const worker = new Worker(queue, { registryIntervalMs: 0 }).handle(
      "settlement",
      async () => null,
    );

    await expect(worker.runOnce()).rejects.toBe(writeError);

    expect(fail).not.toHaveBeenCalled();
  });

  it("still settles a rejected completion through fail_v1", async () => {
    const fail = vi.fn<WorkerQueueApi["fail"]>(async () => "stale");
    const queue = {
      defaultQueue: "default",
      claim: async () => task,
      complete: async () => false,
      acknowledgeCancel: async () => false,
      fail,
      tick: async () => [],
      runMaintenance: async () => [],
    } as unknown as WorkerQueueApi;
    const worker = new Worker(queue, { registryIntervalMs: 0 }).handle(
      "settlement",
      async () => null,
    );

    await expect(worker.runOnce()).resolves.toBe(true);

    expect(fail).toHaveBeenCalledTimes(1);
  });
});
