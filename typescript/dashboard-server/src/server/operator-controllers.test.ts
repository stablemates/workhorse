import type { Admin, Queue } from "@stablemates/workhorse";
import { describe, expect, it, vi } from "vitest";
import { createDashboardOperatorControllers } from "./operator-controllers.js";

describe("shared dashboard operator controllers", () => {
  it("routes application and operator calls while delegating host audit plumbing", async () => {
    const queue = {
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
        payload: { approved: true },
        completedAt: new Date("2026-08-12T12:03:00.000Z"),
        completedBy: "configured-operator",
      }),
    } as unknown as Queue;
    const admin = {
      runTaskNow: vi.fn<() => Promise<unknown>>().mockResolvedValue({
        status: "released",
        jobId: "job-1",
        state: "ready",
        runAt: new Date("2026-08-12T12:00:00.000Z"),
      }),
      pauseQueue: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
      resumeQueue: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
      purgeQueue: vi.fn<() => Promise<number>>().mockResolvedValue(3),
      setWorkerPaused: vi.fn<() => Promise<{ paused: boolean }>>().mockResolvedValue({
        paused: true,
      }),
      redrive: vi.fn<() => Promise<unknown>>().mockResolvedValue({
        status: "redriven",
        sourceJobId: "job-1",
        targetJobId: "job-2",
        sourceState: "failed",
        targetState: "ready",
        requestedAt: new Date("2026-08-12T12:04:00.000Z"),
      }),
      redriveMany: vi.fn<() => Promise<unknown>>().mockResolvedValue({
        results: [
          {
            status: "redriven",
            sourceJobId: "job-3",
            targetJobId: "job-4",
            sourceState: "failed",
            targetState: "ready",
            requestedAt: new Date("2026-08-12T12:05:00.000Z"),
          },
          {
            status: "not_failed",
            sourceJobId: "job-5",
            targetJobId: null,
            sourceState: "succeeded",
            targetState: null,
            requestedAt: null,
          },
        ],
        nextCursor: { finishedAt: "2026-08-12T12:05:00.000000Z", jobId: "job-5" },
      }),
    } as unknown as Admin;
    const actions: string[] = [];
    const controllers = createDashboardOperatorControllers({
      requestedBy: "configured-operator",
      run: async (action, operation) => {
        actions.push(action.kind);
        return operation({ admin, queue });
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
    await expect(controllers.taskController.redriveTask?.("job-1", audit)).resolves.toEqual({
      status: "redriven",
      sourceJobId: "job-1",
      targetJobId: "job-2",
      sourceState: "failed",
      targetState: "ready",
      requestedAt: "2026-08-12T12:04:00.000Z",
    });
    await expect(
      controllers.taskController.redriveDeadLetters?.(
        { queue: "critical", jobType: "charge", tags: ["billing"] },
        25,
        null,
        audit,
      ),
    ).resolves.toEqual({
      results: [
        {
          status: "redriven",
          sourceJobId: "job-3",
          targetJobId: "job-4",
          sourceState: "failed",
          targetState: "ready",
          requestedAt: "2026-08-12T12:05:00.000Z",
        },
        {
          status: "not_failed",
          sourceJobId: "job-5",
          targetJobId: null,
          sourceState: "succeeded",
          targetState: null,
          requestedAt: null,
        },
      ],
      nextCursor: { finishedAt: "2026-08-12T12:05:00.000000Z", jobId: "job-5" },
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
      "redriveTask",
      "redriveDeadLetters",
      "setWorkerPaused",
    ]);
    expect(admin.pauseQueue).toHaveBeenCalledWith("critical", audit);
    expect(admin.resumeQueue).toHaveBeenCalledWith("critical", audit);
    expect(admin.purgeQueue).toHaveBeenCalledWith("critical", audit);
    expect(admin.runTaskNow).toHaveBeenCalledWith("job-1", audit);
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
      { idempotencyKey: "request-2", requestedBy: "configured-operator" },
    );
    // Redrive writes a permanent lineage row, so the configured actor is what it is attributed to.
    expect(admin.redrive).toHaveBeenCalledWith("job-1", {
      actor: "configured-operator",
      reason: "deploy",
      requestId: "request-1",
    });
    expect(admin.redriveMany).toHaveBeenCalledWith(
      { queue: "critical", type: "charge", tags: ["billing"] },
      { actor: "configured-operator", reason: "deploy", requestId: "request-1" },
      { limit: 25 },
    );
    expect(admin.setWorkerPaused).toHaveBeenCalledWith("worker-1", true, {
      actor: "configured-operator",
      reason: "deploy",
      requestId: "request-1",
    });
  });

  it("sends only the dead-letter filters a selection actually set, and continues from a cursor", async () => {
    const redriveMany = vi
      .fn<() => Promise<unknown>>()
      .mockResolvedValue({ results: [], nextCursor: null });
    const controllers = createDashboardOperatorControllers({
      run: (_action, operation) =>
        operation({ queue: {} as Queue, admin: { redriveMany } as unknown as Admin }),
    });
    const audit = { actor: "operator", reason: "backlog", requestId: "request-3" };

    await expect(
      controllers.taskController.redriveDeadLetters?.(
        { queue: null, jobType: null, tags: [] },
        100,
        { finishedAt: "2026-08-12T12:05:00.000000Z", jobId: "job-5" },
        audit,
      ),
    ).resolves.toEqual({ results: [], nextCursor: null });

    // An empty queue, type, or tag list is not a filter: Admin.redriveMany rejects an empty one,
    // and sending it would narrow a selection the operator never narrowed.
    expect(redriveMany).toHaveBeenCalledWith({}, audit, {
      limit: 100,
      cursor: { finishedAt: "2026-08-12T12:05:00.000000Z", jobId: "job-5" },
    });
  });

  it("reports a missing worker consistently", async () => {
    const controllers = createDashboardOperatorControllers({
      run: (_action, operation) =>
        operation({
          queue: {} as Queue,
          admin: {
            setWorkerPaused: vi.fn<() => Promise<null>>().mockResolvedValue(null),
          } as unknown as Admin,
        }),
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
