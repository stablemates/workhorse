import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { Queue, Worker, type Queryable } from "../src/index.js";
import { createIntegrationTestContext } from "./support/integration.js";
import { WORKHORSE_SCHEMA_VERSION } from "../src/index.js";

const { pool, queue, admin, adminAudit } = createIntegrationTestContext(import.meta.url);

interface CronOccurrenceFixture {
  id: string;
  expression: string;
  timezone: string;
  lastOccurrenceAt: string | null;
  now: string;
  limit: number;
  expected: string[];
}

const cronFixtures = JSON.parse(
  await readFile(new URL("../../../protocol/v1/cron-occurrences.json", import.meta.url), "utf8"),
) as CronOccurrenceFixture[];

class ScheduleEvaluationQueue extends Queue {
  constructor(
    database: Queryable,
    private readonly evaluationAt: Date,
    private readonly coordination: {
      before?: () => Promise<void>;
      after?: () => void;
    } = {},
  ) {
    super(database);
  }

  override async fireDueSchedules(
    namespaces: readonly string[],
    _now: Date | null,
    catchupLimit: number,
    evaluationWindowMs: number,
  ): Promise<void> {
    await this.coordination.before?.();
    try {
      await super.fireDueSchedules(namespaces, this.evaluationAt, catchupLimit, evaluationWindowMs);
    } finally {
      this.coordination.after?.();
    }
  }
}

function orderedScheduleEvaluationQueues(
  firstEvaluationAt: Date,
  secondEvaluationAt: Date,
): readonly [Queue, Queue] {
  let releaseSecondEvaluation!: () => void;
  const firstEvaluation = new Promise<void>((resolve) => {
    releaseSecondEvaluation = resolve;
  });
  return [
    new ScheduleEvaluationQueue(pool, firstEvaluationAt, { after: releaseSecondEvaluation }),
    new ScheduleEvaluationQueue(pool, secondEvaluationAt, { before: () => firstEvaluation }),
  ];
}

