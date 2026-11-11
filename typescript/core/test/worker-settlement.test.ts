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
      expireOwned: async () => "stale",
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

  // SM-1944: the release ran inside the handler try, so a failing release_owned_v1 charged the
  // attempt through fail_v1 with the database error as its envelope.
  it("surfaces a failed release of a task with no handler without charging the attempt", async () => {
    const releaseError = new Error("release_owned_v1 timed out");
    const fail = vi.fn<WorkerQueueApi["fail"]>(async () => "ready");
    const retryDelayMs = vi.fn<(attempt: number) => number | undefined>(() => 0);
    const queue = {
      defaultQueue: "default",
      claim: async () => ({ ...task, type: "unregistered" }),
      releaseOwned: async () => {
        throw releaseError;
      },
      fail,
      tick: async () => [],
      runMaintenance: async () => [],
    } as unknown as WorkerQueueApi;
    const worker = new Worker(queue, { registryIntervalMs: 0, retryDelayMs }).handle(
      "settlement",
      async () => null,
    );

    // A failing fail_v1 rejects the pass with its error in the same way.
    await expect(worker.runOnce()).rejects.toBe(releaseError);

    expect(fail).not.toHaveBeenCalled();
    expect(retryDelayMs).not.toHaveBeenCalled();
  });

  it("rejects the pass with the error of a failing fail_v1", async () => {
    const failError = new Error("fail_v1 timed out");
    const queue = {
      defaultQueue: "default",
      claim: async () => task,
      fail: async () => {
        throw failError;
      },
      tick: async () => [],
      runMaintenance: async () => [],
    } as unknown as WorkerQueueApi;
    const worker = new Worker(queue, { registryIntervalMs: 0 }).handle("settlement", async () => {
      throw new Error("handler failed");
    });

    await expect(worker.runOnce()).rejects.toBe(failError);
  });

  // SM-1970 (ADR 0120): a runOnce() that a stop() follows before its pass starts makes no
  // maintenance offer.
  it("makes no maintenance offer in a runOnce() that a stop() ends before its pass", async () => {
    const tick = vi.fn<WorkerQueueApi["tick"]>(async () => []);
    const claim = vi.fn<WorkerQueueApi["claim"]>(async () => task);
    const queue = {
      defaultQueue: "default",
      claim,
      tick,
      runMaintenance: async () => [],
    } as unknown as WorkerQueueApi;
    const worker = new Worker(queue, { registryIntervalMs: 0 }).handle("settlement", () => null);

    const pass = worker.runOnce();
    worker.stop();

    await expect(pass).resolves.toBe(false);
    expect(tick).not.toHaveBeenCalled();
    expect(claim).not.toHaveBeenCalled();
  });
});
