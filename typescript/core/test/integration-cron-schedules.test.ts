import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { Queue, Worker } from "../src/index.js";
import { createIntegrationTestContext } from "./support/integration.js";

const { pool, queue } = createIntegrationTestContext(import.meta.url);

describe("cron schedules", () => {
  it("cancels one recurring occurrence without disabling later occurrences", async () => {
    await queue.syncSchedules("cancel-recurring", [
      {
        name: "pulse",
        schedule: "* * * * *",
        job: { type: "recurring-cancel", payload: { value: 1 } },
      },
    ]);
    const [schedule] = await queue.schedules(["cancel-recurring"]);
    const firstId = await queue.fireSchedule(
      schedule!.namespace,
      schedule!.name,
      schedule!.revision,
      new Date("2026-01-01T00:00:00.000Z"),
    );
    expect(firstId).not.toBeNull();
    expect((await queue.cancel(firstId!)).status).toBe("canceled");
    const secondId = await queue.fireSchedule(
      schedule!.namespace,
      schedule!.name,
      schedule!.revision,
      new Date("2026-01-01T00:01:00.000Z"),
    );
    expect(secondId).not.toBeNull();
    expect(secondId).not.toBe(firstId);
    expect(await queue.getJob(secondId!)).toMatchObject({ state: "ready" });
    expect((await queue.schedules(["cancel-recurring"])).map((item) => item.name)).toEqual([
      "pulse",
    ]);
  });

  it("includes canceled jobs in health counts", async () => {
    const canceledId = await queue.enqueue("health-canceled", null);
    await queue.cancel(canceledId);
    await queue.enqueue("health-ready", null);
    const health = await queue.health();
    expect(health.schemaVersion).toBe(42);
    expect(health.counts).toEqual({
      blocked: 0,
      scheduled: 0,
      ready: 1,
      active: 0,
      succeeded: 0,
      failed: 0,
      canceled: 1,
    });
  });

  it("propagates concurrency keys from recurring schedules into fired jobs", async () => {
    const namespace = `keyed-schedule-${randomUUID()}`;
    await queue.syncSchedules(namespace, [
      {
        name: "keyed",
        schedule: "0 * * * *",
        job: {
          type: "scheduled-keyed",
          payload: { scheduled: true },
          concurrencyKey: "tenant-scheduled",
        },
      },
    ]);
    const stored = (await queue.schedules([namespace]))[0]!;
    const jobId = await queue.fireSchedule(
      namespace,
      stored.name,
      stored.revision,
      new Date("2026-08-11T03:00:00Z"),
    );
    await expect(queue.getJob(jobId!)).resolves.toMatchObject({
      concurrencyKey: "tenant-scheduled",
    });
  });

  it("synchronizes namespaced worker schedules and safely prunes removed definitions", async () => {
    await queue.syncSchedules("integration", [
      {
        name: "daily-report",
        schedule: "0 6 * * *",
        job: {
          type: "generate-report",
          payload: { scope: "daily" },
          queue: "reports",
          maxAttempts: 5,
        },
      },
      {
        name: "disabled-cleanup",
        schedule: "0 2 * * 0",
        enabled: false,
        job: { type: "cleanup", payload: null },
      },
    ]);

    expect(
      (
        await pool.query(
          `SELECT schedule_name, cron_expression, queue_name, job_type, payload, max_attempts,
                  enabled, revision::text
             FROM workhorse.schedule_definition
            WHERE namespace = 'integration'
            ORDER BY schedule_name`,
        )
      ).rows,
    ).toEqual([
      {
        schedule_name: "daily-report",
        cron_expression: "0 6 * * *",
        queue_name: "reports",
        job_type: "generate-report",
        payload: { scope: "daily" },
        max_attempts: 5,
        enabled: true,
        revision: "1",
      },
      {
        schedule_name: "disabled-cleanup",
        cron_expression: "0 2 * * 0",
        queue_name: "default",
        job_type: "cleanup",
        payload: null,
        max_attempts: 25,
        enabled: false,
        revision: "1",
      },
    ]);

    await queue.syncSchedules("integration-other", [
      {
        name: "other-report",
        schedule: "0 8 * * *",
        job: { type: "other-report", payload: {} },
      },
    ]);
    await queue.syncSchedules("integration", [
      {
        name: "daily-report",
        schedule: "30 6 * * *",
        job: { type: "generate-report", payload: { scope: "changed" }, queue: "reports" },
      },
    ]);

    expect(
      (
        await pool.query(
          "SELECT namespace, schedule_name, enabled, revision::text FROM workhorse.schedule_definition ORDER BY namespace, schedule_name",
        )
      ).rows,
    ).toEqual([
      {
        namespace: "integration",
        schedule_name: "daily-report",
        enabled: true,
        revision: "2",
      },
      {
        namespace: "integration",
        schedule_name: "disabled-cleanup",
        enabled: false,
        revision: "1",
      },
      {
        namespace: "integration-other",
        schedule_name: "other-report",
        enabled: true,
        revision: "1",
      },
    ]);
  });

  it("rejects invalid cron expressions before persisting a schedule", async () => {
    await expect(
      queue.syncSchedules("integration", [
        {
          name: "invalid",
          schedule: "every sometime",
          job: { type: "invalid", payload: {} },
        },
      ]),
    ).rejects.toThrow(/Invalid cron expression for schedule invalid/);
    expect(
      (await pool.query("SELECT count(*)::integer AS count FROM workhorse.schedule_definition"))
        .rows[0]?.count,
    ).toBe(0);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, 1.5, -1, 101])(
    "rejects invalid recurring priority %s before serialization",
    async (priority) => {
      await expect(
        queue.syncSchedules("invalid-priority", [
          {
            name: "invalid-priority",
            schedule: "0 * * * *",
            job: { type: "invalid-priority", payload: null, priority },
          },
        ]),
      ).rejects.toThrow("priority must be an integer between 0 and 100");
    },
  );

  it("lets workers coordinate recurring occurrences without duplicate jobs", async () => {
    await queue.syncSchedules("integration", [
      {
        name: "heartbeat",
        schedule: "* * * * * *",
        job: { type: "cron-tick", payload: { source: "worker" } },
      },
    ]);
    const first = new Worker(queue, {
      workerId: "scheduler-a",
      scheduleNamespaces: ["integration"],
    }).handle("cron-tick", () => ({ worker: "a" }));
    const second = new Worker(queue, {
      workerId: "scheduler-b",
      scheduleNamespaces: ["integration"],
    }).handle("cron-tick", () => ({ worker: "b" }));

    expect((await Promise.all([first.runOnce(), second.runOnce()])).filter(Boolean)).toHaveLength(
      1,
    );
    expect(
      (
        await pool.query(
          "SELECT count(*)::integer AS count FROM workhorse.schedule_occurrence WHERE namespace = 'integration' AND schedule_name = 'heartbeat'",
        )
      ).rows[0]?.count,
    ).toBe(1);
    expect(
      (await pool.query("SELECT count(*)::integer AS count FROM workhorse.job")).rows[0]?.count,
    ).toBe(1);
  });

  it("rejects stale schedule revisions after a definition changes", async () => {
    await queue.syncSchedules("integration", [
      {
        name: "revision-fence",
        schedule: "0 * * * *",
        job: { type: "old", payload: { revision: 1 } },
      },
    ]);
    const [oldDefinition] = await queue.schedules(["integration"]);
    await queue.syncSchedules("integration", [
      {
        name: "revision-fence",
        schedule: "30 * * * *",
        job: { type: "new", payload: { revision: 2 } },
      },
    ]);

    expect(
      await queue.fireSchedule(
        oldDefinition!.namespace,
        oldDefinition!.name,
        oldDefinition!.revision,
        new Date("2026-07-22T13:30:00.000Z"),
      ),
    ).toBeNull();
    expect(
      (await pool.query("SELECT count(*)::integer AS count FROM workhorse.job")).rows[0]?.count,
    ).toBe(0);
  });

  it("deduplicates concurrent calls at the schedule occurrence boundary", async () => {
    await queue.syncSchedules("integration", [
      {
        name: "hourly-rollup",
        schedule: "0 * * * *",
        job: { type: "rollup", payload: { scope: "hourly" } },
      },
    ]);
    const [definition] = await queue.schedules(["integration"]);
    const occurrence = new Date("2026-07-22T13:00:00.000Z");
    const results = await Promise.all([
      queue.fireSchedule("integration", "hourly-rollup", definition!.revision, occurrence),
      queue.fireSchedule("integration", "hourly-rollup", definition!.revision, occurrence),
    ]);

    expect(results.filter(Boolean)).toHaveLength(1);
    expect(
      (await pool.query("SELECT count(*)::integer AS count FROM workhorse.job")).rows[0]?.count,
    ).toBe(1);
    expect(
      (
        await pool.query(
          "SELECT count(*)::integer AS count FROM workhorse.schedule_occurrence WHERE namespace = 'integration' AND schedule_name = 'hourly-rollup'",
        )
      ).rows[0]?.count,
    ).toBe(1);
  });

  it("returns null when a schedule occurrence is replayed after its first fire commits", async () => {
    await queue.syncSchedules("integration", [
      {
        name: "serialized-hourly-rollup",
        schedule: "0 * * * *",
        job: { type: "rollup", payload: { scope: "hourly" } },
      },
    ]);
    const [definition] = await queue.schedules(["integration"]);
    const occurrence = new Date("2026-07-22T14:00:00.000Z");

    const firstId = await queue.fireSchedule(
      "integration",
      "serialized-hourly-rollup",
      definition!.revision,
      occurrence,
    );
    const replayedId = await queue.fireSchedule(
      "integration",
      "serialized-hourly-rollup",
      definition!.revision,
      occurrence,
    );

    expect(firstId).not.toBeNull();
    expect(replayedId).toBeNull();
    expect(
      (await pool.query("SELECT count(*)::integer AS count FROM workhorse.job")).rows[0]?.count,
    ).toBe(1);
  });

  it("returns null when a schedule occurrence is replayed before its first fire commits", async () => {
    await queue.syncSchedules("integration", [
      {
        name: "overlapping-hourly-rollup",
        schedule: "0 * * * *",
        job: { type: "rollup", payload: { scope: "hourly" } },
      },
    ]);
    const [definition] = await queue.schedules(["integration"]);
    const occurrence = new Date("2026-07-22T15:00:00.000Z");
    const winnerClient = await pool.connect();

    try {
      await winnerClient.query("BEGIN");
      const winnerId = await new Queue(winnerClient).fireSchedule(
        "integration",
        "overlapping-hourly-rollup",
        definition!.revision,
        occurrence,
      );
      const replayedId = await queue.fireSchedule(
        "integration",
        "overlapping-hourly-rollup",
        definition!.revision,
        occurrence,
      );

      expect(winnerId).not.toBeNull();
      expect(replayedId).toBeNull();
      await winnerClient.query("COMMIT");
    } catch (error) {
      await winnerClient.query("ROLLBACK");
      throw error;
    } finally {
      winnerClient.release();
    }

    expect(
      (await pool.query("SELECT count(*)::integer AS count FROM workhorse.job")).rows[0]?.count,
    ).toBe(1);
  });

  it("releases only an ordinary scheduled task now and preserves recurring schedule state", async () => {
    await queue.syncSchedules("integration", [
      {
        name: "daily-report",
        schedule: "0 8 * * *",
        job: { type: "report", payload: { scope: "daily" } },
      },
    ]);
    const scheduleBefore = await pool.query(
      `SELECT namespace, schedule_name, cron_expression, revision, enabled, updated_at
         FROM workhorse.schedule_definition
        WHERE namespace = 'integration' AND schedule_name = 'daily-report'`,
    );
    const originalRunAt = new Date(Date.now() + 3_600_000);
    const jobId = await queue.enqueue(
      "manual-release",
      {},
      {
        queue: "manual-release",
        runAt: originalRunAt,
      },
    );
    const requestedAt = Date.now();

    await expect(queue.runTaskNow(jobId)).resolves.toMatchObject({
      status: "released",
      jobId,
      state: "ready",
      runAt: expect.any(Date),
    });
    const released = await queue.getJob(jobId);
    expect(released).toMatchObject({ state: "ready" });
    expect(released!.runAt.getTime()).toBeGreaterThanOrEqual(requestedAt);
    expect(released!.runAt.getTime()).toBeLessThan(originalRunAt.getTime());
    await expect(queue.runTaskNow(jobId)).resolves.toMatchObject({
      status: "already_ready",
      state: "ready",
      runAt: released!.runAt,
    });
    await expect(
      pool.query(
        `SELECT attempt, event_type, details FROM workhorse.job_event
          WHERE job_id = $1 AND event_type = 'promoted'`,
        [jobId],
      ),
    ).resolves.toMatchObject({
      rows: [{ attempt: 1, event_type: "promoted", details: { reason: "manual" } }],
    });
    await expect(
      pool.query(
        `SELECT namespace, schedule_name, cron_expression, revision, enabled, updated_at
           FROM workhorse.schedule_definition
          WHERE namespace = 'integration' AND schedule_name = 'daily-report'`,
      ),
    ).resolves.toEqual(scheduleBefore);

    const waitingId = await queue.enqueue("durable-wait", {}, { queue: "durable-wait" });
    const claimed = await queue.claim("wait-worker", { queue: "durable-wait" });
    expect(claimed?.id).toBe(waitingId);
    await queue.scheduleWait(claimed!, "wait-worker", "approval", {
      wakeAt: new Date(Date.now() + 3_600_000),
    });
    const waitingBefore = await queue.getJob(waitingId);
    await expect(queue.runTaskNow(waitingId)).resolves.toMatchObject({
      status: "waiting",
      jobId: waitingId,
      state: "scheduled",
      runAt: waitingBefore!.runAt,
    });
    await expect(queue.getJob(waitingId)).resolves.toMatchObject({
      state: "scheduled",
      runAt: waitingBefore!.runAt,
    });

    const terminalId = await queue.enqueue("terminal", {}, { queue: "run-now-terminal" });
    const terminalClaim = await queue.claim("terminal-worker", { queue: "run-now-terminal" });
    expect(terminalClaim?.id).toBe(terminalId);
    expect(await queue.complete(terminalClaim!, "terminal-worker", { ok: true })).toBe(true);
    await expect(queue.runTaskNow(terminalId)).resolves.toMatchObject({
      status: "not_scheduled",
      jobId: terminalId,
      state: "succeeded",
    });
    await expect(queue.runTaskNow("00000000-0000-4000-8000-000000000099")).resolves.toEqual({
      status: "not_found",
      jobId: "00000000-0000-4000-8000-000000000099",
      state: null,
      runAt: null,
    });
  });
});