describe("cron schedules", () => {
  it.each(cronFixtures)("evaluates $id through PostgreSQL", async (fixture) => {
    const result = await pool.query<{ occurrence_at: Date }>(
      `SELECT occurrence_at
         FROM workhorse.cron_occurrences_v1(
           $1::text, $2::timestamptz, $3::timestamptz, $4::integer, $5::text
         ) occurrence_at`,
      [fixture.expression, fixture.lastOccurrenceAt, fixture.now, fixture.limit, fixture.timezone],
    );

    expect(result.rows.map((row) => row.occurrence_at.toISOString())).toEqual(
      fixture.expected.map((occurrence) => new Date(occurrence).toISOString()),
    );
  });

  it("cancels one recurring occurrence without disabling later occurrences", async () => {
    await queue.syncSchedules("cancel-recurring", [
      {
        name: "pulse",
        schedule: "* * * * *",
        task: { type: "recurring-cancel", payload: { value: 1 } },
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
    expect(await admin.getTask(secondId!)).toMatchObject({ state: "ready" });
    expect((await queue.schedules(["cancel-recurring"])).map((item) => item.name)).toEqual([
      "pulse",
    ]);
  });

  it("includes canceled tasks in health counts", async () => {
    const canceledId = await queue.enqueue("health-canceled", null);
    await queue.cancel(canceledId);
    await queue.enqueue("health-ready", null);
    const health = await queue.health();
    expect(health.schemaVersion).toBe(WORKHORSE_SCHEMA_VERSION);
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

  it("propagates concurrency keys from recurring schedules into fired tasks", async () => {
    const namespace = `keyed-schedule-${randomUUID()}`;
    await queue.syncSchedules(namespace, [
      {
        name: "keyed",
        schedule: "0 * * * *",
        task: {
          type: "scheduled-keyed",
          payload: { scheduled: true },
          concurrencyKey: "tenant-scheduled",
        },
      },
    ]);
    const stored = (await queue.schedules([namespace]))[0]!;
    const taskId = await queue.fireSchedule(
      namespace,
      stored.name,
      stored.revision,
      new Date("2026-08-11T03:00:00Z"),
    );
    await expect(admin.getTask(taskId!)).resolves.toMatchObject({
      concurrencyKey: "tenant-scheduled",
    });
  });

  it("synchronizes namespaced worker schedules and safely prunes removed definitions", async () => {
    await queue.syncSchedules("integration", [
      {
        name: "daily-report",
        schedule: "0 6 * * *",
        timezone: "America/New_York",
        task: {
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
        task: { type: "cleanup", payload: null },
      },
    ]);

    expect(
      (
        await pool.query(
          `SELECT schedule_name, cron_expression, timezone, queue_name, task_type, payload, max_attempts,
                  configured_enabled, paused, revision::text
             FROM workhorse.schedule_definition
            WHERE namespace = 'integration'
            ORDER BY schedule_name`,
        )
      ).rows,
    ).toEqual([
      {
        schedule_name: "daily-report",
        cron_expression: "0 6 * * *",
        timezone: "America/New_York",
        queue_name: "reports",
        task_type: "generate-report",
        payload: { scope: "daily" },
        max_attempts: 5,
        configured_enabled: true,
        paused: false,
        revision: "1",
      },
      {
        schedule_name: "disabled-cleanup",
        cron_expression: "0 2 * * 0",
        timezone: "UTC",
        queue_name: "default",
        task_type: "cleanup",
        payload: null,
        max_attempts: 25,
        configured_enabled: false,
        paused: false,
        revision: "1",
      },
    ]);

    await queue.syncSchedules("integration-other", [
      {
        name: "other-report",
        schedule: "0 8 * * *",
        task: { type: "other-report", payload: {} },
      },
    ]);
    await queue.syncSchedules("integration", [
      {
        name: "daily-report",
        schedule: "30 6 * * *",
        timezone: "America/New_York",
        task: { type: "generate-report", payload: { scope: "changed" }, queue: "reports" },
      },
    ]);

    expect(
      (
        await pool.query(
          "SELECT namespace, schedule_name, configured_enabled, paused, revision::text FROM workhorse.schedule_definition ORDER BY namespace, schedule_name",
        )
      ).rows,
    ).toEqual([
      {
        namespace: "integration",
        schedule_name: "daily-report",
        configured_enabled: true,
        paused: false,
        revision: "2",
      },
      {
        namespace: "integration",
        schedule_name: "disabled-cleanup",
        configured_enabled: false,
        paused: false,
        revision: "1",
      },
      {
        namespace: "integration-other",
        schedule_name: "other-report",
        configured_enabled: true,
        paused: false,
        revision: "1",
      },
    ]);
  });

  it("preserves an operator pause across deployment synchronization and re-addition", async () => {
    const definition = {
      name: "daily-report",
      schedule: "0 6 * * *",
      task: { type: "generate-report", payload: { scope: "daily" } },
    } as const;
    await queue.syncSchedules("durable-pause", [definition]);
    await pool.query(
      `UPDATE workhorse.schedule_definition
          SET paused = true, paused_by = 'operator', paused_reason = 'incident',
              paused_at = clock_timestamp(), revision = revision + 1
        WHERE namespace = 'durable-pause' AND schedule_name = 'daily-report'`,
    );

    await queue.syncSchedules("durable-pause", [definition]);
    await queue.syncSchedules("durable-pause", []);
    await queue.syncSchedules("durable-pause", [definition]);

    const stored = await pool.query<{
      configured_enabled: boolean;
      paused: boolean;
      paused_by: string;
      paused_reason: string;
    }>(
      `SELECT configured_enabled, paused, paused_by, paused_reason
         FROM workhorse.schedule_definition
        WHERE namespace = 'durable-pause' AND schedule_name = 'daily-report'`,
    );
    expect(stored.rows).toEqual([
      {
        configured_enabled: true,
        paused: true,
        paused_by: "operator",
        paused_reason: "incident",
      },
    ]);
    const schedule = (
      await pool.query<{ revision: string }>(
        `SELECT revision::text FROM workhorse.schedule_definition
          WHERE namespace = 'durable-pause' AND schedule_name = 'daily-report'`,
      )
    ).rows[0]!;
    await expect(
      queue.fireSchedule(
        "durable-pause",
        "daily-report",
        BigInt(schedule.revision),
        new Date("2026-08-11T06:00:00Z"),
      ),
    ).resolves.toBeNull();
  });

  it("rejects invalid cron expressions before persisting a schedule", async () => {
    await expect(
      queue.syncSchedules("integration", [
        {
          name: "invalid",
          schedule: "every sometime",
          task: { type: "invalid", payload: {} },
        },
      ]),
    ).rejects.toThrow(/invalid cron expression/);
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
            task: { type: "invalid-priority", payload: null, priority },
          },
        ]),
      ).rejects.toThrow("priority must be an integer between 0 and 100");
    },
  );

  it("lets workers coordinate recurring occurrences without duplicate tasks", async () => {
    await queue.syncSchedules("integration", [
      {
        name: "heartbeat",
        schedule: "* * * * * *",
        task: { type: "cron-tick", payload: { source: "worker" } },
      },
    ]);
    const occurrenceAt = new Date(Math.floor(Date.now() / 1_000) * 1_000);
    const [firstQueue, secondQueue] = orderedScheduleEvaluationQueues(occurrenceAt, occurrenceAt);
    const first = new Worker(firstQueue, {
      workerId: "scheduler-a",
      scheduleNamespaces: ["integration"],
    }).handle("cron-tick", () => ({ worker: "a" }));
    const second = new Worker(secondQueue, {
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
      (await pool.query("SELECT count(*)::integer AS count FROM workhorse.task")).rows[0]?.count,
    ).toBe(1);
  });

  it("skips missed occurrences by default and supports latest or all catch-up", async () => {
    await queue.syncSchedules("catchup-policies", [
      {
        name: "skip",
        schedule: "0 * * * * *",
        task: { type: "cron-skip", payload: null },
      },
      {
        name: "latest",
        schedule: "0 * * * * *",
        catchupPolicy: "latest",
        task: { type: "cron-latest", payload: null },
      },
      {
        name: "all",
        schedule: "0 * * * * *",
        catchupPolicy: "all",
        task: { type: "cron-all", payload: null },
      },
    ]);
    await pool.query(
      `UPDATE workhorse.schedule_definition
          SET last_evaluated_at = '2026-09-14T10:00:30Z'
        WHERE namespace = 'catchup-policies'`,
    );

    await queue.fireDueSchedules(["catchup-policies"], new Date("2026-09-14T10:05:30Z"), 2, 1_000);

    const occurrences = await pool.query<{ schedule_name: string; occurrence_at: Date }>(
      `SELECT schedule_name, occurrence_at
         FROM workhorse.schedule_occurrence
        WHERE namespace = 'catchup-policies'
        ORDER BY schedule_name, occurrence_at`,
    );
    expect(
      occurrences.rows.map((row) => [row.schedule_name, row.occurrence_at.toISOString()]),
    ).toEqual([
      ["all", "2026-09-14T10:01:00.000Z"],
      ["all", "2026-09-14T10:02:00.000Z"],
      ["latest", "2026-09-14T10:05:00.000Z"],
    ]);

    await queue.fireDueSchedules(["catchup-policies"], new Date("2026-09-14T10:05:30Z"), 2, 1_000);
    await queue.fireDueSchedules(["catchup-policies"], new Date("2026-09-14T10:05:30Z"), 2, 1_000);
    await queue.fireDueSchedules(
      ["catchup-policies"],
      new Date("2026-09-14T10:06:00.500Z"),
      2,
      1_000,
    );

    const caughtUp = await pool.query<{ schedule_name: string; count: number }>(
      `SELECT schedule_name, count(*)::integer AS count
         FROM workhorse.schedule_occurrence
        WHERE namespace = 'catchup-policies'
        GROUP BY schedule_name
        ORDER BY schedule_name`,
    );
    expect(caughtUp.rows).toEqual([
      { schedule_name: "all", count: 6 },
      { schedule_name: "latest", count: 2 },
      { schedule_name: "skip", count: 1 },
    ]);
  });

  it("advances a skip schedule when an operator resumes it", async () => {
    await queue.syncSchedules("resume-skip", [
      {
        name: "hourly",
        schedule: "0 0 * * * *",
        task: { type: "cron-resume", payload: null },
      },
    ]);
    await pool.query(
      `UPDATE workhorse.schedule_definition
          SET paused = true, paused_by = 'operator', paused_reason = 'maintenance',
              paused_at = '2026-09-14T08:00:00Z',
              last_evaluated_at = '2026-09-14T08:00:00Z'
        WHERE namespace = 'resume-skip' AND schedule_name = 'hourly'`,
    );
    await pool.query(
      `SELECT workhorse.set_schedule_paused_v1(
        'resume-skip', 'hourly', false, 'operator', 'resume', '2026-09-14T10:30:00Z'
      )`,
    );

    await queue.fireDueSchedules(["resume-skip"], new Date("2026-09-14T10:30:00Z"), 100, 1_000);
    expect(
      (
        await pool.query(
          "SELECT count(*)::integer AS count FROM workhorse.schedule_occurrence WHERE namespace = 'resume-skip'",
        )
      ).rows[0]?.count,
    ).toBe(0);
  });

  it("enqueues the occurrence a rolled-back manual fire held", async () => {
    await queue.syncSchedules("busy-occurrence", [
      {
        name: "minutely",
        schedule: "0 * * * * *",
        task: { type: "cron-busy", payload: null },
      },
    ]);
    await pool.query(
      `UPDATE workhorse.schedule_definition
          SET last_evaluated_at = '2026-09-14T10:00:30Z'
        WHERE namespace = 'busy-occurrence'`,
    );
    const [schedule] = await queue.schedules(["busy-occurrence"]);

    const holder = await pool.connect();
    try {
      await holder.query("BEGIN");
      const held = await holder.query<{ task_id: string | null }>(
        "SELECT workhorse.fire_schedule_v1($1::text, $2::text, $3::bigint, $4::timestamptz) AS task_id",
        ["busy-occurrence", schedule!.name, schedule!.revision.toString(), "2026-09-14T10:01:00Z"],
      );
      expect(held.rows[0]?.task_id).not.toBeNull();

      // The manual fire abandons the occurrence while the tick evaluates it, which is the shape
      // that lost it: the tick saw a null task id and moved the position past the occurrence.
      const tick = queue.fireDueSchedules(
        ["busy-occurrence"],
        new Date("2026-09-14T10:01:30Z"),
        100,
        120_000,
      );
      await sleep(200);
      await holder.query("ROLLBACK");
      await tick;
    } finally {
      holder.release();
    }

    expect(
      (
        await pool.query<{ last_evaluated_at: Date }>(
          `SELECT last_evaluated_at FROM workhorse.schedule_definition
            WHERE namespace = 'busy-occurrence'`,
        )
      ).rows[0]?.last_evaluated_at.toISOString(),
    ).toBe("2026-09-14T10:00:30.000Z");

    expect(
      (
        await pool.query<{ count: number }>(
          `SELECT count(*)::integer AS count FROM workhorse.schedule_occurrence
            WHERE namespace = 'busy-occurrence'`,
        )
      ).rows[0]?.count,
    ).toBe(0);

    await queue.fireDueSchedules(
      ["busy-occurrence"],
      new Date("2026-09-14T10:01:30Z"),
      100,
      120_000,
    );

    const recovered = await pool.query<{ occurrence_at: Date; task_id: string | null }>(
      `SELECT occurrence_at, task_id FROM workhorse.schedule_occurrence
        WHERE namespace = 'busy-occurrence'`,
    );
    expect(recovered.rows.map((row) => row.occurrence_at.toISOString())).toEqual([
      "2026-09-14T10:01:00.000Z",
    ]);
    expect(recovered.rows[0]?.task_id).not.toBeNull();
    expect(await admin.getTask(recovered.rows[0]!.task_id!)).toMatchObject({ state: "ready" });
  });

  it("evaluates on the database clock when the caller supplies no instant", async () => {
    await queue.syncSchedules("database-clock", [
      {
        name: "secondly",
        schedule: "* * * * * *",
        task: { type: "cron-database-clock", payload: null },
      },
    ]);
    await pool.query(
      `UPDATE workhorse.schedule_definition
          SET last_evaluated_at = clock_timestamp() - interval '10 seconds'
        WHERE namespace = 'database-clock'`,
    );

    await queue.fireDueSchedules(["database-clock"], null, 100, 60_000);

    const fired = await pool.query<{ count: number; latest: Date }>(
      `SELECT count(*)::integer AS count, max(occurrence_at) AS latest
         FROM workhorse.schedule_occurrence
        WHERE namespace = 'database-clock'`,
    );
    expect(fired.rows[0]!.count).toBeGreaterThan(0);
    expect(fired.rows[0]!.latest.getTime()).toBeGreaterThan(Date.now() - 60_000);

    const position = await pool.query<{ advanced: boolean }>(
      `SELECT last_evaluated_at > clock_timestamp() - interval '10 seconds' AS advanced
         FROM workhorse.schedule_definition
        WHERE namespace = 'database-clock'`,
    );
    expect(position.rows[0]?.advanced).toBe(true);
  });

  it("treats adjacent recurring occurrences as distinct coordinated work", async () => {
    await queue.syncSchedules("adjacent", [
      {
        name: "heartbeat",
        schedule: "* * * * * *",
        task: { type: "cron-adjacent", payload: null },
      },
    ]);
    const firstOccurrenceAt = new Date(Math.floor(Date.now() / 1_000) * 1_000);
    const secondOccurrenceAt = new Date(firstOccurrenceAt.getTime() + 1_000);
    const [firstQueue, secondQueue] = orderedScheduleEvaluationQueues(
      firstOccurrenceAt,
      secondOccurrenceAt,
    );
    const first = new Worker(firstQueue, {
      workerId: "scheduler-a",
      scheduleNamespaces: ["adjacent"],
    }).handle("cron-adjacent", () => ({ worker: "a" }));
    const second = new Worker(secondQueue, {
      workerId: "scheduler-b",
      scheduleNamespaces: ["adjacent"],
    }).handle("cron-adjacent", () => ({ worker: "b" }));

    expect(await Promise.all([first.runOnce(), second.runOnce()])).toEqual([true, true]);
    const occurrences = await pool.query<{ occurrence_at: Date }>(
      `SELECT occurrence_at
         FROM workhorse.schedule_occurrence
        WHERE namespace = 'adjacent' AND schedule_name = 'heartbeat'
        ORDER BY occurrence_at`,
    );
    expect(occurrences.rows.map((row) => row.occurrence_at.toISOString())).toEqual([
      firstOccurrenceAt.toISOString(),
      secondOccurrenceAt.toISOString(),
    ]);
    expect(
      (await pool.query("SELECT count(*)::integer AS count FROM workhorse.task")).rows[0]?.count,
    ).toBe(2);
  });

  it("lets different schedule namespaces progress on the same cadence", async () => {
    await queue.syncSchedules("integration-a", [
      {
        name: "heartbeat-a",
        schedule: "* * * * * *",
        task: { type: "cron-a", payload: null, queue: "schedule-a" },
      },
    ]);
    await queue.syncSchedules("integration-b", [
      {
        name: "heartbeat-b",
        schedule: "* * * * * *",
        task: { type: "cron-b", payload: null, queue: "schedule-b" },
      },
    ]);
    const first = new Worker(queue, {
      workerId: "scheduler-namespace-a",
      queue: "schedule-a",
      scheduleNamespaces: ["integration-a"],
    }).handle("cron-a", () => null);
    const second = new Worker(queue, {
      workerId: "scheduler-namespace-b",
      queue: "schedule-b",
      scheduleNamespaces: ["integration-b"],
    }).handle("cron-b", () => null);

    expect(await Promise.all([first.runOnce(), second.runOnce()])).toEqual([true, true]);
    expect(
      (
        await pool.query<{ namespace: string }>(
          "SELECT namespace FROM workhorse.schedule_occurrence ORDER BY namespace",
        )
      ).rows,
    ).toEqual([{ namespace: "integration-a" }, { namespace: "integration-b" }]);
  });

  it("uses the cross-runtime offset for hashed cron fields", async () => {
    await queue.syncSchedules("integration", [
      {
        name: "hashed-minute",
        schedule: "H * * * *",
        catchupPolicy: "latest",
        task: { type: "cron-tick", payload: {} },
      },
    ]);
    await pool.query(
      "UPDATE workhorse.schedule_definition SET last_evaluated_at = clock_timestamp() - interval '2 hours' WHERE namespace = 'integration'",
    );
    const worker = new Worker(queue, {
      workerId: "hashed-schedule-worker",
      scheduleNamespaces: ["integration"],
    }).handle("cron-tick", () => null);

    await worker.runOnce();

    const occurrence = await pool.query<{ minute: number }>(
      `SELECT extract(minute FROM occurrence_at)::integer AS minute
         FROM workhorse.schedule_occurrence
        WHERE namespace = 'integration' AND schedule_name = 'hashed-minute'`,
    );
    expect(occurrence.rows).toEqual([{ minute: 44 }]);
  });

  it("rejects stale schedule revisions after a definition changes", async () => {
    await queue.syncSchedules("integration", [
      {
        name: "revision-fence",
        schedule: "0 * * * *",
        task: { type: "old", payload: { revision: 1 } },
      },
    ]);
    const [oldDefinition] = await queue.schedules(["integration"]);
    await queue.syncSchedules("integration", [
      {
        name: "revision-fence",
        schedule: "30 * * * *",
        task: { type: "new", payload: { revision: 2 } },
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
      (await pool.query("SELECT count(*)::integer AS count FROM workhorse.task")).rows[0]?.count,
    ).toBe(0);
  });

  it("deduplicates concurrent calls at the schedule occurrence boundary", async () => {
    await queue.syncSchedules("integration", [
      {
        name: "hourly-rollup",
        schedule: "0 * * * *",
        task: { type: "rollup", payload: { scope: "hourly" } },
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
      (await pool.query("SELECT count(*)::integer AS count FROM workhorse.task")).rows[0]?.count,
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
        task: { type: "rollup", payload: { scope: "hourly" } },
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
      (await pool.query("SELECT count(*)::integer AS count FROM workhorse.task")).rows[0]?.count,
    ).toBe(1);
  });

  it("returns null when a schedule occurrence is replayed before its first fire commits", async () => {
    await queue.syncSchedules("integration", [
      {
        name: "overlapping-hourly-rollup",
        schedule: "0 * * * *",
        task: { type: "rollup", payload: { scope: "hourly" } },
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
      (await pool.query("SELECT count(*)::integer AS count FROM workhorse.task")).rows[0]?.count,
    ).toBe(1);
  });

  it("releases only an ordinary scheduled task now and preserves recurring schedule state", async () => {
    await queue.syncSchedules("integration", [
      {
        name: "daily-report",
        schedule: "0 8 * * *",
        task: { type: "report", payload: { scope: "daily" } },
      },
    ]);
    const scheduleBefore = await pool.query(
      `SELECT namespace, schedule_name, cron_expression, revision, configured_enabled, paused, updated_at
         FROM workhorse.schedule_definition
        WHERE namespace = 'integration' AND schedule_name = 'daily-report'`,
    );
    const originalRunAt = new Date(Date.now() + 3_600_000);
    const taskId = await queue.enqueue(
      "manual-release",
      {},
      {
        queue: "manual-release",
        runAt: originalRunAt,
      },
    );
    const requestedAt = Date.now();

    const runNowAudit = adminAudit("run scheduled task");
    await expect(admin.runTaskNow(taskId, runNowAudit)).resolves.toMatchObject({
      status: "released",
      taskId,
      state: "ready",
      runAt: expect.any(Date),
    });
    const released = await admin.getTask(taskId);
    expect(released).toMatchObject({ state: "ready" });
    expect(released!.runAt.getTime()).toBeGreaterThanOrEqual(requestedAt);
    expect(released!.runAt.getTime()).toBeLessThan(originalRunAt.getTime());
    await expect(
      admin.runTaskNow(taskId, adminAudit("repeat immediate run")),
    ).resolves.toMatchObject({
      status: "already_ready",
      state: "ready",
      runAt: released!.runAt,
    });
    await expect(
      pool.query(
        `SELECT attempt, event_type, details FROM workhorse.task_event
          WHERE task_id = $1 AND event_type = 'promoted'`,
        [taskId],
      ),
    ).resolves.toMatchObject({
      rows: [
        {
          attempt: 1,
          event_type: "promoted",
          details: expect.objectContaining({
            reason: "manual",
            requested_by: runNowAudit.actor,
            request_reason: runNowAudit.reason,
            request_id_digest: expect.stringMatching(/^[0-9a-f]{12}$/),
          }),
        },
      ],
    });
    await expect(
      pool.query(
        `SELECT namespace, schedule_name, cron_expression, revision, configured_enabled, paused, updated_at
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
    const waitingBefore = await admin.getTask(waitingId);
    await expect(
      admin.runTaskNow(waitingId, adminAudit("reject waiting task")),
    ).resolves.toMatchObject({
      status: "waiting",
      taskId: waitingId,
      state: "scheduled",
      runAt: waitingBefore!.runAt,
    });
    await expect(admin.getTask(waitingId)).resolves.toMatchObject({
      state: "scheduled",
      runAt: waitingBefore!.runAt,
    });

    const terminalId = await queue.enqueue("terminal", {}, { queue: "run-now-terminal" });
    const terminalClaim = await queue.claim("terminal-worker", { queue: "run-now-terminal" });
    expect(terminalClaim?.id).toBe(terminalId);
    expect(await queue.complete(terminalClaim!, "terminal-worker", { ok: true })).toBe(true);
    await expect(
      admin.runTaskNow(terminalId, adminAudit("reject terminal task")),
    ).resolves.toMatchObject({
      status: "not_scheduled",
      taskId: terminalId,
      state: "succeeded",
    });
    await expect(
      admin.runTaskNow("00000000-0000-4000-8000-000000000099", adminAudit("run missing task")),
    ).resolves.toEqual({
      status: "not_found",
      taskId: "00000000-0000-4000-8000-000000000099",
      state: null,
      runAt: null,
    });
  });
});
