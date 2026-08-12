import type { Queue } from "@workhorse/core";
import { describe, expect, it, vi } from "vitest";
import { createDashboardOperatorControllers } from "./operator-controllers.js";

describe("shared dashboard operator controllers", () => {
  it("owns the common Queue calls while delegating host audit plumbing", async () => {
    const queue = {
      pauseQueue: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
      resumeQueue: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
      purgeQueue: vi.fn<() => Promise<number>>().mockResolvedValue(3),
      runTaskNow: vi.fn<() => Promise<unknown>>().mockResolvedValue({
        status: "released",
        jobId: "job-1",
        state: "ready",
        runAt: new Date("2026-08-12T12:00:00.000Z"),
      }),
      cancel: vi.fn<() => Promise<unknown>>().mockResolvedValue({
        status: "canceled",
        jobId: "job-1",
        state: "canceled",
        currentAttempt: 0,
        requestedAt: new Date("2026-08-12T12:01:00.000Z"),
        requestedBy: "configured-operator",
        reason: "deploy",
        finishedAt: new Date("2026-08-12T12:01:00.000Z"),
      }),
      setWorkerPaused: vi.fn<() => Promise<{ paused: boolean }>>().mockResolvedValue({
        paused: true,
      }),
    } as unknown as Queue;
    const actions: string[] = [];
    const controllers = createDashboardOperatorControllers({
      requestedBy: "configured-operator",
      run: async (action, operation) => {
        actions.push(action.kind);
        return operation(queue);
      },
    });
    const audit = { actor: "browser-actor", reason: "deploy", requestId: "request-1" };

    await expect(
      controllers.queueController.setQueuePaused?.("critical", true, audit),
    ).resolves.toEqual({ paused: true });
    await expect(
      controllers.queueController.setQueuePaused?.("critical", false, audit),
    ).resolves.toEqual({ paused: false });
    await expect(controllers.queueController.purgeQueue?.("critical", audit)).resolves.toEqual({
      deletedCount: 3,
    });
    await expect(controllers.taskController.runTaskNow?.("job-1", audit)).resolves.toEqual({
      status: "released",
      id: "job-1",
      state: "ready",
      runAt: "2026-08-12T12:00:00.000Z",
    });
    await expect(controllers.taskController.cancelTask?.("job-1", audit)).resolves.toMatchObject({
      status: "canceled",
      requestedAt: "2026-08-12T12:01:00.000Z",
      finishedAt: "2026-08-12T12:01:00.000Z",
    });
    await expect(
      controllers.workerController.setWorkerPaused?.("worker-1", true, audit),
    ).resolves.toEqual({ paused: true });

    expect(actions).toEqual([
      "setQueuePaused",
      "setQueuePaused",
      "purgeQueue",
      "runTaskNow",
      "cancelTask",
      "setWorkerPaused",
    ]);
    expect(queue.pauseQueue).toHaveBeenCalledWith("critical");
    expect(queue.resumeQueue).toHaveBeenCalledWith("critical");
    expect(queue.cancel).toHaveBeenCalledWith("job-1", {
      requestedBy: "configured-operator",
      reason: "deploy",
    });
    expect(queue.setWorkerPaused).toHaveBeenCalledWith("worker-1", true, {
      requestedBy: "configured-operator",
      reason: "deploy",
    });
  });

  it("reports a missing worker consistently", async () => {
    const controllers = createDashboardOperatorControllers({
      run: (_action, operation) =>
        operation({
          setWorkerPaused: vi.fn<() => Promise<null>>().mockResolvedValue(null),
        } as unknown as Queue),
    });

    await expect(
      controllers.workerController.setWorkerPaused?.("gone", true, {
        actor: "operator",
        reason: "deploy",
        requestId: "request-2",
      }),
    ).rejects.toThrow("Worker gone is not registered");
  });
});
