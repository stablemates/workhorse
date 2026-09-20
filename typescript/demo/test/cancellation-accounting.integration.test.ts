/**
 * How canceled work is refused, counted, filtered, and attributed.
 *
 * One piece of the demo integration suite. Every piece owns a scratch database, so the pieces run
 * in parallel; see ./support/demo-integration.ts for the harness they share.
 */
import { describe, expect, it } from "vitest";
import { Queue } from "@stablemates/workhorse";
import {
  createLocalOperator,
  createLocalScheduleController,
  DEMO_SCHEDULE_NAMESPACE,
  HEARTBEAT_SCHEDULE_NAME,
  syncDemoSchedules,
} from "../src/app.js";
import {
  TEST_CONTROL_WINDOW_TASK_MS,
  TEST_UNCANCELLABLE_HANDLER_WAIT_MS,
  createDemoIntegrationSuite,
} from "./support/demo-integration.js";

const { createTestApplication, dashboardClient, database, pool, waitFor } =
  createDemoIntegrationSuite(import.meta.url);

describe("Workhorse demo", () => {
  it("reports a missing task as not found rather than a silent success", async () => {
    const { app } = createTestApplication({ operator: createLocalOperator(database) });
    const client = dashboardClient(app);
    await expect(
      client.dashboard.cancelTask({
        id: "00000000-0000-4000-8000-000000000000",
        audit: { actor: "operator", reason: "Ghost task", requestId: "cancel-missing" },
      }),
    ).rejects.toThrow(/not found/i);
    // The failed attempt is still audited, so an operator action never disappears.
    await expect(
      pool.query(`SELECT status, action FROM public.workhorse_demo_audit WHERE request_id = $1`, [
        "cancel-missing",
      ]),
    ).resolves.toMatchObject({ rows: [{ status: "failed", action: "cancelTask" }] });
  });

  it("refuses cancellation from a read-only operator", async () => {
    const { app } = createTestApplication();
    const client = dashboardClient(app);
    const taskId = await new Queue(pool, "demo").enqueue(
      "demo.success",
      { label: "read-only" },
      {},
    );

    await expect(
      client.dashboard.cancelTask({
        id: taskId,
        audit: { actor: "viewer", reason: "Not permitted", requestId: "cancel-read-only" },
      }),
    ).rejects.toThrow(/read-only/i);
    await expect(client.dashboard.taskDetail({ id: taskId })).resolves.toMatchObject({
      identity: { state: "ready" },
    });
    await expect(
      pool.query(`SELECT count(*)::integer AS count FROM public.workhorse_demo_audit`),
    ).resolves.toMatchObject({ rows: [{ count: 0 }] });
  });

  it("counts and filters canceled tasks separately from failed and discarded work", async () => {
    const { app } = createTestApplication({ operator: createLocalOperator(database) });
    const client = dashboardClient(app);
    const queue = new Queue(pool, "demo");
    const canceledId = await queue.enqueue("demo.success", { label: "counted-cancel" }, {});
    const readyId = await queue.enqueue("demo.success", { label: "left-alone" }, {});
    await client.dashboard.cancelTask({
      id: canceledId,
      audit: { actor: "operator", reason: "Counted", requestId: "cancel-counted" },
    });

    const counts = await client.dashboard.taskCounts();
    expect(counts.canceled).toBe(1);
    // The demo's terminal-failure bucket is "discarded". Cancellation must not land in it, nor in
    // the completed bucket, because a canceled task neither failed nor succeeded.
    expect(counts.discarded).toBe(0);
    expect(counts.completed).toBe(0);
    expect(counts.queued).toBe(1);

    const canceledPage = await client.dashboard.tasks({
      filter: "canceled",
      page: 1,
      pageSize: 25,
    });
    expect(canceledPage.total).toBe(1);
    expect(canceledPage.tasks.map((task) => task.id)).toEqual([canceledId]);
    expect(canceledPage.tasks[0]).toMatchObject({ state: "canceled" });

    const discardedPage = await client.dashboard.tasks({
      filter: "discarded",
      page: 1,
      pageSize: 25,
    });
    expect(discardedPage.tasks.map((task) => task.id)).not.toContain(canceledId);
    const queuedPage = await client.dashboard.tasks({ filter: "queued", page: 1, pageSize: 25 });
    expect(queuedPage.tasks.map((task) => task.id)).toEqual([readyId]);
  });

  it("counts and filters blocked tasks with their prerequisite reason", async () => {
    const { app } = createTestApplication();
    const client = dashboardClient(app);
    const queue = new Queue(pool, "demo");
    const prerequisiteId = await queue.enqueue("demo.success", { label: "prerequisite" });
    const blockedId = await queue.enqueue(
      "demo.success",
      { label: "dependent" },
      { prerequisiteTaskId: prerequisiteId },
    );

    await expect(client.dashboard.taskCounts()).resolves.toMatchObject({ all: 2, blocked: 1 });
    const page = await client.dashboard.tasks({ filter: "blocked", page: 1, pageSize: 25 });
    expect(page).toMatchObject({
      filter: "blocked",
      total: 1,
      tasks: [
        {
          id: blockedId,
          state: "blocked",
          blockedReason: "prerequisite_pending",
          prerequisiteTaskIds: [prerequisiteId],
        },
      ],
    });
  });

  it("cancels one recurring occurrence without disabling its schedule", async () => {
    const { app } = createTestApplication({
      operator: createLocalOperator(database),
      scheduleController: createLocalScheduleController(database),
    });
    const client = dashboardClient(app);
    await syncDemoSchedules(pool);
    const stored = await new Queue(pool, "demo").schedules([DEMO_SCHEDULE_NAMESPACE]);
    const heartbeat = stored.find((schedule) => schedule.name === HEARTBEAT_SCHEDULE_NAME)!;
    // Materialize one occurrence directly so the test does not depend on wall-clock cron timing.
    const occurrenceTaskId = (await new Queue(pool, "demo").fireSchedule(
      DEMO_SCHEDULE_NAMESPACE,
      HEARTBEAT_SCHEDULE_NAME,
      heartbeat.revision,
      new Date(),
    ))!;
    expect(occurrenceTaskId).toEqual(expect.any(String));
    await client.dashboard.cancelTask({
      id: occurrenceTaskId,
      audit: { actor: "operator", reason: "Skip this run", requestId: "cancel-occurrence" },
    });

    await expect(client.dashboard.taskDetail({ id: occurrenceTaskId })).resolves.toMatchObject({
      identity: { state: "canceled" },
    });
    // Cancelling one materialized run says nothing about the schedule, which stays active and
    // keeps its next occurrence.
    const cron = await client.dashboard.cron();
    for (const schedule of cron.schedules) expect(schedule.active).toBe(true);
    expect(
      (
        await pool.query<{ configured_enabled: boolean; paused: boolean }>(
          `SELECT configured_enabled, paused FROM workhorse.schedule_definition WHERE namespace = $1`,
          [DEMO_SCHEDULE_NAMESPACE],
        )
      ).rows.every((row) => row.configured_enabled && !row.paused),
    ).toBe(true);
  });

  it("counts a canceled attempt as its own outcome rather than as an error", async () => {
    // Only a task that actually started produces an attempt, so the system chart is exercised
    // through a running task rather than one canceled before dispatch.
    const { app, workhorse } = createTestApplication({
      operator: createLocalOperator(database),
      workerPollMs: 5,
      longRunningTaskMs: TEST_CONTROL_WINDOW_TASK_MS,
    });
    const client = dashboardClient(app);
    workhorse.start();

    try {
      const enqueued = await client.dashboard.enqueueTest({
        kind: "long-running",
        audit: { actor: "operator", reason: "metrics", requestId: "cancel-metrics-seed" },
      });
      await waitFor(
        () => client.dashboard.taskDetail({ id: enqueued.taskId }),
        (detail) => detail.current.runtime?.state === "active",
      );
      await client.dashboard.cancelTask({
        id: enqueued.taskId,
        audit: { actor: "operator", reason: "Metrics", requestId: "cancel-metrics" },
      });
      await waitFor(
        () => client.dashboard.taskDetail({ id: enqueued.taskId }),
        (detail) => detail.identity.state === "canceled",
        600,
        TEST_UNCANCELLABLE_HANDLER_WAIT_MS,
      );

      const system = await client.dashboard.system({ window: "1h" });
      expect(system.outcomes.reduce((total, point) => total + point.canceled, 0)).toBe(1);
      // An operator stopping a task is not a system error. It must not appear as a failed or
      // lease-expired attempt, and it must not raise the error rate.
      expect(system.outcomes.reduce((total, point) => total + point.failed, 0)).toBe(0);
      expect(system.outcomes.reduce((total, point) => total + point.leaseExpired, 0)).toBe(0);
      expect(system.kpis.errorRate.current).toBe(0);
    } finally {
      await workhorse.stop();
    }
  });
});
