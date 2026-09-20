/**
 * Cancelling a task at each point in its life, and the audit each cancel leaves.
 *
 * One piece of the demo integration suite. Every piece owns a scratch database, so the pieces run
 * in parallel; see ./support/demo-integration.ts for the harness they share.
 */
import { describe, expect, it } from "vitest";
import { Admin, Queue } from "@stablemates/workhorse";
import { createDrizzleAdapter } from "@stablemates/workhorse-drizzle";
import { createLocalOperator, DEMO_QUEUE } from "../src/app.js";
import { DEMO_QUEUE_OPTIONS } from "../src/contracts.js";
import { createDemoIntegrationSuite } from "./support/demo-integration.js";

const { createTestApplication, dashboardClient, database, pool, waitFor } =
  createDemoIntegrationSuite(import.meta.url);

describe("Workhorse demo", () => {
  it("releases a future-scheduled task now with audit and refuses durable waits", async () => {
    const { app } = createTestApplication({ operator: createLocalOperator(database) });
    const client = dashboardClient(app);
    const queue = new Queue(pool, "demo");
    const admin = new Admin(pool, "demo");
    const originalRunAt = new Date(Date.now() + 3_600_000);
    const taskId = await queue.enqueue(
      "demo.success",
      { label: "run-now" },
      { queue: "run-now-release", runAt: originalRunAt },
    );

    const released = await client.dashboard.runTaskNow({
      id: taskId,
      audit: { actor: "operator", reason: "Needed for incident recovery", requestId: "run-now-1" },
    });
    expect(released).toMatchObject({ status: "released", id: taskId, state: "ready" });
    expect(new Date(released.runAt!).getTime()).toBeLessThan(originalRunAt.getTime());
    await expect(
      client.dashboard.runTaskNow({
        id: taskId,
        audit: { actor: "operator", reason: "Retry click", requestId: "run-now-2" },
      }),
    ).resolves.toMatchObject({ status: "already_ready", id: taskId, state: "ready" });

    const waitingId = await queue.enqueue(
      "demo.success",
      { label: "waiting" },
      { queue: "run-now-wait" },
    );
    const claimed = await queue.claim("run-now-wait-worker", { queue: "run-now-wait" });
    expect(claimed?.id).toBe(waitingId);
    await queue.scheduleWait(claimed!, "run-now-wait-worker", "approval", {
      wakeAt: new Date(Date.now() + 3_600_000),
    });
    const waitingBefore = await admin.getTask(waitingId);
    await expect(
      client.dashboard.runTaskNow({
        id: waitingId,
        audit: { actor: "operator", reason: "Unsafe override attempt", requestId: "run-now-wait" },
      }),
    ).resolves.toMatchObject({
      status: "waiting",
      id: waitingId,
      state: "scheduled",
      runAt: waitingBefore!.runAt.toISOString(),
    });
    await expect(admin.getTask(waitingId)).resolves.toMatchObject({
      state: "scheduled",
      runAt: waitingBefore!.runAt,
    });

    const audit = await pool.query<{
      request_id: string;
      action: string;
      target: string;
      status: string;
      reason: string;
      before: { state: string | null; runAt: string | null; waitName: string | null };
      after: { status: string; id: string; state: string | null; runAt: string | null };
    }>(
      `SELECT request_id, action, target, status, reason, before, after
         FROM public.workhorse_demo_audit
        WHERE request_id IN ('run-now-1', 'run-now-2', 'run-now-wait')
        ORDER BY id`,
    );
    expect(audit.rows).toMatchObject([
      {
        request_id: "run-now-1",
        action: "runTaskNow",
        target: `task:${taskId}`,
        status: "succeeded",
        reason: "Needed for incident recovery",
        before: { state: "scheduled", runAt: originalRunAt.toISOString(), waitName: null },
        after: { status: "released", id: taskId, state: "ready" },
      },
      {
        request_id: "run-now-2",
        action: "runTaskNow",
        target: `task:${taskId}`,
        status: "succeeded",
        after: { status: "already_ready", id: taskId, state: "ready" },
      },
      {
        request_id: "run-now-wait",
        action: "runTaskNow",
        target: `task:${waitingId}`,
        status: "failed",
        before: { state: "scheduled", waitName: "approval" },
        after: { status: "waiting", id: waitingId, state: "scheduled" },
      },
    ]);
  });

  it("cancels an unstarted task immediately, as a distinct terminal state with a recorded audit", async () => {
    // No workers are started, so this task is provably still waiting to be claimed. Cancelling it
    // must be immediate and final, because no handler ever observed it.
    const { app } = createTestApplication({ operator: createLocalOperator(database) });
    const client = dashboardClient(app);
    const queue = new Queue(pool, "demo");
    const taskId = await queue.enqueue("demo.success", { label: "cancel-ready" }, {});

    const result = await client.dashboard.cancelTask({
      id: taskId,
      audit: { actor: "operator", reason: "Superseded by a newer request", requestId: "cancel-1" },
    });
    expect(result).toMatchObject({
      status: "canceled",
      taskId,
      state: "canceled",
      requestedBy: "local-demo",
      reason: "Superseded by a newer request",
    });
    expect(result.finishedAt).toEqual(expect.any(String));

    // Canceled is its own terminal state. It must never be reported as failed or discarded.
    const detail = await client.dashboard.taskDetail({ id: taskId });
    expect(detail.identity.state).toBe("canceled");
    expect(detail.current.outcome).toMatchObject({ state: "canceled" });
    expect(detail.current.runtime).toBeNull();

    const audit = await pool.query<{
      action: string;
      target: string;
      status: string;
      reason: string;
      before: { state: string | null };
      after: { status: string; state: string | null };
    }>(
      `SELECT action, target, status, reason, before, after FROM public.workhorse_demo_audit
          WHERE request_id = $1`,
      ["cancel-1"],
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]).toMatchObject({
      action: "cancelTask",
      target: `task:${taskId}`,
      status: "succeeded",
      reason: "Superseded by a newer request",
      before: { state: "ready" },
      after: { status: "canceled", state: "canceled" },
    });
  });

  it("allows canceling a task without a reason", async () => {
    const { app } = createTestApplication({ operator: createLocalOperator(database) });
    const client = dashboardClient(app);
    const taskId = await new Queue(pool, "demo").enqueue(
      "demo.success",
      { label: "cancel-without-reason" },
      {},
    );

    await expect(
      client.dashboard.cancelTask({
        id: taskId,
        audit: { actor: "operator", requestId: "cancel-without-reason" },
      }),
    ).resolves.toMatchObject({ status: "canceled", state: "canceled", reason: null });
    await expect(
      pool.query(`SELECT reason FROM public.workhorse_demo_audit WHERE request_id = $1`, [
        "cancel-without-reason",
      ]),
    ).resolves.toMatchObject({ rows: [{ reason: null }] });
  });

  it("cancels a future-scheduled task without waiting for its run time", async () => {
    const { app } = createTestApplication({ operator: createLocalOperator(database) });
    const client = dashboardClient(app);
    const queue = new Queue(pool, "demo");
    const taskId = await queue.enqueue(
      "demo.success",
      { label: "cancel-scheduled" },
      { runAt: new Date(Date.now() + 3_600_000) },
    );
    await expect(client.dashboard.taskDetail({ id: taskId })).resolves.toMatchObject({
      current: { runtime: { state: "scheduled" } },
    });

    await expect(
      client.dashboard.cancelTask({
        id: taskId,
        audit: { actor: "operator", reason: "No longer needed", requestId: "cancel-scheduled" },
      }),
    ).resolves.toMatchObject({ status: "canceled", state: "canceled" });
    await expect(client.dashboard.taskDetail({ id: taskId })).resolves.toMatchObject({
      identity: { state: "canceled" },
    });
  });

  it("records a cooperative request for a running task and finalizes it once the handler stops", async () => {
    const { app } = createTestApplication({
      operator: createLocalOperator(database),
      workers: false,
    });
    const adapter = createDrizzleAdapter(database, {
      defaultQueue: DEMO_QUEUE,
      queueOptions: DEMO_QUEUE_OPTIONS,
    });
    const worker = adapter.createWorker({
      queue: DEMO_QUEUE,
      concurrency: 1,
      pollMs: 5,
      registryIntervalMs: 0,
      workerId: "cooperative-cancel-test",
    });
    const handlerStarted = Promise.withResolvers<void>();
    const releaseHandler = Promise.withResolvers<void>();
    worker.handle("demo.test-cooperative-cancel", async () => {
      handlerStarted.resolve();
      await releaseHandler.promise;
      return { completed: true };
    });
    const client = dashboardClient(app);
    const running = worker.run();

    try {
      const taskId = await adapter.queue.enqueue("demo.test-cooperative-cancel", {}, {});
      await handlerStarted.promise;
      await waitFor(
        () => client.dashboard.taskDetail({ id: taskId }),
        (detail) => detail.current.runtime?.state === "active",
      );

      const requested = await client.dashboard.cancelTask({
        id: taskId,
        audit: { actor: "operator", reason: "Runaway task", requestId: "cancel-active" },
      });
      // While the handler still owns the lease, PostgreSQL can only record the request.
      expect(requested).toMatchObject({
        status: "cancel_requested",
        state: "active",
        requestedBy: "local-demo",
        reason: "Runaway task",
      });
      expect(requested.requestedAt).toEqual(expect.any(String));
      expect(requested.finishedAt).toBeNull();

      // The request is visible on the live task before the outcome exists, so an operator is not
      // left staring at an apparently untouched running task.
      const pending = await client.dashboard.taskDetail({ id: taskId });
      expect(pending.current.runtime).toMatchObject({
        state: "active",
        cancellation: { requestedBy: "local-demo", reason: "Runaway task" },
      });

      // The handler owns when it stops. Releasing the explicit gate avoids treating elapsed time
      // as proof that a task remains active between the read above and the cancellation request.
      releaseHandler.resolve();
      const finished = await waitFor(
        () => client.dashboard.taskDetail({ id: taskId }),
        (detail) => detail.identity.state === "canceled",
      );
      expect(finished.current.outcome).toMatchObject({ state: "canceled" });
      // A cooperative cancellation closes the attempt as canceled, never as a failure.
      expect(finished.attempts.map((attempt) => attempt.outcome)).toEqual(["canceled"]);

      const events = await pool.query<{ event_type: string; details: Record<string, unknown> }>(
        `SELECT event_type, details FROM workhorse.task_event
          WHERE task_id = $1 AND event_type IN ('cancel_requested', 'canceled')
          ORDER BY occurred_at, event_id`,
        [taskId],
      );
      expect(events.rows.map((row) => row.event_type)).toEqual(["cancel_requested", "canceled"]);
      expect(events.rows[0]?.details).toMatchObject({
        requested_by: "local-demo",
        reason: "Runaway task",
      });
      expect(events.rows[1]?.details).toMatchObject({ source: "acknowledged" });
    } finally {
      releaseHandler.resolve();
      worker.stop();
      await running;
    }
  });

  it("leaves a task that already finished exactly as it was", async () => {
    const { app, workhorse } = createTestApplication({
      operator: createLocalOperator(database),
      workerPollMs: 5,
    });
    const client = dashboardClient(app);
    workhorse.start();
    let taskId: string;

    try {
      const enqueued = await client.dashboard.enqueueTest({
        kind: "success",
        audit: { actor: "operator", reason: "terminal cancel", requestId: "cancel-terminal-seed" },
      });
      taskId = enqueued.taskId;
      await waitFor(
        () => client.dashboard.taskDetail({ id: taskId }),
        (detail) => detail.identity.state === "succeeded",
      );
    } finally {
      await workhorse.stop();
    }

    const before = await client.dashboard.taskDetail({ id: taskId! });
    const result = await client.dashboard.cancelTask({
      id: taskId!,
      audit: { actor: "operator", reason: "Too late", requestId: "cancel-terminal" },
    });
    expect(result).toMatchObject({ status: "already_terminal", state: "succeeded" });
    // A terminal outcome is immutable: the recorded success must survive the attempt untouched.
    await expect(client.dashboard.taskDetail({ id: taskId! })).resolves.toMatchObject({
      identity: { state: "succeeded" },
      current: { outcome: { state: before.current.outcome?.state } },
    });
    await expect(
      pool.query(`SELECT status FROM public.workhorse_demo_audit WHERE request_id = $1`, [
        "cancel-terminal",
      ]),
    ).resolves.toMatchObject({ rows: [{ status: "succeeded" }] });
  });
});
