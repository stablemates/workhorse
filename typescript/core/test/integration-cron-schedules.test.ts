import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { Queue, Worker, type Queryable, type ScheduleDefinition } from "../src/index.js";
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

interface OccurrencePlanNode {
  "Node Type"?: string;
  "Relation Name"?: string;
  "Index Name"?: string;
  "Index Cond"?: string;
  "Actual Rows"?: number;
  "Actual Loops"?: number;
  "Rows Removed by Filter"?: number;
  "Shared Hit Blocks"?: number;
  "Shared Read Blocks"?: number;
  Plans?: OccurrencePlanNode[];
}

// Each plan node that reads schedule_occurrence through its table or one of its indexes.
function occurrencePlanReads(node: OccurrencePlanNode): OccurrencePlanNode[] {
  const reads =
    node["Relation Name"] === "schedule_occurrence" ||
    node["Index Name"]?.startsWith("schedule_occurrence_") === true
      ? [node]
      : [];
  return [...reads, ...(node.Plans ?? []).flatMap(occurrencePlanReads)];
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

// The sync sets the durable position of a new definition to 1 microsecond before the start of the
// current second. A pass at the next whole second fires exactly one occurrence of an every-second
// schedule. Second boundaries during the test do not change that result.
async function firstOccurrenceAfterSync(namespace: string): Promise<Date> {
  const position = await pool.query<{ occurrence_at: Date }>(
    `SELECT DISTINCT date_trunc('second', last_evaluated_at) + interval '1 second' AS occurrence_at
       FROM workhorse.schedule_definition
      WHERE namespace = $1`,
    [namespace],
  );
  expect(position.rows).toHaveLength(1);
  return position.rows[0]!.occurrence_at;
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

function keyedFastSchedule(enabled: boolean): ScheduleDefinition[] {
  return [
    {
      name: "keyed",
      schedule: "* * * * * *",
      enabled,
      task: { type: "t.keyed", payload: {}, queue: "fast-keyed", concurrencyKey: "k" },
    },
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

  it("resolves only the wall-clock times near a dense evaluation window", async () => {
    const notices: string[] = [];
    const client = await pool.connect();
    client.on("notice", (notice) => notices.push(notice.message ?? ""));
    const evaluate = async (
      lastOccurrenceAt: string | null,
      now: string,
      limit: number,
      timezone: string,
    ): Promise<{ occurrences: number; resolved: number }> => {
      notices.length = 0;
      const result = await client.query(
        `SELECT occurrence_at
           FROM workhorse.cron_occurrences_v1(
             '* * * * * *', $1::timestamptz, $2::timestamptz, $3::integer, $4::text
           )`,
        [lastOccurrenceAt, now, limit, timezone],
      );
      const counts = notices.flatMap((message) => {
        const match = /^cron_occurrences_v1 resolved (\d+) wall-clock times$/.exec(message);
        return match ? [Number(match[1])] : [];
      });
      expect(counts).toHaveLength(1);
      return { occurrences: result.rowCount ?? 0, resolved: counts[0]! };
    };
    try {
      await client.query("SET client_min_messages = debug1");
      // A day has 86,400 wall-clock seconds. Each window resolves only the seconds that can fall
      // inside it.
      await expect(
        evaluate("2026-01-01T12:00:00Z", "2026-01-01T12:00:05.500Z", 10, "UTC"),
      ).resolves.toEqual({ occurrences: 5, resolved: 6 });
      await expect(evaluate(null, "2026-01-01T12:00:05.500Z", 1, "UTC")).resolves.toEqual({
        occurrences: 1,
        resolved: 1,
      });
      // The window crosses the spring gap, so it also resolves the 3,600 seconds of the skipped
      // hour. They normalize into the hour after the gap.
      await expect(
        evaluate("2026-03-08T06:59:58Z", "2026-03-08T07:00:02Z", 10, "America/New_York"),
      ).resolves.toEqual({ occurrences: 4, resolved: 3605 });
      // A catch-up at the limit stops after the limit and the position it starts from.
      await expect(
        evaluate("2025-01-01T00:00:00Z", "2026-01-01T12:00:00Z", 10_000, "UTC"),
      ).resolves.toEqual({ occurrences: 10_000, resolved: 10_001 });
    } finally {
      await client.query("RESET client_min_messages");
      client.release();
    }
  });

  it("returns no occurrence for a position at the end of the timestamp range", async () => {
    // The offset probes near the position must stay inside the timestamp and interval ranges.
    for (const now of ["1800-01-01T00:00:00Z", "2026-01-01T00:00:00Z"]) {
      const result = await pool.query(
        `SELECT occurrence_at
           FROM workhorse.cron_occurrences_v1(
             '0 0 * * *', '294276-12-31 20:00:00+00'::timestamptz, $1::timestamptz, 10, 'UTC'
           )`,
        [now],
      );
      expect(result.rows).toEqual([]);
    }
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
    const occurrenceAt = await firstOccurrenceAfterSync("integration");
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
      ["skip", "2026-09-14T10:05:00.000Z"],
    ]);
    // The supported delay is 60 seconds here, so `skip` fires only 10:05 and records the four
    // older occurrences it skipped.
    expect(
      (
        await pool.query<{
          last_skipped_at: Date | null;
          last_skipped_count: number | null;
          last_skipped_through: Date | null;
        }>(
          `SELECT schedule_name, last_skipped_at, last_skipped_count, last_skipped_through
             FROM workhorse.schedule_definition
            WHERE namespace = 'catchup-policies'
            ORDER BY schedule_name`,
        )
      ).rows.map((row) => [
        row.last_skipped_at?.toISOString() ?? null,
        row.last_skipped_count,
        row.last_skipped_through?.toISOString() ?? null,
      ]),
    ).toEqual([
      [null, null, null],
      [null, null, null],
      ["2026-09-14T10:05:30.000Z", 4, "2026-09-14T10:04:00.000Z"],
    ]);
    // The dashboard Schedules page reads the same skip record through dashboard_cron_v1.
    const cron = await pool.query<{
      document: {
        schedules: {
          namespace: string;
          name: string;
          lastSkippedAt: string | null;
          lastSkippedCount: number | null;
          lastSkippedThrough: string | null;
        }[];
      };
    }>("SELECT workhorse.dashboard_cron_v1('{}'::jsonb) AS document");
    expect(
      cron.rows[0]!.document.schedules.filter(
        (schedule) => schedule.namespace === "catchup-policies",
      ).map((schedule) => [
        schedule.name,
        schedule.lastSkippedAt,
        schedule.lastSkippedCount,
        schedule.lastSkippedThrough,
      ]),
    ).toEqual([
      ["all", null, null, null],
      ["latest", null, null, null],
      ["skip", "2026-09-14T10:05:30.000Z", 4, "2026-09-14T10:04:00.000Z"],
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
      { schedule_name: "skip", count: 2 },
    ]);
  });

  it("fires every skip occurrence when a slow maintenance phase delays the next pass", async () => {
    const namespace = `slow-maintenance-${randomUUID()}`;
    await queue.syncSchedules(namespace, [
      {
        name: "secondly",
        schedule: "* * * * * *",
        task: { type: "cron-slow-maintenance", payload: null, queue: namespace },
      },
    ]);
    class SlowMaintenanceQueue extends Queue {
      passes = 0;

      override async runMaintenance(options: { now?: Date } = {}) {
        const results = await super.runMaintenance(options);
        await sleep(1_500);
        this.passes += 1;
        return results;
      }
    }
    const slowQueue = new SlowMaintenanceQueue(pool);
    // Each schedule pass starts at least 1.5 seconds after the previous one, which is far more
    // than the 200 millisecond maintenance interval but inside the supported delay.
    const worker = new Worker(slowQueue, {
      workerId: `slow-maintenance-${randomUUID()}`,
      scheduleNamespaces: [namespace],
      maintenanceIntervalMs: 200,
      maintenanceRoutinePollMs: 200,
    }).handle("cron-slow-maintenance", () => null);
    const running = worker.run();
    try {
      while (slowQueue.passes < 3) await sleep(50);
    } finally {
      worker.stop();
      await running;
    }

    const fired = await pool.query<{ occurrence_at: Date }>(
      `SELECT occurrence_at FROM workhorse.schedule_occurrence
        WHERE namespace = $1 ORDER BY occurrence_at`,
      [namespace],
    );
    const instants = fired.rows.map((row) => row.occurrence_at.getTime());
    expect(instants.length).toBeGreaterThanOrEqual(4);
    expect(instants.slice(1).map((instant, index) => instant - instants[index]!)).toEqual(
      instants.slice(1).map(() => 1_000),
    );
    expect(
      (
        await pool.query<{ last_skipped_at: Date | null }>(
          "SELECT last_skipped_at FROM workhorse.schedule_definition WHERE namespace = $1",
          [namespace],
        )
      ).rows[0]?.last_skipped_at,
    ).toBeNull();
  });

  it("records at most 10,000 skipped occurrences and the newest one after an outage", async () => {
    const namespace = `skip-outage-${randomUUID()}`;
    await queue.syncSchedules(namespace, [
      {
        name: "secondly",
        schedule: "* * * * * *",
        task: { type: "cron-skip-outage", payload: null, queue: namespace },
      },
    ]);
    await pool.query(
      `UPDATE workhorse.schedule_definition SET last_evaluated_at = '2026-09-14T06:00:00Z'
        WHERE namespace = $1`,
      [namespace],
    );

    await queue.fireDueSchedules([namespace], new Date("2026-09-14T10:00:00.500Z"), 100, 1_000);

    const fired = await pool.query<{ count: number; first: Date; last: Date }>(
      `SELECT count(*)::integer AS count, min(occurrence_at) AS first, max(occurrence_at) AS last
         FROM workhorse.schedule_occurrence WHERE namespace = $1`,
      [namespace],
    );
    expect(fired.rows[0]).toEqual({
      count: 60,
      first: new Date("2026-09-14T09:59:01Z"),
      last: new Date("2026-09-14T10:00:00Z"),
    });
    // The outage holds 14,340 older occurrences. The record caps the count and still names the
    // newest skipped occurrence.
    const record = await pool.query(
      `SELECT last_skipped_at, last_skipped_count, last_skipped_through, last_evaluated_at
         FROM workhorse.schedule_definition WHERE namespace = $1`,
      [namespace],
    );
    expect(record.rows[0]).toEqual({
      last_skipped_at: new Date("2026-09-14T10:00:00.500Z"),
      last_skipped_count: 10_000,
      last_skipped_through: new Date("2026-09-14T09:59:00Z"),
      last_evaluated_at: new Date("2026-09-14T10:00:00.500Z"),
    });
  });

  it("uses two evaluation windows as the supported delay for a long maintenance interval", async () => {
    const namespace = `skip-long-interval-${randomUUID()}`;
    await queue.syncSchedules(namespace, [
      {
        name: "secondly",
        schedule: "* * * * * *",
        task: { type: "cron-skip-long-interval", payload: null, queue: namespace },
      },
    ]);
    await pool.query(
      `UPDATE workhorse.schedule_definition SET last_evaluated_at = '2026-09-14T10:00:00Z'
        WHERE namespace = $1`,
      [namespace],
    );

    // A 60-second window gives a 120-second supported delay, so all 90 due occurrences fire.
    await queue.fireDueSchedules([namespace], new Date("2026-09-14T10:01:30.500Z"), 100, 60_000);

    const fired = await pool.query<{ count: number; first: Date }>(
      `SELECT count(*)::integer AS count, min(occurrence_at) AS first
         FROM workhorse.schedule_occurrence WHERE namespace = $1`,
      [namespace],
    );
    expect(fired.rows[0]).toEqual({ count: 90, first: new Date("2026-09-14T10:00:01Z") });
    expect(
      (
        await pool.query<{ last_skipped_at: Date | null }>(
          "SELECT last_skipped_at FROM workhorse.schedule_definition WHERE namespace = $1",
          [namespace],
        )
      ).rows[0]?.last_skipped_at,
    ).toBeNull();
  });

  it("continues a skip schedule that reaches the catch-up limit on the next pass", async () => {
    const namespace = `skip-limit-${randomUUID()}`;
    await queue.syncSchedules(namespace, [
      {
        name: "secondly",
        schedule: "* * * * * *",
        task: { type: "cron-skip-limit", payload: null, queue: namespace },
      },
    ]);
    await pool.query(
      `UPDATE workhorse.schedule_definition SET last_evaluated_at = '2026-09-14T10:00:00Z'
        WHERE namespace = $1`,
      [namespace],
    );
    const now = new Date("2026-09-14T10:00:25.500Z");

    // 25 occurrences are due inside the supported delay. Each pass fires at most 10 of them.
    for (const expected of [10, 20, 25]) {
      await queue.fireDueSchedules([namespace], now, 10, 1_000);
      expect(
        (
          await pool.query<{ count: number }>(
            "SELECT count(*)::integer AS count FROM workhorse.schedule_occurrence WHERE namespace = $1",
            [namespace],
          )
        ).rows[0]?.count,
      ).toBe(expected);
    }
    const record = await pool.query(
      `SELECT last_skipped_at, last_evaluated_at FROM workhorse.schedule_definition
        WHERE namespace = $1`,
      [namespace],
    );
    expect(record.rows[0]).toEqual({ last_skipped_at: null, last_evaluated_at: now });
  });

  it("reads no occurrence history of a namespace that another pass holds", async () => {
    const namespace = `busy-namespace-${randomUUID()}`;
    await queue.syncSchedules(namespace, [
      {
        name: "minutely",
        schedule: "0 * * * * *",
        task: { type: "cron-busy-namespace", payload: null, queue: namespace },
      },
    ]);
    // 500 retained occurrences, all older than the durable position.
    await pool.query(
      `INSERT INTO workhorse.schedule_occurrence (namespace, schedule_name, occurrence_at)
       SELECT $1, 'minutely', '2026-09-13T00:00:00Z'::timestamptz + make_interval(mins => step)
         FROM generate_series(1, 500) step`,
      [namespace],
    );
    await pool.query(
      `UPDATE workhorse.schedule_definition SET last_evaluated_at = '2026-09-14T10:00:30Z'
        WHERE namespace = $1`,
      [namespace],
    );
    const occurrenceReads = async (): Promise<{ scans: number; rows: number }> => {
      const client = await pool.connect();
      try {
        // The counters also hold unflushed reads of earlier work on this connection, so the
        // check compares them before and after the pass.
        const counters = async (): Promise<{ scans: number; rows: number }> => {
          const stats = await client.query<{ scans: string; rows: string }>(
            `SELECT seq_scan + COALESCE(idx_scan, 0) AS scans,
                    seq_tup_read + COALESCE(idx_tup_fetch, 0) AS rows
               FROM pg_stat_xact_user_tables
              WHERE schemaname = 'workhorse' AND relname = 'schedule_occurrence'`,
          );
          return { scans: Number(stats.rows[0]!.scans), rows: Number(stats.rows[0]!.rows) };
        };
        await client.query("BEGIN");
        const before = await counters();
        await client.query(
          `SELECT * FROM workhorse.fire_due_schedules_v2(
             ARRAY[$1::text], '2026-09-14T10:00:40Z', 100, 1000
           )`,
          [namespace],
        );
        const after = await counters();
        await client.query("ROLLBACK");
        return { scans: after.scans - before.scans, rows: after.rows - before.rows };
      } finally {
        client.release();
      }
    };

    // The owned namespace reads one occurrence row for its one definition.
    await expect(occurrenceReads()).resolves.toEqual({ scans: 1, rows: 1 });

    const holder = await pool.connect();
    try {
      await holder.query(
        "SELECT pg_advisory_lock(hashtextextended('workhorse:schedule-namespace:' || $1, 0))",
        [namespace],
      );
      await expect(occurrenceReads()).resolves.toEqual({ scans: 0, rows: 0 });
    } finally {
      await holder.query("SELECT pg_advisory_unlock_all()");
      holder.release();
    }
  });

  // The occurrence calculator has its own daylight-saving cases. This covers the firing path,
  // which reads the calculator and then writes occurrences and tasks: a daily local time fires
  // once per local day across both transitions, so neither the skipped hour nor the repeated one
  // drops a day or fires one twice.
  it.each([
    {
      transition: "spring forward",
      schedule: "30 2 * * *",
      lastEvaluatedAt: "2026-03-06T12:00:00Z",
      now: "2026-03-10T12:00:00Z",
      expected: [
        "2026-03-07T07:30:00.000Z",
        "2026-03-08T07:30:00.000Z",
        "2026-03-09T06:30:00.000Z",
        "2026-03-10T06:30:00.000Z",
      ],
    },
    {
      transition: "fall back",
      schedule: "30 1 * * *",
      lastEvaluatedAt: "2026-10-30T12:00:00Z",
      now: "2026-11-03T12:00:00Z",
      expected: [
        "2026-10-31T05:30:00.000Z",
        "2026-11-01T05:30:00.000Z",
        "2026-11-02T06:30:00.000Z",
        "2026-11-03T06:30:00.000Z",
      ],
    },
  ])("fires one daily occurrence per local day across a $transition", async (transition) => {
    const namespace = `dst-${randomUUID()}`;
    await queue.syncSchedules(namespace, [
      {
        name: "nightly",
        schedule: transition.schedule,
        timezone: "America/New_York",
        catchupPolicy: "all",
        task: { type: "cron-dst", payload: null, queue: namespace },
      },
    ]);
    await pool.query(
      `UPDATE workhorse.schedule_definition SET last_evaluated_at = $2::timestamptz
        WHERE namespace = $1`,
      [namespace, transition.lastEvaluatedAt],
    );

    await queue.fireDueSchedules([namespace], new Date(transition.now), 100, 1_000);

    // Each occurrence carries the task it enqueued, so a transition can neither drop a day's work
    // nor enqueue one day twice.
    const occurrences = await pool.query<{ occurrence_at: Date; task_id: string }>(
      `SELECT occurrence.occurrence_at, occurrence.task_id
         FROM workhorse.schedule_occurrence occurrence
         JOIN workhorse.task_runtime runtime ON runtime.task_id = occurrence.task_id
        WHERE occurrence.namespace = $1
        ORDER BY occurrence.occurrence_at`,
      [namespace],
    );
    expect(occurrences.rows.map((row) => row.occurrence_at.toISOString())).toEqual(
      transition.expected,
    );
    expect(new Set(occurrences.rows.map((row) => row.task_id)).size).toBe(
      transition.expected.length,
    );
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
    const firstOccurrenceAt = await firstOccurrenceAfterSync("adjacent");
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
    // Each pass evaluates at the first second after its own namespace position, so a second
    // boundary during the test cannot add an occurrence.
    const occurrenceA = await firstOccurrenceAfterSync("integration-a");
    const occurrenceB = await firstOccurrenceAfterSync("integration-b");
    const first = new Worker(new ScheduleEvaluationQueue(pool, occurrenceA), {
      workerId: "scheduler-namespace-a",
      queue: "schedule-a",
      scheduleNamespaces: ["integration-a"],
    }).handle("cron-a", () => null);
    const second = new Worker(new ScheduleEvaluationQueue(pool, occurrenceB), {
      workerId: "scheduler-namespace-b",
      queue: "schedule-b",
      scheduleNamespaces: ["integration-b"],
    }).handle("cron-b", () => null);

    expect(await Promise.all([first.runOnce(), second.runOnce()])).toEqual([true, true]);
    expect(
      (
        await pool.query<{ namespace: string; occurrence_at: Date }>(
          "SELECT namespace, occurrence_at FROM workhorse.schedule_occurrence ORDER BY namespace",
        )
      ).rows,
    ).toEqual([
      { namespace: "integration-a", occurrence_at: occurrenceA },
      { namespace: "integration-b", occurrence_at: occurrenceB },
    ]);
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

  it("reads a bounded occurrence count and one last fire for each dashboard schedule", async () => {
    const occurrenceCap = 1_000;
    const namespace = "dashboard-occurrences";
    await queue.syncSchedules(namespace, [
      { name: "busy", schedule: "* * * * * *", task: { type: "dashboard.busy", payload: null } },
      { name: "quiet", schedule: "0 * * * *", task: { type: "dashboard.quiet", payload: null } },
      // A schedule with no occurrence sorts after the busy one. A backward scan that the
      // schedule_name key cannot stop would read the rows of busy and quiet for it.
      { name: "zero", schedule: "0 0 1 1 *", task: { type: "dashboard.zero", payload: null } },
    ]);
    // A six-field cron writes one occurrence each second, so 20,000 rows are about 5.5 hours.
    await pool.query(
      `INSERT INTO workhorse.schedule_occurrence(namespace, schedule_name, occurrence_at, fired_at)
       SELECT $1, 'busy', at, at + interval '10 milliseconds'
         FROM generate_series(
           timestamptz '2026-10-01T00:00:00Z', timestamptz '2026-10-01T00:00:00Z' + interval '19999 seconds',
           interval '1 second'
         ) AS series(at)
       UNION ALL
       SELECT $1, 'quiet', at, at + interval '10 milliseconds'
         FROM unnest(ARRAY[timestamptz '2026-10-01T00:00:00Z', timestamptz '2026-10-01T01:00:00Z'])
           AS fired(at)`,
      [namespace],
    );
    await pool.query("ANALYZE workhorse.schedule_occurrence");
    const lastFired = await pool.query<{ schedule_name: string; last_fired_at: Date }>(
      `SELECT schedule_name, max(fired_at) AS last_fired_at FROM workhorse.schedule_occurrence
        WHERE namespace = $1 GROUP BY schedule_name ORDER BY schedule_name`,
      [namespace],
    );

    const document = await pool.query<{
      document: {
        schedules: {
          namespace: string;
          name: string;
          occurrenceCount: number;
          occurrenceCountCapped?: boolean;
          lastFiredAt: string | null;
        }[];
      };
    }>("SELECT workhorse.dashboard_cron_v1('{}'::jsonb) AS document");
    expect(
      document.rows[0]!.document.schedules.map((schedule) => [
        schedule.name,
        schedule.occurrenceCount,
        schedule.occurrenceCountCapped,
        schedule.lastFiredAt,
      ]),
    ).toEqual([
      ["busy", occurrenceCap, true, lastFired.rows[0]!.last_fired_at.toISOString()],
      ["quiet", 2, false, lastFired.rows[1]!.last_fired_at.toISOString()],
      ["zero", 0, false, null],
    ]);

    // The function body is one SQL statement, and EXPLAIN of the call shows only its result node.
    // Plan the installed body under the settings of the function, so the plan is its plan.
    const cron = (
      await pool.query<{ source: string; settings: string[] | null }>(
        `SELECT prosrc AS source, proconfig AS settings FROM pg_proc
          WHERE oid = 'workhorse.dashboard_cron_v1(jsonb)'::regprocedure`,
      )
    ).rows[0]!;
    expect(cron.settings).toEqual(["jit=off", "enable_seqscan=off", "enable_bitmapscan=off"]);
    const client = await pool.connect();
    let plan: OccurrencePlanNode;
    try {
      await client.query("BEGIN");
      for (const setting of cron.settings!) {
        const [name, value] = setting.split("=");
        await client.query("SELECT set_config($1, $2, true)", [name, value]);
      }
      const explained = await client.query<{ "QUERY PLAN": Array<{ Plan: OccurrencePlanNode }> }>(
        `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${cron.source.replaceAll("p_input", "$1::jsonb")}`,
        ["{}"],
      );
      plan = explained.rows[0]!["QUERY PLAN"][0]!.Plan;
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
      client.release();
    }
    const reads = occurrencePlanReads(plan);
    // One count read and one last-fire read, each with one loop for each of the three schedules.
    expect(reads.map((read) => read["Actual Loops"])).toEqual([3, 3]);
    for (const read of reads) {
      // Each read must seek the rows of one schedule. A scan without both keys in its index
      // condition could read every occurrence and still return few rows.
      expect(read["Index Cond"]).toMatch(/\bnamespace [<>=]/);
      expect(read["Index Cond"]).toMatch(/\bschedule_name [<>=]/);
      // Actual Rows counts the rows after the filter, so add the rows that the filter removed.
      // Both are the mean of the loops, and each loop reads one schedule.
      const examined = read["Actual Rows"]! + (read["Rows Removed by Filter"] ?? 0);
      expect(examined).toBeLessThanOrEqual(occurrenceCap + 1);
      expect(examined * read["Actual Loops"]!).toBeLessThanOrEqual((occurrenceCap + 1) * 3);
    }
    // EXPLAIN does not count the index entries that an index key rejects. Thus the last-fire read
    // must also touch only a few blocks for each schedule: the index path and one heap block.
    const lastFire = reads.find((read) => read["Index Cond"]?.includes("schedule_name >="));
    expect(lastFire).toBeDefined();
    const blocks = lastFire!["Shared Hit Blocks"]! + lastFire!["Shared Read Blocks"]!;
    expect(blocks).toBeLessThanOrEqual(5 * lastFire!["Actual Loops"]!);
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
  it("fires the other schedules when one definition fails, and records its error", async () => {
    await queue.syncSchedules("billing", [
      {
        name: "good",
        schedule: "* * * * * *",
        task: { type: "t.good", payload: {}, queue: "qgood" },
      },
    ]);
    await queue.syncSchedules("aaa", [
      {
        name: "bad",
        schedule: "* * * * * *",
        task: { type: "t.bad", payload: {}, queue: "qfast", concurrencyKey: "k" },
      },
    ]);
    // An operator moves the queue to the fast tier after the synchronization. Each fire of `bad`
    // then fails in the enqueue.
    await pool.query("SELECT workhorse.set_queue_tier_v1('qfast', 'fast', 'operator', 'proof')");
    const positions = await pool.query<{ schedule_name: string; last_evaluated_at: Date }>(
      "SELECT schedule_name, last_evaluated_at FROM workhorse.schedule_definition ORDER BY 1",
    );
    const badPosition = positions.rows.find((row) => row.schedule_name === "bad")!;
    const evaluationAt = new Date(
      Math.max(...positions.rows.map((row) => row.last_evaluated_at.getTime())) + 3_000,
    );

    const fired = await pool.query<{ namespace: string; schedule_name: string }>(
      `SELECT namespace, schedule_name
         FROM workhorse.fire_due_schedules_v2(ARRAY['aaa', 'billing'], $1, 100, 1000)`,
      [evaluationAt],
    );

    expect(fired.rows.length).toBeGreaterThanOrEqual(3);
    expect(new Set(fired.rows.map((row) => `${row.namespace}/${row.schedule_name}`))).toEqual(
      new Set(["billing/good"]),
    );
    const definitions = await pool.query<{
      schedule_name: string;
      last_evaluated_at: Date;
      last_error_at: Date | null;
      last_error_code: string | null;
      last_error_message: string | null;
    }>(
      `SELECT schedule_name, last_evaluated_at, last_error_at, last_error_code, last_error_message
         FROM workhorse.schedule_definition ORDER BY schedule_name`,
    );
    expect(definitions.rows).toEqual([
      {
        schedule_name: "bad",
        last_evaluated_at: badPosition.last_evaluated_at,
        last_error_at: evaluationAt,
        last_error_code: "P1007",
        last_error_message: "fast-tier queue qfast does not support concurrency keys",
      },
      {
        schedule_name: "good",
        last_evaluated_at: evaluationAt,
        last_error_at: null,
        last_error_code: null,
        last_error_message: null,
      },
    ]);
    expect(
      (
        await pool.query(
          "SELECT count(*)::integer AS count FROM workhorse.schedule_occurrence WHERE schedule_name = 'bad'",
        )
      ).rows[0]?.count,
    ).toBe(0);

    const dashboard = await pool.query<{
      result: { schedules: Array<Record<string, unknown>> };
    }>("SELECT workhorse.dashboard_cron_v1('{}'::jsonb) AS result");
    expect(
      dashboard.rows[0]!.result.schedules.find((schedule) => schedule["name"] === "bad"),
    ).toMatchObject({
      lastErrorAt: evaluationAt.toISOString(),
      lastErrorCode: "P1007",
      lastErrorMessage: "fast-tier queue qfast does not support concurrency keys",
    });

    // The queue goes back to the full tier. The next pass fires the occurrences that `bad` kept,
    // and it clears the error.
    await pool.query("SELECT workhorse.set_queue_tier_v1('qfast', 'full', 'operator', 'proof')");
    const retried = await pool.query<{ schedule_name: string }>(
      `SELECT schedule_name FROM workhorse.fire_due_schedules_v2(ARRAY['aaa'], $1, 100, 1000)`,
      [evaluationAt],
    );
    expect(retried.rows.length).toBeGreaterThanOrEqual(3);
    expect(
      (
        await pool.query(
          `SELECT last_evaluated_at, last_error_at, last_error_code, last_error_message
             FROM workhorse.schedule_definition WHERE schedule_name = 'bad'`,
        )
      ).rows,
    ).toEqual([
      {
        last_evaluated_at: evaluationAt,
        last_error_at: null,
        last_error_code: null,
        last_error_message: null,
      },
    ]);
  });

  it("fails only a stored definition whose queue name the enqueue refuses", async () => {
    await queue.syncSchedules("names", [
      {
        name: "short",
        schedule: "* * * * * *",
        task: { type: "t.short", payload: {}, queue: "short-queue" },
      },
    ]);
    // An older release stored this definition. The synchronization now refuses its name.
    const longQueue = "q".repeat(257);
    await pool.query(
      `INSERT INTO workhorse.schedule_definition(
         namespace, schedule_name, cron_expression, queue_name, task_type, payload, max_attempts,
         last_evaluated_at)
       SELECT 'names', 'long', '* * * * * *', $1, 't.long', '{}'::jsonb, 25, last_evaluated_at
         FROM workhorse.schedule_definition WHERE schedule_name = 'short'`,
      [longQueue],
    );
    const position = (
      await pool.query<{ last_evaluated_at: Date }>(
        "SELECT last_evaluated_at FROM workhorse.schedule_definition WHERE schedule_name = 'short'",
      )
    ).rows[0]!.last_evaluated_at;
    const evaluationAt = new Date(position.getTime() + 2_000);

    const fired = await pool.query<{ schedule_name: string }>(
      "SELECT schedule_name FROM workhorse.fire_due_schedules_v2(ARRAY['names'], $1, 100, 1000)",
      [evaluationAt],
    );

    expect(fired.rows.map((row) => row.schedule_name)).toEqual(["short", "short"]);
    expect(
      (
        await pool.query(
          `SELECT schedule_name, last_evaluated_at, last_error_at, last_error_code,
                  last_error_message
             FROM workhorse.schedule_definition ORDER BY schedule_name`,
        )
      ).rows,
    ).toEqual([
      {
        schedule_name: "long",
        last_evaluated_at: position,
        last_error_at: evaluationAt,
        last_error_code: "P0001",
        last_error_message: "queue name must contain at most 256 UTF-8 bytes",
      },
      {
        schedule_name: "short",
        last_evaluated_at: evaluationAt,
        last_error_at: null,
        last_error_code: null,
        last_error_message: null,
      },
    ]);
  });

  it("continues the pass when a lock timeout fails a definition whose row another fire holds", async () => {
    await queue.syncSchedules("row-held", [
      {
        name: "busy",
        schedule: "* * * * * *",
        catchupPolicy: "all",
        task: { type: "t.busy", payload: {}, queue: "row-held-busy" },
      },
      {
        name: "healthy",
        schedule: "* * * * * *",
        catchupPolicy: "all",
        task: { type: "t.healthy", payload: {}, queue: "row-held-healthy" },
      },
      {
        name: "idle",
        schedule: "0 0 0 1 1 *",
        catchupPolicy: "all",
        task: { type: "t.idle", payload: {}, queue: "row-held-idle" },
      },
    ]);
    const occurrenceAt = new Date(
      (
        await pool.query<{ occurrence_at: Date }>(
          `SELECT max(date_trunc('second', last_evaluated_at)) + interval '1 second' AS occurrence_at
             FROM workhorse.schedule_definition WHERE namespace = 'row-held'`,
        )
      ).rows[0]!.occurrence_at,
    );
    const revisions = new Map(
      (
        await pool.query<{ schedule_name: string; revision: string }>(
          "SELECT schedule_name, revision::text FROM workhorse.schedule_definition",
        )
      ).rows.map((row) => [row.schedule_name, row.revision]),
    );
    const holder = await pool.connect();
    const pass = await pool.connect();
    try {
      // Manual fires of later occurrences hold the definition rows of `busy` and `idle` until they
      // commit. `busy` has a due occurrence, and `idle` has none, so only its position moves.
      await holder.query("BEGIN");
      for (const name of ["busy", "idle"]) {
        await holder.query(
          "SELECT workhorse.fire_schedule_v1('row-held', $1, $2::bigint, $3::timestamptz)",
          [name, revisions.get(name), new Date(occurrenceAt.getTime() + 10_000)],
        );
      }
      await pass.query("SET lock_timeout = '100ms'");
      const fired = await pass.query<{ schedule_name: string }>(
        "SELECT schedule_name FROM workhorse.fire_due_schedules_v2(ARRAY['row-held'], $1, 100, 1000)",
        [new Date(occurrenceAt.getTime() + 1_000)],
      );
      expect(fired.rows.map((row) => row.schedule_name)).toEqual(["healthy", "healthy"]);
      // The rows stay locked, so the pass writes neither an error record nor a position for them.
      expect(
        (
          await pass.query(
            `SELECT schedule_name, last_error_at, last_evaluated_at < $1 AS kept_position
               FROM workhorse.schedule_definition
              WHERE schedule_name IN ('busy', 'idle') ORDER BY schedule_name`,
            [occurrenceAt],
          )
        ).rows,
      ).toEqual([
        { schedule_name: "busy", last_error_at: null, kept_position: true },
        { schedule_name: "idle", last_error_at: null, kept_position: true },
      ]);
    } finally {
      await holder.query("ROLLBACK").catch(() => undefined);
      holder.release();
      await pass.query("RESET lock_timeout").catch(() => undefined);
      pass.release();
    }
  });

  it("rolls back the earlier fires of a definition when a later fire fails", async () => {
    await queue.syncSchedules("partial", [
      {
        name: "healthy",
        schedule: "* * * * * *",
        catchupPolicy: "all",
        task: { type: "t.healthy", payload: {}, queue: "partial-healthy" },
      },
      {
        name: "partial",
        schedule: "* * * * * *",
        catchupPolicy: "all",
        task: { type: "t.partial", payload: {}, queue: "partial-queue" },
      },
    ]);
    const occurrenceAt = await firstOccurrenceAfterSync("partial");
    const positions = await pool.query<{ schedule_name: string; last_evaluated_at: Date }>(
      "SELECT schedule_name, last_evaluated_at FROM workhorse.schedule_definition ORDER BY 1",
    );
    const failingAt = new Date(occurrenceAt.getTime() + 1_000);
    // The first occurrence of `partial` fires. Its second occurrence then fails.
    await pool.query(
      `CREATE FUNCTION public.sm1927_raise_on_second_fire() RETURNS trigger LANGUAGE plpgsql AS $$
       BEGIN
         IF NEW.schedule_name = 'partial' AND NEW.occurrence_at = '${failingAt.toISOString()}' THEN
           RAISE EXCEPTION 'injected second fire failure';
         END IF;
         RETURN NEW;
       END;
       $$`,
    );
    let fired: { schedule_name: string; occurrence_at: Date }[];
    try {
      await pool.query(
        `CREATE TRIGGER sm1927_raise_on_second_fire BEFORE INSERT ON workhorse.schedule_occurrence
           FOR EACH ROW EXECUTE FUNCTION public.sm1927_raise_on_second_fire()`,
      );
      fired = (
        await pool.query<{ schedule_name: string; occurrence_at: Date }>(
          `SELECT schedule_name, occurrence_at
             FROM workhorse.fire_due_schedules_v2(ARRAY['partial'], $1, 100, 1000)`,
          [new Date(occurrenceAt.getTime() + 2_000)],
        )
      ).rows;
    } finally {
      await pool.query(
        "DROP TRIGGER IF EXISTS sm1927_raise_on_second_fire ON workhorse.schedule_occurrence",
      );
      await pool.query("DROP FUNCTION IF EXISTS public.sm1927_raise_on_second_fire()");
    }

    // The pass returns only the rows of `healthy`, and `partial` keeps nothing of its first fire.
    expect(fired.map((row) => row.schedule_name)).toEqual(["healthy", "healthy", "healthy"]);
    const occurrences = await pool.query<{ schedule_name: string; count: number }>(
      `SELECT schedule_name, count(*)::integer AS count FROM workhorse.schedule_occurrence
        GROUP BY schedule_name ORDER BY schedule_name`,
    );
    expect(occurrences.rows).toEqual([{ schedule_name: "healthy", count: 3 }]);
    const tasks = await pool.query<{ task_type: string; count: number }>(
      "SELECT task_type, count(*)::integer AS count FROM workhorse.task GROUP BY task_type",
    );
    expect(tasks.rows).toEqual([{ task_type: "t.healthy", count: 3 }]);
    const partial = await pool.query<{
      last_evaluated_at: Date;
      last_error_code: string | null;
      last_error_message: string | null;
    }>(
      `SELECT last_evaluated_at, last_error_code, last_error_message
         FROM workhorse.schedule_definition WHERE schedule_name = 'partial'`,
    );
    expect(partial.rows).toEqual([
      {
        last_evaluated_at: positions.rows.find((row) => row.schedule_name === "partial")!
          .last_evaluated_at,
        last_error_code: "P0001",
        last_error_message: "injected second fire failure",
      },
    ]);
  });

  it.each([
    ["40001", "a serialization failure"],
    ["57014", "a canceled statement"],
  ])("ends the pass on SQLSTATE %s, %s", async (sqlstate) => {
    await queue.syncSchedules("propagate", [
      {
        name: "first",
        schedule: "* * * * * *",
        task: { type: "t.first", payload: {}, queue: "propagate-a" },
      },
      {
        name: "second",
        schedule: "* * * * * *",
        task: { type: "t.second", payload: {}, queue: "propagate-b" },
      },
    ]);
    const evaluationAt = new Date((await firstOccurrenceAfterSync("propagate")).getTime());
    await pool.query(
      `CREATE FUNCTION public.sm1927_raise_on_second() RETURNS trigger LANGUAGE plpgsql AS $$
       BEGIN
         IF NEW.schedule_name = 'second' THEN
           RAISE EXCEPTION 'injected' USING ERRCODE = '${sqlstate}';
         END IF;
         RETURN NEW;
       END;
       $$`,
    );
    try {
      await pool.query(
        `CREATE TRIGGER sm1927_raise_on_second BEFORE INSERT ON workhorse.schedule_occurrence
           FOR EACH ROW EXECUTE FUNCTION public.sm1927_raise_on_second()`,
      );
      await expect(
        pool.query(
          "SELECT * FROM workhorse.fire_due_schedules_v2(ARRAY['propagate'], $1, 100, 1000)",
          [evaluationAt],
        ),
      ).rejects.toMatchObject({ code: sqlstate });
    } finally {
      await pool.query(
        "DROP TRIGGER IF EXISTS sm1927_raise_on_second ON workhorse.schedule_occurrence",
      );
      await pool.query("DROP FUNCTION IF EXISTS public.sm1927_raise_on_second()");
    }
    // The pass rolled back, so the first definition also kept its position and fired nothing.
    expect(
      (
        await pool.query(
          `SELECT count(*)::integer AS count FROM workhorse.schedule_occurrence
            WHERE namespace = 'propagate'`,
        )
      ).rows[0]?.count,
    ).toBe(0);
    expect(
      (
        await pool.query(
          `SELECT count(*)::integer AS count FROM workhorse.schedule_definition
            WHERE namespace = 'propagate' AND last_error_at IS NOT NULL`,
        )
      ).rows[0]?.count,
    ).toBe(0);
  });

  it("refuses an enabled definition with a concurrency key on a fast-tier queue", async () => {
    await pool.query(
      "SELECT workhorse.set_queue_tier_v1('fast-keyed', 'fast', 'operator', 'proof')",
    );

    await expect(queue.syncSchedules("fast-keys", keyedFastSchedule(true))).rejects.toMatchObject({
      code: "P1007",
      message: "fast-tier queue fast-keyed does not support concurrency keys",
    });
    expect(
      (await pool.query("SELECT count(*)::integer AS count FROM workhorse.schedule_definition"))
        .rows[0]?.count,
    ).toBe(0);

    // A disabled definition never fires, so a deployment can keep it while the queue is fast.
    await queue.syncSchedules("fast-keys", keyedFastSchedule(false));
    // A key on a full-tier queue and a fast-tier queue with no key stay accepted.
    await queue.syncSchedules("other-keys", [
      {
        name: "full-keyed",
        schedule: "* * * * * *",
        task: { type: "t.keyed", payload: {}, queue: "full-keyed", concurrencyKey: "k" },
      },
      {
        name: "fast-plain",
        schedule: "* * * * * *",
        task: { type: "t.plain", payload: {}, queue: "fast-keyed" },
      },
    ]);
    expect(
      (await pool.query("SELECT count(*)::integer AS count FROM workhorse.schedule_definition"))
        .rows[0]?.count,
    ).toBe(3);
  });

  it("keeps a worker run going when one schedule definition fails", async () => {
    await queue.syncSchedules("worker-isolation", [
      {
        name: "bad",
        schedule: "* * * * * *",
        task: { type: "t.bad", payload: {}, queue: "worker-fast", concurrencyKey: "k" },
      },
      {
        name: "good",
        schedule: "* * * * * *",
        task: { type: "t.good", payload: {}, queue: "worker-good" },
      },
    ]);
    await pool.query(
      "SELECT workhorse.set_queue_tier_v1('worker-fast', 'fast', 'operator', 'proof')",
    );
    const occurrenceAt = await firstOccurrenceAfterSync("worker-isolation");
    const progress = { passes: 0, handled: 0, settled: false };
    const worker = new Worker(
      new ScheduleEvaluationQueue(pool, occurrenceAt, { after: () => (progress.passes += 1) }),
      {
        workerId: "schedule-isolation",
        queue: "worker-good",
        scheduleNamespaces: ["worker-isolation"],
        maintenanceIntervalMs: 200,
        maintenanceRoutinePollMs: 200,
      },
    ).handle("t.good", () => {
      progress.handled += 1;
      return null;
    });
    const running = worker.run().finally(() => {
      progress.settled = true;
    });
    try {
      // A pass after the handled task shows that the run continued past the failing definition.
      while (!progress.settled && (progress.handled < 1 || progress.passes < 3)) {
        await sleep(50);
      }
    } finally {
      worker.stop();
      await running;
    }

    expect(progress.handled).toBe(1);
    expect(
      (
        await pool.query(
          `SELECT schedule_name, last_error_code FROM workhorse.schedule_definition
            ORDER BY schedule_name`,
        )
      ).rows,
    ).toEqual([
      { schedule_name: "bad", last_error_code: "P1007" },
      { schedule_name: "good", last_error_code: null },
    ]);
  });

  it.each([
    ["0 12 * * ?", "five fields"],
    ["0 0 12 * * ?", "six fields"],
    ["0 12 ? * ?", "two question marks"],
  ])("synchronizes and evaluates %s with a wildcard day of month (%s)", async (expression) => {
    await queue.syncSchedules("question-days", [
      { name: "noon", schedule: expression, task: { type: "t.noon", payload: null } },
    ]);
    const occurrences = await pool.query<{ occurrence_at: Date }>(
      `SELECT occurrence_at FROM workhorse.cron_occurrences_v1(
         $1, '2026-11-01 00:00+00', '2026-11-10 13:00+00', 100, 'UTC') occurrence_at`,
      [expression],
    );
    expect(occurrences.rows.map((row) => row.occurrence_at.toISOString())).toEqual(
      Array.from(
        { length: 10 },
        (_, index) => `2026-11-${String(index + 1).padStart(2, "0")}T12:00:00.000Z`,
      ),
    );
  });
});
