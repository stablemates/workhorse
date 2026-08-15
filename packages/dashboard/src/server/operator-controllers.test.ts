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
      sendSignal: vi.fn<() => Promise<unknown>>().mockResolvedValue({
        status: "delivered",
        jobId: "job-1",
        name: "approval",
        payload: { approved: true },
        deliveredAt: new Date("2026-08-12T12:02:00.000Z"),
        deliveredBy: "configured-operator",
      }),
      completeHumanWait: vi.fn<() => Promise<unknown>>().mockResolvedValue({
        status: "completed",
        jobId: "job-1",
        name: "review",
        result: { approved: true },
        completedAt: new Date("2026-08-12T12:03:00.000Z"),
        completedBy: "configured-operator",
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
      controllers.taskController.signalTask?.(
        "job-1",
        "approval",
        { approved: true },
        "request-1",
        audit,
      ),
    ).resolves.toMatchObject({
      status: "delivered",
      deliveredAt: "2026-08-12T12:02:00.000Z",
    });
    await expect(
      controllers.taskController.completeHumanWait?.(
        "job-1",
        "review",
        { approved: true },
        "request-2",
        audit,
      ),
    ).resolves.toMatchObject({
      status: "completed",
      completedAt: "2026-08-12T12:03:00.000Z",
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
      "signalTask",
      "completeHumanWait",
      "setWorkerPaused",
    ]);
    expect(queue.pauseQueue).toHaveBeenCalledWith("critical");
    expect(queue.resumeQueue).toHaveBeenCalledWith("critical");
    expect(queue.cancel).toHaveBeenCalledWith("job-1", {
      requestedBy: "configured-operator",
      reason: "deploy",
    });
    expect(queue.sendSignal).toHaveBeenCalledWith(
      "job-1",
      "approval",
      { approved: true },
      {
        idempotencyKey: "request-1",
        requestedBy: "configured-operator",
      },
    );
    expect(queue.completeHumanWait).toHaveBeenCalledWith(
      "job-1",
      "review",
      { approved: true },
      { idempotencyKey: "request-2", completedBy: "configured-operator" },
    );
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
