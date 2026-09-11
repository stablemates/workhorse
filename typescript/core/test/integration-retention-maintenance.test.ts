import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { installSchema, Queue, type RetentionPolicyDefinition, Worker } from "../src/index.js";
import { createIntegrationTestContext } from "./support/integration.js";

const { defaultRetentionPolicy, pool, queue, waitForDatabaseCondition, admin } =
  createIntegrationTestContext(import.meta.url);

describe("retention maintenance", () => {
  it("keeps an operator maintenance-time override until it is reverted", async () => {
    await queue.syncMaintenancePolicy(
      { timezone: "UTC", historyRetentionLocalTime: "03:00" },
      { force: true },
    );
    await queue.overrideMaintenancePolicy({ historyRetentionLocalTime: "01:30" });

    await queue.syncMaintenancePolicy({
      timezone: "UTC",
      historyRetentionLocalTime: "04:15",
    });
    await expect(queue.getMaintenancePolicy()).resolves.toMatchObject({
      historyRetentionLocalTime: "01:30",
      provenance: {
        historyRetentionLocalTime: {
          source: "operator",
          applicationDefault: "04:15",
        },
      },
    });

    await queue.revertMaintenancePolicy(["historyRetentionLocalTime"]);
    await expect(queue.getMaintenancePolicy()).resolves.toMatchObject({
      historyRetentionLocalTime: "04:15",
      provenance: {
        historyRetentionLocalTime: {
          source: "application",
          applicationDefault: "04:15",
        },
      },
    });
  });

  it("keeps operator retention overrides while application defaults continue to update", async () => {
    await queue.syncRetentionPolicy(defaultRetentionPolicy, { force: true });
    await queue.overrideRetentionPolicy({
      taskIdentityRetentionDays: 30,
      taskEventRetentionDays: 30,
    });

    await queue.syncRetentionPolicy({
      ...defaultRetentionPolicy,
      taskIdentityRetentionDays: 21,
      taskEventRetentionDays: 21,
    });
    await expect(queue.getRetentionPolicy()).resolves.toMatchObject({
      taskEventRetentionDays: 30,
      provenance: {
        taskEventRetentionDays: { source: "operator", applicationDefault: 21 },
      },
    });

    await queue.revertRetentionPolicy(["taskEventRetentionDays"]);
    await expect(queue.getRetentionPolicy()).resolves.toMatchObject({
      taskEventRetentionDays: 21,
      provenance: {
        taskEventRetentionDays: { source: "application", applicationDefault: 21 },
      },
    });
  });

  it("restores omitted optional settings to application defaults during a forced sync", async () => {
    await queue.syncMaintenancePolicy(
      { timezone: "UTC", partitionPreparationIntervalMs: 60_000 },
      { force: true },
    );
    await queue.syncRetentionPolicy(
      { ...defaultRetentionPolicy, terminalTaskPruneLimit: 50 },
      { force: true },
    );
    await queue.overrideMaintenancePolicy({ partitionPreparationIntervalMs: 120_000 });
    await queue.overrideRetentionPolicy({ terminalTaskPruneLimit: 75 });

    await queue.syncMaintenancePolicy({ timezone: "UTC" }, { force: true });
    await queue.syncRetentionPolicy(
      {
        taskIdentityRetentionDays: defaultRetentionPolicy.taskIdentityRetentionDays,
        terminalOutcomeRetentionDays: defaultRetentionPolicy.terminalOutcomeRetentionDays,
        taskEventRetentionDays: defaultRetentionPolicy.taskEventRetentionDays,
        attemptHistoryRetentionDays: defaultRetentionPolicy.attemptHistoryRetentionDays,
        scheduleOccurrenceRetentionDays: defaultRetentionPolicy.scheduleOccurrenceRetentionDays,
        statisticsRetentionDays: defaultRetentionPolicy.statisticsRetentionDays,
      },
      { force: true },
    );

    await expect(queue.getMaintenancePolicy()).resolves.toMatchObject({
      partitionPreparationIntervalMs: 60_000,
      provenance: { partitionPreparationIntervalMs: { source: "application" } },
    });
    await expect(queue.getRetentionPolicy()).resolves.toMatchObject({
      terminalTaskPruneLimit: 50,
      provenance: { terminalTaskPruneLimit: { source: "application" } },
    });
  });

  it("previews bounded rows that shorter retention would make eligible", async () => {
    const id = await queue.enqueue("retention-preview", {});
    const claimed = await queue.claim("retention-preview-worker");
    await queue.complete(claimed!, "retention-preview-worker", { ok: true });
    await pool.query("UPDATE workhorse.task SET created_at = '2020-01-01' WHERE id = $1", [id]);
    await pool.query(
      "UPDATE workhorse.task_outcome SET finished_at = '2020-01-02' WHERE task_id = $1",
      [id],
    );

    await expect(
      queue.previewRetentionPolicy({
        taskIdentityRetentionDays: 1,
        terminalOutcomeRetentionDays: 1,
      }),
    ).resolves.toMatchObject({
      eligible: { terminalTasks: 1 },
      capped: { terminalTasks: false },
    });
  });

  it("persists one IANA maintenance timezone and runs daily retention once after local time", async () => {
    expect(
      await queue.syncMaintenancePolicy({
        timezone: "America/New_York",
        partitionPreparationIntervalMs: 3_600_000,
        terminalCleanupIntervalMs: 60_000,
        historyRetentionLocalTime: "03:30",
      }),
    ).toMatchObject({
      timezone: "America/New_York",
      partitionPreparationIntervalMs: 3_600_000,
      terminalCleanupIntervalMs: 60_000,
      historyRetentionLocalTime: "03:30",
    });
    await expect(queue.syncMaintenancePolicy({ timezone: "Mars/Olympus_Mons" })).rejects.toThrow(
      /valid IANA timezone/,
    );

    const beforeSpringForwardBoundary = new Date("2026-03-08T06:59:00.000Z");
    const atSpringForwardBoundary = new Date("2026-03-08T07:30:00.000Z");
    expect(await queue.retainHistory({ now: beforeSpringForwardBoundary })).toEqual([]);
    expect(await queue.retainHistory({ now: atSpringForwardBoundary })).toHaveLength(3);
    expect(await queue.retainHistory({ now: new Date("2026-03-08T08:00:00.000Z") })).toEqual([]);
    await queue.syncMaintenancePolicy({ timezone: "America/New_York" });
    expect(await queue.retainHistory({ now: new Date("2026-03-08T09:00:00.000Z") })).toEqual([]);
    await queue.syncMaintenancePolicy({
      timezone: "America/New_York",
      partitionPreparationIntervalMs: 7_200_000,
    });
    expect(await queue.retainHistory({ now: new Date("2026-03-08T10:00:00.000Z") })).toEqual([]);
    expect(
      (
        await pool.query(
          "SELECT last_completed_local_date::text AS last_completed_local_date FROM workhorse.maintenance_state WHERE routine_name = 'history_retention'",
        )
      ).rows,
    ).toEqual([{ last_completed_local_date: "2026-03-08" }]);
  });

  it("continues bounded occurrence retention on the same local date until the backlog clears", async () => {
    await pool.query(
      `INSERT INTO workhorse.schedule_definition(
         namespace, schedule_name, cron_expression, queue_name, task_type, payload, max_attempts
       ) VALUES ('retention-backlog', 'daily', '0 0 * * *', 'default', 'backlog', '{}'::jsonb, 1)`,
    );
    await pool.query(
      `INSERT INTO workhorse.schedule_occurrence(namespace, schedule_name, occurrence_at)
       VALUES ('retention-backlog', 'daily', '2020-01-01T00:00:00Z'),
              ('retention-backlog', 'daily', '2020-01-02T00:00:00Z')`,
    );
    await queue.syncRetentionPolicy({
      ...defaultRetentionPolicy,
      occurrenceRowsPerPass: 1,
    });
    await queue.syncMaintenancePolicy({ timezone: "UTC", historyRetentionLocalTime: "03:00" });

    const first = await queue.retainHistory({ now: new Date("2026-08-02T03:00:00.000Z") });
    const second = await queue.retainHistory({ now: new Date("2026-08-02T03:01:00.000Z") });
    const third = await queue.retainHistory({ now: new Date("2026-08-02T03:02:00.000Z") });
    expect(first[2]).toMatchObject({ phase: "schedule_occurrences", rowsAffected: 1 });
    expect(second[2]).toMatchObject({ phase: "schedule_occurrences", rowsAffected: 1 });
    expect(third).toEqual([]);
  });

  it("globally rate-limits interval maintenance routines while allowing explicit forced runs", async () => {
    const now = new Date("2026-08-02T12:00:00.000Z");
    expect(await queue.prepareHistoryPartitions({ now })).toHaveLength(1);
    expect(await queue.prepareHistoryPartitions({ now: new Date(now.getTime() + 1_000) })).toEqual(
      [],
    );
    expect(await queue.prepareHistoryPartitions({ force: true, now })).toHaveLength(1);

    expect(await queue.pruneTerminalStorage({ now })).toHaveLength(3);
    expect(await queue.pruneTerminalStorage({ now: new Date(now.getTime() + 1_000) })).toEqual([]);
    expect(await queue.pruneTerminalStorage({ force: true, now })).toHaveLength(3);
  });

  it("isolates housekeeping phases when partition replenishment fails", async () => {
    await pool.query(
      `INSERT INTO workhorse.schedule_definition(
         namespace, schedule_name, cron_expression, queue_name, task_type, payload, max_attempts
       ) VALUES ('integration', 'isolation', '0 * * * *', 'default', 'isolation', '{}'::jsonb, 3)`,
    );
    await pool.query(
      `INSERT INTO workhorse.schedule_occurrence(namespace, schedule_name, occurrence_at)
       VALUES ('integration', 'isolation', clock_timestamp() - interval '40 days')`,
    );
    await pool.query(`
      DO $$
      DECLARE suffix text := to_char(current_date + 3, 'YYYYMMDD');
      BEGIN
        EXECUTE format('DROP TABLE workhorse.%I', 'task_event_' || suffix);
        EXECUTE format('DROP TABLE workhorse.%I', 'attempt_history_' || suffix);
      END
      $$`);
    await pool.query(`
      CREATE OR REPLACE FUNCTION workhorse.create_history_day_v1(p_day date)
      RETURNS void LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'forced partition replenishment failure';
      END
      $$`);

    try {
      const partitionResults = await queue.prepareHistoryPartitions({ force: true });
      expect(partitionResults[0]).toMatchObject({
        phase: "history_partitions",
        rowsAffected: 0,
        skippedLock: false,
        error: { message: "forced partition replenishment failure" },
      });
      const retentionResults = await queue.retainHistory({ force: true });
      expect(retentionResults[2]).toMatchObject({
        phase: "schedule_occurrences",
        rowsAffected: 1,
        skippedLock: false,
        error: null,
      });
    } finally {
      await installSchema(pool);
    }
  });

  it("materializes closed minutes of statistics and converges when a minute is recomputed", async () => {
    await queue.enqueue("stat-alpha", {});
    await queue.enqueue("stat-alpha", {});
    await queue.enqueue("stat-beta", {});
    await queue.tick();
    const worker = new Worker(queue, {
      workerId: "worker-statistics",
    })
      .handle("stat-alpha", () => ({ ok: true }))
      .handle("stat-beta", () => {
        throw new Error("stat failure");
      });
    for (let index = 0; index < 3; index += 1) await worker.runOnce();

    // Roll up as if the minute holding this work had already closed.
    const later = new Date(Date.now() + 120_000);
    const first = await queue.rollupStatistics({ now: later });
    expect(first.map(({ phase }) => phase)).toEqual(["stat_rollup", "stat_retention"]);
    expect(first.every(({ error }) => error === null)).toBe(true);

    const stored = async () =>
      (
        await pool.query<{
          task_type: string;
          enqueued: number;
          task_succeeded: number;
          attempt_succeeded: number;
          attempt_retry: number;
          last_error: string | null;
        }>(`SELECT task_type, sum(enqueued)::integer AS enqueued,
                   sum(task_succeeded)::integer AS task_succeeded,
                   sum(attempt_succeeded)::integer AS attempt_succeeded,
                   sum(attempt_retry)::integer AS attempt_retry,
                   max(last_error) AS last_error
              FROM workhorse.task_stat_bucket GROUP BY task_type ORDER BY task_type`)
      ).rows;

    expect(await stored()).toEqual([
      {
        task_type: "stat-alpha",
        enqueued: 2,
        task_succeeded: 2,
        attempt_succeeded: 2,
        attempt_retry: 0,
        last_error: null,
      },
      {
        task_type: "stat-beta",
        enqueued: 1,
        task_succeeded: 0,
        attempt_succeeded: 0,
        attempt_retry: 1,
        last_error: "stat failure",
      },
    ]);

    // A bucket is a pure function of the history in its minute, so rerunning the pass rewrites the
    // same numbers rather than adding to them.
    const before = await stored();
    await queue.rollupStatistics({ force: true, now: later });
    await queue.rollupStatistics({ force: true, now: later });
    expect(await stored()).toEqual(before);
  });

  it("rate limits the statistics rollup on the policy cadence and lets zero opt out", async () => {
    const later = new Date(Date.now() + 120_000);
    const first = await queue.rollupStatistics({ now: later });
    expect(first.map(({ phase }) => phase)).toEqual(["stat_rollup", "stat_retention"]);

    // Within the policy interval the pass returns without work rather than rewriting buckets.
    const gated = await queue.rollupStatistics({ now: later });
    expect(gated).toEqual([]);

    // Past the interval the pass runs again.
    const dueAgain = await queue.rollupStatistics({ now: new Date(later.getTime() + 61_000) });
    expect(dueAgain.map(({ phase }) => phase)).toEqual(["stat_rollup", "stat_retention"]);

    // A zero interval opts the fleet out; force still runs an explicit operator pass.
    await queue.overrideMaintenancePolicy({ statisticsRollupIntervalMs: 0 });
    const disabled = await queue.rollupStatistics({ now: new Date(later.getTime() + 300_000) });
    expect(disabled).toEqual([]);
    const forced = await queue.rollupStatistics({
      force: true,
      now: new Date(later.getTime() + 300_000),
    });
    expect(forced.map(({ phase }) => phase)).toEqual(["stat_rollup", "stat_retention"]);
  });

  it("keeps operator statistics-cadence overrides while sync updates application defaults", async () => {
    await queue.overrideMaintenancePolicy({
      statisticsRollupIntervalMs: 120_000,
      statisticsRecomputeBuckets: 10,
    });
    await queue.syncMaintenancePolicy({
      timezone: "UTC",
      statisticsRollupIntervalMs: 30_000,
      statisticsGroupLimit: 500,
      statisticsRecomputeBuckets: 5,
    });
    await expect(queue.getMaintenancePolicy()).resolves.toMatchObject({
      statisticsRollupIntervalMs: 120_000,
      statisticsGroupLimit: 500,
      statisticsRecomputeBuckets: 10,
      provenance: {
        statisticsRollupIntervalMs: { source: "operator", applicationDefault: 30_000 },
        statisticsGroupLimit: { source: "application", applicationDefault: 500 },
        statisticsRecomputeBuckets: { source: "operator", applicationDefault: 5 },
      },
    });

    await queue.revertMaintenancePolicy([
      "statisticsRollupIntervalMs",
      "statisticsRecomputeBuckets",
    ]);
    await expect(queue.getMaintenancePolicy()).resolves.toMatchObject({
      statisticsRollupIntervalMs: 30_000,
      statisticsRecomputeBuckets: 5,
      provenance: {
        statisticsRollupIntervalMs: { source: "application", applicationDefault: 30_000 },
      },
    });
  });

  it("stitches materialized buckets to a live tail so a window covers unrolled minutes", async () => {
    await queue.enqueue("stat-tail", {});
    await queue.tick();

    const window = async () =>
      (
        await pool.query<{ enqueued: number }>(
          `SELECT COALESCE(sum(enqueued), 0)::integer AS enqueued
             FROM workhorse.stat_buckets_v1(
               date_bin('1 minute', clock_timestamp(),
                 timestamp '2000-01-01' AT TIME ZONE 'UTC') - interval '1 hour',
               clock_timestamp()
             )`,
        )
      ).rows[0]!.enqueued;

    // Nothing is materialized yet: the window is derived entirely from raw history.
    expect(
      (await pool.query<{ count: string }>("SELECT count(*) FROM workhorse.task_stat_bucket"))
        .rows[0]?.count,
    ).toBe("0");
    expect(await window()).toBe(1);

    await queue.rollupStatistics({ now: new Date(Date.now() + 120_000) });
    expect(
      (await pool.query<{ count: string }>("SELECT count(*) FROM workhorse.task_stat_bucket"))
        .rows[0]?.count,
    ).not.toBe("0");
    // The same window now reads a materialized bucket and still reports the same total.
    expect(await window()).toBe(1);
  });

  it("derives hourly and daily tiers and reads mergeable wait percentiles from them", async () => {
    const taskId = await queue.enqueue("stat-tiered", {});
    const claimed = await queue.claim("stat-tiered-worker");
    expect(claimed?.id).toBe(taskId);

    await pool.query(
      `UPDATE workhorse.task_event
          SET occurred_at = date_bin('1 day', clock_timestamp(),
                timestamp '2000-01-01' AT TIME ZONE 'UTC') + interval '1 hour 5 minutes'
        WHERE task_id = $1 AND event_type = 'enqueued'`,
      [taskId],
    );
    await pool.query(
      `UPDATE workhorse.task_event
          SET occurred_at = date_bin('1 day', clock_timestamp(),
                timestamp '2000-01-01' AT TIME ZONE 'UTC') + interval '1 hour 15 minutes'
        WHERE task_id = $1 AND event_type = 'claimed'`,
      [taskId],
    );
    await pool.query(
      `UPDATE workhorse.task_stat_state
          SET rolled_up_through = date_bin('1 day', clock_timestamp(),
                timestamp '2000-01-01' AT TIME ZONE 'UTC') + interval '1 hour',
              hourly_rolled_up_through = date_bin('1 day', clock_timestamp(),
                timestamp '2000-01-01' AT TIME ZONE 'UTC') + interval '1 hour',
              daily_rolled_up_through = date_bin('1 day', clock_timestamp(),
                timestamp '2000-01-01' AT TIME ZONE 'UTC')`,
    );

    const tomorrow = new Date(Date.now() + 24 * 60 * 60_000);
    const result = await queue.rollupStatistics({
      force: true,
      now: tomorrow,
      maxBuckets: 2 * 24 * 60,
    });
    expect(result.every(({ error }) => error === null)).toBe(true);

    const tiers = await pool.query<{ minutes: string; hours: string; days: string }>(
      `SELECT (SELECT count(*) FROM workhorse.task_stat_bucket) AS minutes,
              (SELECT count(*) FROM workhorse.task_stat_bucket_hour) AS hours,
              (SELECT count(*) FROM workhorse.task_stat_bucket_day) AS days`,
    );
    expect(Number(tiers.rows[0]!.minutes)).toBeGreaterThan(0);
    expect(Number(tiers.rows[0]!.hours)).toBeGreaterThan(0);
    expect(Number(tiers.rows[0]!.days)).toBeGreaterThan(0);

    const percentile = await pool.query<{ p50_ms: number | null }>(
      `SELECT workhorse.stat_sketch_percentile_v1(
                workhorse.stat_sketch_merge_v1(array_agg(stat.wait_sketch)), 0.50
              ) AS p50_ms
         FROM workhorse.stat_buckets_v1(
           date_bin('1 day', clock_timestamp(), timestamp '2000-01-01' AT TIME ZONE 'UTC'),
           $1::timestamptz
         ) stat`,
      [tomorrow],
    );
    expect(percentile.rows[0]!.p50_ms).toBeGreaterThanOrEqual(590_000);
    expect(percentile.rows[0]!.p50_ms).toBeLessThanOrEqual(610_000);

    await expect(
      pool.query(
        `SELECT * FROM workhorse.stat_buckets_v1(
           clock_timestamp() - interval '30 days', clock_timestamp()
         )`,
      ),
    ).rejects.toThrow("hour-aligned lower bound");
  });

  it("folds statistics beyond the group limit into an overflow type instead of growing unbounded", async () => {
    for (let index = 0; index < 5; index += 1) await queue.enqueue(`stat-type-${index}`, {});
    await queue.overrideMaintenancePolicy({ statisticsGroupLimit: 2 });
    await queue.rollupStatistics({ now: new Date(Date.now() + 120_000) });
    const rows = await pool.query<{ task_type: string; enqueued: number }>(
      `SELECT task_type, sum(enqueued)::integer AS enqueued
         FROM workhorse.task_stat_bucket GROUP BY task_type ORDER BY task_type`,
    );
    expect(rows.rows).toHaveLength(3);
    const overflow = rows.rows.find((row) => row.task_type === "__other__");
    expect(overflow?.enqueued).toBe(3);
    expect(rows.rows.reduce((total, row) => total + row.enqueued, 0)).toBe(5);
  });

  it("prunes statistics buckets on their own policy, bounded per pass", async () => {
    await queue.enqueue("stat-prune", {});
    await queue.tick();
    await queue.rollupStatistics({ now: new Date(Date.now() + 120_000) });
    await pool.query(
      `INSERT INTO workhorse.task_stat_bucket_day (bucket_start, queue_name, task_type, enqueued)
       SELECT date_bin('1 day', bucket_start, timestamp '2000-01-01' AT TIME ZONE 'UTC'),
              queue_name, task_type, sum(enqueued)
         FROM workhorse.task_stat_bucket
        GROUP BY 1, 2, 3`,
    );
    await pool.query(
      "UPDATE workhorse.task_stat_bucket SET bucket_start = bucket_start - interval '30 days'",
    );
    await pool.query(
      "UPDATE workhorse.task_stat_bucket_hour SET bucket_start = bucket_start - interval '30 days'",
    );
    await pool.query(
      "UPDATE workhorse.task_stat_bucket_day SET bucket_start = bucket_start - interval '30 days'",
    );

    const storedBuckets = async () =>
      Number(
        (
          await pool.query<{ count: string }>(
            `SELECT sum(count)::text AS count FROM (
               SELECT count(*) FROM workhorse.task_stat_bucket
               UNION ALL SELECT count(*) FROM workhorse.task_stat_bucket_hour
               UNION ALL SELECT count(*) FROM workhorse.task_stat_bucket_day
             ) tiers`,
          )
        ).rows[0]!.count,
      );

    // Statistics deliberately sit outside the identity chain: aggregates may outlive the history
    // they were derived from, so a long statistics window with short history retention is legal.
    await queue.syncRetentionPolicy({ ...defaultRetentionPolicy, statisticsRetentionDays: 365 });
    await queue.rollupStatistics({ force: true, now: new Date() });
    expect(await storedBuckets()).toBeGreaterThan(0);

    await queue.syncRetentionPolicy({ ...defaultRetentionPolicy, statisticsRetentionDays: 1 });
    const pruned = await queue.rollupStatistics({ force: true, now: new Date() });
    expect(pruned.find((phase) => phase.phase === "stat_retention")?.rowsAffected).toBeGreaterThan(
      0,
    );
    expect(await storedBuckets()).toBe(0);
  });

  it("bounds statistics pruning by the configured rows per pass", async () => {
    await pool.query(
      `INSERT INTO workhorse.task_stat_bucket (bucket_start, queue_name, task_type, enqueued)
       SELECT clock_timestamp() - make_interval(days => 30, mins => i), 'default', 'bulk', 1
         FROM generate_series(1, 5) i`,
    );
    await queue.syncRetentionPolicy({
      ...defaultRetentionPolicy,
      statisticsRetentionDays: 1,
      statisticsRowsPerPass: 2,
    });
    const first = await queue.rollupStatistics({ now: new Date() });
    expect(first.find((phase) => phase.phase === "stat_retention")?.rowsAffected).toBe(2);
    expect(
      Number(
        (await pool.query<{ count: string }>("SELECT count(*) FROM workhorse.task_stat_bucket"))
          .rows[0]!.count,
      ),
    ).toBe(3);
  });

  it("reports rollup progress through health", async () => {
    const behind = await queue.health();
    expect(behind.statistics.lastRunAt).toBeNull();
    const now = new Date();
    await queue.rollupStatistics({ now });
    const caught = await queue.health();
    expect(caught.statistics.lastRunAt).not.toBeNull();
    expect(caught.statistics.lagMs).toBeLessThan(120_000);
    expect(caught.statistics.rolledUpThrough.getTime()).toBeLessThanOrEqual(now.getTime());
    expect(caught.statistics.buckets).toBe(0);
  });

  it("reports history size with daily partitions folded into their parent", async () => {
    await queue.enqueue("stat-size", {});
    const health = await queue.health();
    const events = health.observations.relations.find(
      (relation) => relation.relation === "task_event",
    );
    // The partitioned parent owns no storage itself, so an unaggregated reading is always zero.
    expect(events?.partitions).toBeGreaterThan(0);
    expect(events?.totalBytes).toBeGreaterThan(0);
    const buckets = health.observations.relations.find(
      (relation) => relation.relation === "task_stat_bucket",
    );
    expect(buckets?.partitions).toBe(0);
  });

  it("refuses to delete raw history past the rollup watermark", async () => {
    await queue.enqueue("stat-retention", {});
    await queue.tick();
    // Hold the watermark far in the past, as a stalled rollup would.
    await pool.query(
      `UPDATE workhorse.task_stat_state
          SET rolled_up_through = clock_timestamp() - interval '30 days'`,
    );
    await queue.syncRetentionPolicy({
      ...defaultRetentionPolicy,
      taskEventRetentionDays: 1,
      attemptHistoryRetentionDays: 1,
    });
    await pool.query(
      `UPDATE workhorse.task_event SET occurred_at = clock_timestamp() - interval '10 days'`,
    );

    await queue.retainHistory({ force: true });
    const retained = await pool.query<{ count: string }>(
      "SELECT count(*) FROM workhorse.task_event",
    );
    // The cutoff was clamped to the watermark, so history older than the policy survives the pass.
    expect(Number(retained.rows[0]!.count)).toBeGreaterThan(0);

    await pool.query(
      `UPDATE workhorse.task_stat_state
          SET rolled_up_through = date_bin('1 minute', clock_timestamp(),
            timestamp '2000-01-01' AT TIME ZONE 'UTC')`,
    );
    await queue.retainHistory({ force: true });
    const pruned = await pool.query<{ count: string }>("SELECT count(*) FROM workhorse.task_event");
    expect(Number(pruned.rows[0]!.count)).toBeLessThan(Number(retained.rows[0]!.count));
  });

  it("round trips retention policy defaults and rejects unsafe or malformed policies in PostgreSQL", async () => {
    await expect(queue.getRetentionPolicy()).resolves.toMatchObject(defaultRetentionPolicy);

    const definition: RetentionPolicyDefinition = {
      taskIdentityRetentionDays: 90,
      terminalOutcomeRetentionDays: 60,
      taskEventRetentionDays: 30,
      attemptHistoryRetentionDays: 45,
      scheduleOccurrenceRetentionDays: 14,
      statisticsRetentionDays: 120,
      terminalTaskPruneLimit: 17,
      historyPartitionsPerPass: 2,
      defaultPartitionRowsPerPass: 23,
      occurrenceRowsPerPass: 29,
      statisticsRowsPerPass: 31,
    };
    const persisted = await queue.syncRetentionPolicy(definition);
    expect(persisted).toMatchObject({
      ...definition,
      provenance: {
        taskIdentityRetentionDays: { source: "application", applicationDefault: 90 },
        taskEventRetentionDays: { source: "application", applicationDefault: 30 },
      },
      updatedAt: expect.any(Date),
    });
    await expect(queue.getRetentionPolicy()).resolves.toEqual(persisted);

    await expect(
      queue.syncRetentionPolicy({
        ...definition,
        taskIdentityRetentionDays: 10,
        taskEventRetentionDays: 11,
      }),
    ).rejects.toThrow(/retention_policy_check/);
    await expect(
      queue.syncRetentionPolicy({
        ...definition,
        taskIdentityRetentionDays: null,
      }),
    ).rejects.toThrow(/retention_policy_check/);
    await expect(
      pool.query(
        `UPDATE workhorse.retention_policy
            SET task_identity_retention_days = 30,
                terminal_outcome_retention_days = NULL
          WHERE singleton`,
      ),
    ).rejects.toThrow(/retention_policy_check/);
    await expect(
      queue.syncRetentionPolicy({ ...definition, historyPartitionsPerPass: 0 }),
    ).rejects.toThrow(/history_partitions_per_pass/);

    const withoutLimits = await queue.syncRetentionPolicy({
      taskIdentityRetentionDays: null,
      terminalOutcomeRetentionDays: null,
      taskEventRetentionDays: null,
      attemptHistoryRetentionDays: null,
      scheduleOccurrenceRetentionDays: 30,
      statisticsRetentionDays: null,
    });
    expect(withoutLimits).toMatchObject({
      terminalTaskPruneLimit: definition.terminalTaskPruneLimit,
      historyPartitionsPerPass: definition.historyPartitionsPerPass,
      defaultPartitionRowsPerPass: definition.defaultPartitionRowsPerPass,
      occurrenceRowsPerPass: definition.occurrenceRowsPerPass,
    });

    await queue.syncRetentionPolicy({
      ...withoutLimits,
      occurrenceRowsPerPass: 1_000_000,
    });
    await expect(
      pool.query("SELECT workhorse.prune_schedule_occurrences_v1(clock_timestamp(), 1000000)"),
    ).resolves.toMatchObject({ rows: [{ prune_schedule_occurrences_v1: 0 }] });
  });

  it("synchronizes queue-scoped concurrency policies as desired state", async () => {
    const policies = await queue.syncConcurrencyPolicies("deployment-a", [
      { queue: "mail", maxActive: 8, maxActivePerKey: 2 },
      { queue: "reports", maxActive: 3 },
    ]);
    expect(policies).toEqual([
      {
        namespace: "deployment-a",
        queue: "mail",
        maxActive: 8,
        maxActivePerKey: 2,
        updatedAt: expect.any(Date),
      },
      {
        namespace: "deployment-a",
        queue: "reports",
        maxActive: 3,
        maxActivePerKey: null,
        updatedAt: expect.any(Date),
      },
    ]);

    await expect(
      queue.syncConcurrencyPolicies("deployment-a", [
        { queue: "mail", maxActive: 1, maxActivePerKey: 2 },
      ]),
    ).rejects.toThrow(/max_active_per_key/);
    await expect(
      queue.syncConcurrencyPolicies("deployment-b", [{ queue: "mail", maxActive: 4 }]),
    ).rejects.toThrow(/owned by another namespace/);

    await queue.syncConcurrencyPolicies("deployment-a", [{ queue: "mail", maxActive: 5 }]);
    await expect(queue.listConcurrencyPolicies()).resolves.toMatchObject([
      { queue: "mail", maxActive: 5, maxActivePerKey: null },
    ]);
    // The deprecated alias stays for the rest of 0.x and reads through the new method.
    await expect(queue.concurrencyPolicies()).resolves.toEqual(
      await queue.listConcurrencyPolicies(),
    );
  });

  it("reports bounded concurrency utilization and blocked-ready depth through health", async () => {
    const queueName = `health-concurrency-${randomUUID()}`;
    await queue.syncConcurrencyPolicies("health-test", [
      { queue: queueName, maxActive: 1, maxActivePerKey: 1 },
    ]);
    await queue.enqueue("health-concurrency", {}, { queue: queueName, concurrencyKey: "tenant" });
    await queue.enqueue("health-concurrency", {}, { queue: queueName, concurrencyKey: "tenant" });
    await queue.claim("health-concurrency-worker", { queue: queueName });

    const health = await queue.health();
    expect(health.concurrencyPolicies).toMatchObject({
      capped: false,
      policies: [
        {
          namespace: "health-test",
          queue: queueName,
          maxActive: 1,
          active: 1,
          available: 0,
          blockedReady: 1,
          maxActivePerKey: 1,
          saturatedKeys: 1,
          highestKeyActive: 1,
        },
      ],
    });
    await expect(queue.queueMetricSnapshot()).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          queue: queueName,
          concurrencyLimit: 1,
          concurrencyActive: 1,
          blockedReadyDepth: 1,
        }),
      ]),
    );
  });

  it("excludes keyless capacity from the highest keyed utilization summary", async () => {
    const queueName = `health-keyless-concurrency-${randomUUID()}`;
    await queue.syncConcurrencyPolicies("health-keyless-test", [
      { queue: queueName, maxActive: 3, maxActivePerKey: 2 },
    ]);
    await queue.enqueue("health-concurrency", {}, { queue: queueName });
    await queue.enqueue("health-concurrency", {}, { queue: queueName });
    await queue.enqueue("health-concurrency", {}, { queue: queueName, concurrencyKey: "tenant" });
    await queue.claim("health-keyless-a", { queue: queueName });
    await queue.claim("health-keyless-b", { queue: queueName });
    await queue.claim("health-keyed", { queue: queueName });

    expect((await queue.health()).concurrencyPolicies.policies).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ queue: queueName, active: 3, highestKeyActive: 1 }),
      ]),
    );
  });

  it("preserves daily completion on identical retention policy sync and invalidates changed windows", async () => {
    await pool.query(`
      UPDATE workhorse.maintenance_state
         SET last_completed_local_date = '2026-08-02'
       WHERE routine_name = 'history_retention'`);

    await queue.syncRetentionPolicy(defaultRetentionPolicy);
    expect(
      (
        await pool.query<{ completed: string | null }>(`
          SELECT last_completed_local_date::text AS completed
            FROM workhorse.maintenance_state
           WHERE routine_name = 'history_retention'`)
      ).rows[0]?.completed,
    ).toBe("2026-08-02");

    await queue.syncRetentionPolicy({
      ...defaultRetentionPolicy,
      scheduleOccurrenceRetentionDays: 13,
    });
    expect(
      (
        await pool.query<{ completed: string | null }>(`
          SELECT last_completed_local_date::text AS completed
            FROM workhorse.maintenance_state
           WHERE routine_name = 'history_retention'`)
      ).rows[0]?.completed,
    ).toBeNull();
  });

  it("retires event and attempt partitions independently and bounds partition/default work", async () => {
    const firstDay = "2018-01-01";
    const secondDay = "2018-01-02";
    for (const day of [firstDay, secondDay]) {
      await pool.query("SELECT workhorse.retire_history_day_v1($1)", [day]);
      await pool.query("SELECT workhorse.create_history_day_v1($1)", [day]);
    }
    await queue.syncRetentionPolicy({
      ...defaultRetentionPolicy,
      taskIdentityRetentionDays: 36_500,
      terminalOutcomeRetentionDays: 36_500,
      taskEventRetentionDays: 1,
      attemptHistoryRetentionDays: 36_500,
      scheduleOccurrenceRetentionDays: 36_500,
      historyPartitionsPerPass: 1,
    });

    const firstPass = await queue.retainHistory({ force: true });
    expect(firstPass[0]).toMatchObject({
      phase: "event_retention",
      rowsAffected: 1,
      error: null,
    });
    expect(firstPass[1]).toMatchObject({
      phase: "attempt_retention",
      rowsAffected: 0,
      error: null,
    });
    expect(
      (
        await pool.query(
          `SELECT to_regclass('workhorse.task_event_20180101') AS first_event,
                  to_regclass('workhorse.task_event_20180102') AS second_event,
                  to_regclass('workhorse.attempt_history_20180101') AS first_attempt,
                  to_regclass('workhorse.attempt_history_20180102') AS second_attempt`,
        )
      ).rows[0],
    ).toEqual({
      first_event: null,
      second_event: "task_event_20180102",
      first_attempt: "attempt_history_20180101",
      second_attempt: "attempt_history_20180102",
    });

    await pool.query(`
      WITH identities AS (
        INSERT INTO workhorse.task(queue_name, task_type, payload, max_attempts, created_at)
        SELECT 'default', 'old-event', '{}'::jsonb, 1, '2017-01-01'::timestamptz
          FROM generate_series(1, 3)
        RETURNING id
      )
      INSERT INTO workhorse.task_event(task_id, event_type, occurred_at)
      SELECT id, 'old-default', '2017-01-01'::timestamptz FROM identities`);
    await pool.query(`
      WITH identities AS (
        INSERT INTO workhorse.task(queue_name, task_type, payload, max_attempts, created_at)
        SELECT 'default', 'old-attempt', '{}'::jsonb, 1, '2017-01-01'::timestamptz
          FROM generate_series(1, 3)
        RETURNING id
      )
      INSERT INTO workhorse.attempt_history(
        task_id, attempt, fence_token, worker_id, outcome, started_at, claimed_at, occurred_at
      )
      SELECT id, 1, 1, 'retention-worker', 'succeeded',
             '2017-01-01'::timestamptz, '2017-01-01'::timestamptz, '2017-01-01'::timestamptz
        FROM identities`);
    await queue.syncRetentionPolicy({
      ...defaultRetentionPolicy,
      taskEventRetentionDays: 1,
      attemptHistoryRetentionDays: 1,
      historyPartitionsPerPass: 1,
      defaultPartitionRowsPerPass: 2,
    });
    const boundedPass = await queue.retainHistory({ force: true });
    expect(boundedPass[0]).toMatchObject({ phase: "event_retention", rowsAffected: 3 });
    expect(boundedPass[1]).toMatchObject({ phase: "attempt_retention", rowsAffected: 3 });
    expect(
      (
        await pool.query(`SELECT
          (SELECT count(*)::integer FROM workhorse.task_event_default) AS events,
          (SELECT count(*)::integer FROM workhorse.attempt_history_default) AS attempts`)
      ).rows[0],
    ).toEqual({ events: 1, attempts: 1 });
  });

  it("deletes only safely unattributed terminal tasks and never live tasks", async () => {
    const finish = async (type: string) => {
      const id = await queue.enqueue(type, {});
      const task = await queue.claim("retention-worker");
      expect(task?.id).toBe(id);
      expect(await queue.complete(task!, "retention-worker", { done: true })).toBe(true);
      await pool.query(
        `UPDATE workhorse.task
            SET created_at = clock_timestamp() - interval '40 days' WHERE id = $1`,
        [id],
      );
      await pool.query(
        `UPDATE workhorse.task_event
            SET occurred_at = clock_timestamp() - interval '40 days' WHERE task_id = $1`,
        [id],
      );
      await pool.query(
        `UPDATE workhorse.attempt_history
            SET started_at = clock_timestamp() - interval '40 days',
                claimed_at = clock_timestamp() - interval '40 days',
                finished_at = clock_timestamp() - interval '40 days',
                occurred_at = clock_timestamp() - interval '40 days'
          WHERE task_id = $1`,
        [id],
      );
      await pool.query(
        `UPDATE workhorse.task_outcome
            SET finished_at = clock_timestamp() - interval '40 days',
                history_through_at = clock_timestamp() - interval '40 days'
          WHERE task_id = $1`,
        [id],
      );
      return id;
    };

    const deletable = await finish("deletable");
    const secondDeletable = await finish("second-deletable");
    await pool.query(
      `UPDATE workhorse.task_outcome
          SET finished_at = clock_timestamp() - interval '39 days' WHERE task_id = $1`,
      [secondDeletable],
    );
    const eventGuard = await finish("event-guard");
    const attemptGuard = await finish("attempt-guard");
    const occurrenceGuard = await finish("occurrence-guard");
    const recentOutcome = await finish("recent-outcome");
    const live = await queue.enqueue("live", {});
    await pool.query(
      `UPDATE workhorse.task SET created_at = clock_timestamp() - interval '40 days' WHERE id = $1`,
      [live],
    );

    await pool.query("DELETE FROM workhorse.task_event WHERE task_id = ANY($1::uuid[])", [
      [deletable, secondDeletable, attemptGuard, occurrenceGuard, recentOutcome],
    ]);
    await pool.query("DELETE FROM workhorse.attempt_history WHERE task_id = ANY($1::uuid[])", [
      [deletable, secondDeletable, eventGuard, occurrenceGuard, recentOutcome],
    ]);
    await pool.query(
      `INSERT INTO workhorse.task_event(task_id, event_type) VALUES ($1, 'late-retained')`,
      [eventGuard],
    );
    await pool.query(
      `INSERT INTO workhorse.attempt_history(
         task_id, attempt, fence_token, worker_id, outcome, started_at, claimed_at
       ) VALUES ($1, 2, 2, 'late-retention-worker', 'succeeded', clock_timestamp(), clock_timestamp())`,
      [attemptGuard],
    );
    await pool.query(
      `UPDATE workhorse.task_outcome SET finished_at = clock_timestamp() WHERE task_id = $1`,
      [recentOutcome],
    );
    await pool.query(
      `INSERT INTO workhorse.task_checkpoint(
         task_id, checkpoint_name, checkpoint_value, attempt, fence_token, worker_id
       ) VALUES ($1, 'retained-until-delete', '{}'::jsonb, 1, 1, 'retention-worker')`,
      [deletable],
    );
    await pool.query(
      `INSERT INTO workhorse.schedule_definition(
         namespace, schedule_name, cron_expression, queue_name, task_type, payload, max_attempts
       ) VALUES ('retention', 'guard', '0 * * * *', 'default', 'guard', '{}'::jsonb, 1)`,
    );
    await pool.query(
      `INSERT INTO workhorse.schedule_occurrence(namespace, schedule_name, occurrence_at, task_id)
       VALUES ('retention', 'guard', clock_timestamp(), $1)`,
      [occurrenceGuard],
    );
    await queue.syncRetentionPolicy({
      ...defaultRetentionPolicy,
      taskIdentityRetentionDays: 30,
      terminalOutcomeRetentionDays: 30,
      taskEventRetentionDays: 30,
      attemptHistoryRetentionDays: 30,
      scheduleOccurrenceRetentionDays: 30,
      terminalTaskPruneLimit: 1,
    });
    expect(await queue.retainHistory({ force: true })).toHaveLength(3);

    expect(
      (await queue.pruneTerminalStorage({ force: true })).find(
        ({ phase }) => phase === "terminal_tasks",
      ),
    ).toMatchObject({
      phase: "terminal_tasks",
      rowsAffected: 1,
      error: null,
    });
    expect(await admin.getTask(deletable)).toBeNull();
    expect(
      (
        await pool.query(
          "SELECT count(*)::integer AS count FROM workhorse.task_checkpoint WHERE task_id = $1",
          [deletable],
        )
      ).rows[0]?.count,
    ).toBe(0);
    expect(await admin.getTask(secondDeletable)).not.toBeNull();
    expect(
      (await queue.pruneTerminalStorage({ force: true })).find(
        ({ phase }) => phase === "terminal_tasks",
      ),
    ).toMatchObject({
      phase: "terminal_tasks",
      rowsAffected: 1,
      error: null,
    });
    expect(await admin.getTask(secondDeletable)).toBeNull();
    for (const retained of [eventGuard, attemptGuard, occurrenceGuard, recentOutcome, live]) {
      expect(await admin.getTask(retained)).not.toBeNull();
    }
  });

  it("cleans expired enqueue keys before terminal identity pruning in the same pass", async () => {
    const finishKeyed = async (key: string, ttlMs: number) => {
      const id = await queue.enqueue(
        "idempotency-retention",
        {},
        {
          idempotency: { key, ttlMs },
        },
      );
      const task = await queue.claim(`retention-${key}`);
      expect(task?.id).toBe(id);
      expect(await queue.complete(task!, `retention-${key}`, { done: true })).toBe(true);
      await pool.query("DELETE FROM workhorse.task_event WHERE task_id = $1", [id]);
      await pool.query("DELETE FROM workhorse.attempt_history WHERE task_id = $1", [id]);
      await pool.query(
        `UPDATE workhorse.task SET created_at = clock_timestamp() - interval '40 days' WHERE id = $1`,
        [id],
      );
      await pool.query(
        `UPDATE workhorse.task_outcome
            SET finished_at = clock_timestamp() - interval '40 days',
                history_through_at = clock_timestamp() - interval '40 days'
          WHERE task_id = $1`,
        [id],
      );
      return id;
    };

    const expired = await finishKeyed("expired-cleanup", 5);
    const retained = await finishKeyed("retained-cleanup", 60_000);
    await sleep(15);
    await queue.syncRetentionPolicy({
      ...defaultRetentionPolicy,
      taskIdentityRetentionDays: 30,
      terminalOutcomeRetentionDays: 30,
      taskEventRetentionDays: 30,
      attemptHistoryRetentionDays: 30,
      scheduleOccurrenceRetentionDays: 30,
      terminalTaskPruneLimit: 10,
    });

    const phases = await queue.pruneTerminalStorage({ force: true });
    expect(phases[0]).toMatchObject({
      phase: "enqueue_idempotency",
      rowsAffected: 1,
      error: null,
    });
    expect(phases[1]).toMatchObject({
      phase: "released_dependencies",
      rowsAffected: 0,
      error: null,
    });
    expect(phases[2]).toMatchObject({ phase: "terminal_tasks", rowsAffected: 1, error: null });
    expect(await admin.getTask(expired)).toBeNull();
    expect(await admin.getTask(retained)).not.toBeNull();
    expect(
      (await pool.query("SELECT task_id FROM workhorse.enqueue_idempotency ORDER BY task_id")).rows,
    ).toEqual([{ task_id: retained }]);
  });

  it("retains signal and human-wait evidence until the terminal outcome is also eligible", async () => {
    const id = await queue.enqueue("wait-retention", {});
    const worker = new Worker(queue, { workerId: "wait-retention-worker" }).handle(
      "wait-retention",
      async (_payload, context) => {
        await context.waitForSignal("signal");
        return context.waitForHuman("decision", { prompt: "Continue?" });
      },
    );
    expect(await worker.runOnce()).toBe(true);
    await queue.sendSignal(
      id,
      "signal",
      { received: true },
      { idempotencyKey: "signal", requestedBy: "service" },
    );
    expect(await worker.runOnce()).toBe(true);
    await queue.completeHumanWait(
      id,
      "decision",
      { approved: true },
      { idempotencyKey: "decision", requestedBy: "operator" },
    );
    expect(await worker.runOnce()).toBe(true);

    await pool.query("DELETE FROM workhorse.task_event WHERE task_id = $1", [id]);
    await pool.query("DELETE FROM workhorse.attempt_history WHERE task_id = $1", [id]);
    await pool.query(
      `UPDATE workhorse.task
          SET created_at = clock_timestamp() - interval '40 days' WHERE id = $1`,
      [id],
    );
    await queue.syncRetentionPolicy({
      ...defaultRetentionPolicy,
      taskIdentityRetentionDays: 30,
      terminalOutcomeRetentionDays: 30,
      taskEventRetentionDays: 30,
      attemptHistoryRetentionDays: 30,
      scheduleOccurrenceRetentionDays: 30,
    });

    expect(
      (await queue.pruneTerminalStorage({ force: true })).find(
        ({ phase }) => phase === "terminal_tasks",
      ),
    ).toMatchObject({
      phase: "terminal_tasks",
      rowsAffected: 0,
    });
    await expect(
      pool.query(
        `SELECT
           (SELECT count(*)::integer FROM workhorse.task_signal_wait WHERE task_id = $1) AS signals,
           (SELECT count(*)::integer FROM workhorse.task_human_wait WHERE task_id = $1) AS humans`,
        [id],
      ),
    ).resolves.toMatchObject({ rows: [{ signals: 1, humans: 1 }] });

    await pool.query(
      `UPDATE workhorse.task_outcome
          SET finished_at = clock_timestamp() - interval '40 days',
              history_through_at = clock_timestamp() - interval '40 days'
        WHERE task_id = $1`,
      [id],
    );
    expect(
      (await queue.pruneTerminalStorage({ force: true })).find(
        ({ phase }) => phase === "terminal_tasks",
      ),
    ).toMatchObject({
      phase: "terminal_tasks",
      rowsAffected: 1,
    });
    await expect(admin.getTask(id)).resolves.toBeNull();
  });

  it("serializes terminal deletion with concurrent history insertion", async () => {
    const id = await queue.enqueue("retention-race", {});
    const task = await queue.claim("retention-race-worker");
    expect(task?.id).toBe(id);
    expect(await queue.complete(task!, "retention-race-worker", { done: true })).toBe(true);
    await pool.query("DELETE FROM workhorse.task_event WHERE task_id = $1", [id]);
    await pool.query("DELETE FROM workhorse.attempt_history WHERE task_id = $1", [id]);
    await pool.query(
      `UPDATE workhorse.task
          SET created_at = clock_timestamp() - interval '40 days' WHERE id = $1`,
      [id],
    );
    await pool.query(
      `UPDATE workhorse.task_outcome
          SET finished_at = clock_timestamp() - interval '40 days',
              history_through_at = clock_timestamp() - interval '40 days'
        WHERE task_id = $1`,
      [id],
    );

    const deleting = await pool.connect();
    const inserting = await pool.connect();
    try {
      await deleting.query("BEGIN");
      await expect(
        deleting.query(
          `SELECT workhorse.prune_terminal_tasks_v1(
             clock_timestamp() - interval '30 days',
             clock_timestamp() - interval '30 days',
             date_trunc('day', clock_timestamp() - interval '30 days'), 1
           ) AS pruned`,
        ),
      ).resolves.toMatchObject({ rows: [{ pruned: 1 }] });

      const insert = inserting
        .query(`INSERT INTO workhorse.task_event(task_id, event_type) VALUES ($1, 'concurrent')`, [
          id,
        ])
        .catch((error: unknown) => error);
      await sleep(25);
      await deleting.query("COMMIT");
      await expect(insert).resolves.toMatchObject({ code: "23503" });
    } finally {
      await deleting.query("ROLLBACK").catch(() => undefined);
      deleting.release();
      inserting.release();
    }
    await expect(admin.getTask(id)).resolves.toBeNull();
    expect(
      (
        await pool.query(
          "SELECT count(*)::integer AS count FROM workhorse.task_event WHERE task_id = $1",
          [id],
        )
      ).rows[0]?.count,
    ).toBe(0);
  });

  it("reports retention boundaries, lag, eligible partitions, and exact default counts", async () => {
    const oldDay = "2016-01-04";
    await pool.query("SELECT workhorse.retire_history_day_v1($1)", [oldDay]);
    await pool.query("SELECT workhorse.create_history_day_v1($1)", [oldDay]);
    await pool.query(`
      WITH identities AS (
        INSERT INTO workhorse.task(queue_name, task_type, payload, max_attempts, created_at)
        VALUES ('default', 'health-event', '{}'::jsonb, 1, '2015-01-01'),
               ('default', 'health-attempt', '{}'::jsonb, 1, '2015-01-01')
        RETURNING id, task_type
      )
      INSERT INTO workhorse.task_event(task_id, event_type, occurred_at)
      SELECT id, 'old-default', '2015-01-01' FROM identities WHERE task_type = 'health-event';
      WITH identity AS (
        SELECT id FROM workhorse.task WHERE task_type = 'health-attempt'
      )
      INSERT INTO workhorse.attempt_history(
        task_id, attempt, fence_token, worker_id, outcome, started_at, claimed_at, occurred_at
      ) SELECT id, 1, 1, 'health-worker', 'succeeded', '2015-01-01', '2015-01-01',
               '2015-01-01' FROM identity`);
    await queue.syncRetentionPolicy({
      ...defaultRetentionPolicy,
      taskIdentityRetentionDays: 30,
      taskEventRetentionDays: 30,
      attemptHistoryRetentionDays: 30,
    });

    const health = await queue.health();
    expect(health.retentionPolicy).toMatchObject({
      taskEventRetentionDays: 30,
      attemptHistoryRetentionDays: 30,
    });
    expect(health.oldestRetainedAt.taskEvents?.toISOString().slice(0, 10)).toBe("2015-01-01");
    expect(health.oldestRetainedAt.attemptHistory?.toISOString().slice(0, 10)).toBe("2015-01-01");
    expect(health.retentionLagMs.taskEvents).toBeGreaterThan(0);
    expect(health.retentionLagMs.attemptHistory).toBeGreaterThan(0);
    expect(health.eligibleHistoryPartitions).toMatchObject({ taskEvents: 1, attemptHistory: 1 });
    expect(health.defaultHistoryRows).toEqual({ taskEvents: 1, attemptHistory: 1 });
    expect(health.defaultHistoryRowsCapped).toEqual({ taskEvents: false, attemptHistory: false });

    const zonedClient = await pool.connect();
    try {
      await zonedClient.query("SET TIME ZONE 'Pacific/Kiritimati'");
      const zonedHealth = await new Queue(zonedClient).health();
      expect(zonedHealth.eligibleHistoryPartitions).toEqual(health.eligibleHistoryPartitions);
      // A broken session-timezone dependency would shift the day-boundary lag by hours; the
      // tolerance only needs to absorb the wall-clock between two consecutive snapshots.
      expect(zonedHealth.retentionLagMs.taskEvents).toBeCloseTo(
        health.retentionLagMs.taskEvents!,
        -4,
      );
      expect(zonedHealth.retentionLagMs.attemptHistory).toBeCloseTo(
        health.retentionLagMs.attemptHistory!,
        -4,
      );
    } finally {
      await zonedClient.query("RESET TIME ZONE");
      zonedClient.release();
    }
  });

  it("caps fallback-row health scans and marks the reported lower bound", async () => {
    await pool.query(`
      WITH identities AS (
        INSERT INTO workhorse.task(queue_name, task_type, payload, max_attempts, created_at)
        SELECT 'default', 'health-cap', '{}'::jsonb, 1, '2001-01-01'::timestamptz
          FROM generate_series(1, 10002)
        RETURNING id
      )
      INSERT INTO workhorse.task_event(task_id, event_type, occurred_at)
      SELECT id, 'health-cap', '2001-01-01'::timestamptz FROM identities`);

    const health = await queue.health();
    expect(health.defaultHistoryRows.taskEvents).toBe(10_001);
    expect(health.defaultHistoryRowsCapped.taskEvents).toBe(true);
    expect(health.defaultHistoryRows.attemptHistory).toBe(0);
    expect(health.defaultHistoryRowsCapped.attemptHistory).toBe(false);
  });

  it("computes identity lag from terminal tasks and ignores a partial history boundary day", async () => {
    await queue.enqueue("live-boundary", {});
    const boundary = await pool.query<{ day_start: string }>(
      `SELECT ((clock_timestamp() AT TIME ZONE 'UTC')::date - 30)::text AS day_start`,
    );
    await pool.query("SELECT workhorse.create_history_day_v1($1)", [boundary.rows[0]!.day_start]);
    const partialBoundaryTask = await queue.enqueue("partial-boundary", {});
    await pool.query(
      `INSERT INTO workhorse.task_event(task_id, event_type, occurred_at)
       VALUES (
         $1, 'partial-boundary',
         (
           ((clock_timestamp() AT TIME ZONE 'UTC')::date - 30)::timestamp
           + interval '12 hours'
         ) AT TIME ZONE 'UTC'
       )`,
      [partialBoundaryTask],
    );
    await queue.syncRetentionPolicy({
      ...defaultRetentionPolicy,
      taskIdentityRetentionDays: 30,
      taskEventRetentionDays: 30,
    });

    const health = await queue.health();
    expect(health.oldestRetainedAt.taskIdentity).toBeNull();
    expect(health.retentionLagMs.taskEvents).toBe(0);
  });

  it("does not report terminal outcome lag before the identity anchor is eligible", async () => {
    const id = await queue.enqueue("terminal-lag-gates", {});
    const task = await queue.claim("retention-health-worker");
    expect(task?.id).toBe(id);
    expect(await queue.complete(task!, "retention-health-worker", { done: true })).toBe(true);
    await pool.query(
      `UPDATE workhorse.task
          SET created_at = clock_timestamp() - interval '30 days' WHERE id = $1`,
      [id],
    );
    await pool.query(
      `UPDATE workhorse.task_outcome
          SET finished_at = clock_timestamp() - interval '30 days' WHERE task_id = $1`,
      [id],
    );
    await queue.syncRetentionPolicy({
      taskIdentityRetentionDays: 365,
      terminalOutcomeRetentionDays: 1,
      taskEventRetentionDays: 365,
      attemptHistoryRetentionDays: 365,
      scheduleOccurrenceRetentionDays: 365,
      statisticsRetentionDays: 365,
    });

    const protectedHealth = await queue.health();
    expect(protectedHealth.oldestRetainedAt.terminalOutcome).not.toBeNull();
    expect(protectedHealth.retentionLagMs.taskIdentity).toBeNull();
    expect(protectedHealth.retentionLagMs.terminalOutcome).toBeNull();

    await queue.syncRetentionPolicy({
      taskIdentityRetentionDays: 1,
      terminalOutcomeRetentionDays: 1,
      taskEventRetentionDays: 1,
      attemptHistoryRetentionDays: 1,
      scheduleOccurrenceRetentionDays: 1,
      statisticsRetentionDays: 1,
    });
    const eligible = await queue.health();
    expect(eligible.retentionLagMs.taskIdentity).toBeGreaterThan(0);
    expect(eligible.retentionLagMs.terminalOutcome).toBeGreaterThan(0);
  });

  it("creates and retires completed daily history partitions", async () => {
    const oldDay = "2020-01-08";
    const historicalTimestamp = "2020-01-08T12:00:00.000Z";
    const historicalTaskId = "00000000-0000-4000-8000-000000000001";
    await pool.query(
      `INSERT INTO workhorse.task(id, queue_name, task_type, payload, max_attempts, created_at)
       VALUES ($1, 'default', 'historical', '{}'::jsonb, 1, $2)`,
      [historicalTaskId, historicalTimestamp],
    );
    await pool.query(
      `INSERT INTO workhorse.task_event(task_id, event_type, occurred_at)
       VALUES ($1, 'fallback', $2)`,
      [historicalTaskId, historicalTimestamp],
    );
    await pool.query(
      `INSERT INTO workhorse.attempt_history(
         task_id, attempt, fence_token, worker_id, outcome, started_at, claimed_at,
         finished_at, occurred_at
       ) VALUES ($1, 1, 1, 'fallback-worker', 'succeeded', $2, $2, $2, $2)`,
      [historicalTaskId, historicalTimestamp],
    );
    const fallbackRelations = await pool.query<{ relation: string }>(
      `
      SELECT tableoid::regclass::text AS relation FROM workhorse.task_event WHERE task_id = $1
      UNION ALL
      SELECT tableoid::regclass::text FROM workhorse.attempt_history WHERE task_id = $1
      ORDER BY relation`,
      [historicalTaskId],
    );
    expect(fallbackRelations.rows).toEqual([
      { relation: "attempt_history_default" },
      { relation: "task_event_default" },
    ]);
    const fallbackIdentities = (
      await pool.query<{ event_id: string; attempt_id: string }>(
        `SELECT event.event_id::text, history.attempt_id::text
           FROM workhorse.task_event event
           JOIN workhorse.attempt_history history USING (task_id)
          WHERE event.task_id = $1`,
        [historicalTaskId],
      )
    ).rows[0];

    await pool.query("SELECT workhorse.create_history_day_v1($1)", [oldDay]);
    expect(
      (await pool.query("SELECT to_regclass('workhorse.task_event_20200108') AS relation")).rows[0]
        .relation,
    ).not.toBeNull();
    expect(
      (await pool.query("SELECT to_regclass('workhorse.attempt_history_20200108') AS relation"))
        .rows[0].relation,
    ).not.toBeNull();
    const migratedRelations = await pool.query<{ relation: string }>(
      `
      SELECT tableoid::regclass::text AS relation FROM workhorse.task_event WHERE task_id = $1
      UNION ALL
      SELECT tableoid::regclass::text FROM workhorse.attempt_history WHERE task_id = $1
      ORDER BY relation`,
      [historicalTaskId],
    );
    expect(migratedRelations.rows).toEqual([
      { relation: "attempt_history_20200108" },
      { relation: "task_event_20200108" },
    ]);
    expect(
      (
        await pool.query<{ event_id: string; attempt_id: string }>(
          `SELECT event.event_id::text, history.attempt_id::text
             FROM workhorse.task_event event
             JOIN workhorse.attempt_history history USING (task_id)
            WHERE event.task_id = $1`,
          [historicalTaskId],
        )
      ).rows[0],
    ).toEqual(fallbackIdentities);
    await pool.query("SELECT workhorse.retire_history_day_v1($1)", [oldDay]);
    expect(
      (await pool.query("SELECT to_regclass('workhorse.task_event_20200108') AS relation")).rows[0]
        .relation,
    ).toBeNull();
    await expect(
      pool.query(
        "SELECT workhorse.retire_history_day_v1((clock_timestamp() AT TIME ZONE 'UTC')::date)",
      ),
    ).rejects.toThrow(/only completed history days can be retired/);
  });

  it("creates a history partition without deadlocking a concurrent retry transition", async () => {
    const gate = await pool.connect();
    const observer = await pool.connect();
    const futureDay = "2098-08-10";
    const lockKey = "workhorse:test:history-partition-transition";
    const id = await queue.enqueue("partition-transition", {}, { maxAttempts: 2 });
    const task = await queue.claim("partition-transition-worker");
    expect(task?.id).toBe(id);

    try {
      await pool.query(`
        CREATE OR REPLACE FUNCTION workhorse.test_pause_attempt_history_insert()
        RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          PERFORM pg_advisory_xact_lock(
            hashtextextended('workhorse:test:history-partition-transition', 0)
          );
          RETURN NEW;
        END;
        $$;
        CREATE TRIGGER test_pause_attempt_history_insert
        BEFORE INSERT ON workhorse.attempt_history
        FOR EACH ROW EXECUTE FUNCTION workhorse.test_pause_attempt_history_insert();
      `);
      await gate.query("SELECT pg_advisory_lock(hashtextextended($1, 0))", [lockKey]);

      const failing = queue.fail(
        task!,
        "partition-transition-worker",
        new Error("expected retry"),
        0,
      );
      await waitForDatabaseCondition(async () => {
        const result = await observer.query<{ waiting: boolean }>(`
          SELECT EXISTS (
            SELECT 1 FROM pg_stat_activity
             WHERE datid = (SELECT oid FROM pg_database WHERE datname = current_database())
               AND wait_event_type = 'Lock'
               AND query LIKE 'SELECT workhorse.fail_v1%'
          ) AS waiting`);
        return result.rows[0]!.waiting;
      });

      const partitioning = pool.query("SELECT workhorse.create_history_day_v1($1)", [futureDay]);
      await waitForDatabaseCondition(async () => {
        const result = await observer.query<{ waiting: boolean }>(`
          SELECT EXISTS (
            SELECT 1 FROM pg_locks
             WHERE relation = 'workhorse.attempt_history'::regclass
               AND mode = 'AccessExclusiveLock'
               AND NOT granted
          ) AS waiting`);
        return result.rows[0]!.waiting;
      });

      await gate.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [lockKey]);
      expect(await Promise.allSettled([failing, partitioning])).toEqual([
        expect.objectContaining({ status: "fulfilled", value: "ready" }),
        expect.objectContaining({ status: "fulfilled" }),
      ]);
    } finally {
      await gate.query("SELECT pg_advisory_unlock_all()").catch(() => undefined);
      gate.release();
      observer.release();
      await pool.query(
        "DROP TRIGGER IF EXISTS test_pause_attempt_history_insert ON workhorse.attempt_history",
      );
      await pool.query("DROP FUNCTION IF EXISTS workhorse.test_pause_attempt_history_insert()");
      await pool.query("DROP TABLE IF EXISTS workhorse.task_event_20980810");
      await pool.query("DROP TABLE IF EXISTS workhorse.attempt_history_20980810");
    }
  });

  it("replenishes the three-day history partition horizon during partition preparation", async () => {
    await pool.query(`
      DO $$
      DECLARE day_offset integer;
      DECLARE suffix text;
      BEGIN
        FOR day_offset IN 2..3 LOOP
          suffix := to_char(
            (clock_timestamp() AT TIME ZONE 'UTC')::date + day_offset,
            'YYYYMMDD'
          );
          EXECUTE format('DROP TABLE workhorse.%I', 'task_event_' || suffix);
          EXECUTE format('DROP TABLE workhorse.%I', 'attempt_history_' || suffix);
        END LOOP;
      END
      $$`);
    expect(await queue.prepareHistoryPartitions({ force: true })).toMatchObject([
      { phase: "history_partitions", rowsAffected: 2, skippedLock: false, error: null },
    ]);
    const horizon = await pool.query<{ missing: number }>(`
      SELECT count(*) FILTER (
               WHERE to_regclass(format('workhorse.%I', 'task_event_' || suffix)) IS NULL
                  OR to_regclass(format('workhorse.%I', 'attempt_history_' || suffix)) IS NULL
             )::integer AS missing
        FROM (
          SELECT to_char(
                   (clock_timestamp() AT TIME ZONE 'UTC')::date + day_offset,
                   'YYYYMMDD'
                 ) AS suffix
            FROM generate_series(0, 3) AS days(day_offset)
        ) expected`);
    expect(horizon.rows[0]?.missing).toBe(0);
  });

  it("repairs a partially missing daily history partition", async () => {
    const day = "2021-02-01";
    await pool.query("SELECT workhorse.retire_history_day_v1($1)", [day]);
    await pool.query("SELECT workhorse.create_history_day_v1($1)", [day]);
    await pool.query("DROP TABLE workhorse.attempt_history_20210201");

    await expect(
      pool.query("SELECT workhorse.create_history_day_v1($1)", [day]),
    ).resolves.toBeDefined();
    expect(
      (
        await pool.query(
          `SELECT to_regclass('workhorse.task_event_20210201') IS NOT NULL AS event_exists,
                  to_regclass('workhorse.attempt_history_20210201') IS NOT NULL AS attempt_exists`,
        )
      ).rows[0],
    ).toEqual({ event_exists: true, attempt_exists: true });
  });

  it("uses one UTC advisory lock key for daily retirement in every session timezone", async () => {
    const day = "2014-03-03";
    await pool.query("SELECT workhorse.create_history_day_v1($1)", [day]);
    const blocker = await pool.connect();
    const zonedClient = await pool.connect();
    try {
      await blocker.query("BEGIN");
      await blocker.query(
        `SELECT pg_advisory_xact_lock(hashtextextended('workhorse:history-day:2014-03-03', 0))`,
      );
      await zonedClient.query("BEGIN");
      await zonedClient.query("SET LOCAL TIME ZONE 'America/Los_Angeles'");
      await expect(
        zonedClient.query(
          "SELECT workhorse.retire_history_partitions_v1('task_event', $1, 1) AS retired",
          ["2014-03-04"],
        ),
      ).resolves.toMatchObject({ rows: [{ retired: 0 }] });
      await zonedClient.query("ROLLBACK");
      await blocker.query("COMMIT");

      await expect(
        pool.query(
          "SELECT workhorse.retire_history_partitions_v1('task_event', $1, 1) AS retired",
          ["2014-03-04"],
        ),
      ).resolves.toMatchObject({ rows: [{ retired: 1 }] });
    } finally {
      await zonedClient.query("ROLLBACK").catch(() => undefined);
      await blocker.query("ROLLBACK").catch(() => undefined);
      zonedClient.release();
      blocker.release();
    }
  });

  it("retires the discovered qualified partition without waiting indefinitely for DDL locks", async () => {
    await pool.query("DROP SCHEMA IF EXISTS retention_external CASCADE");
    await pool.query("CREATE SCHEMA retention_external");
    await pool.query(`
      CREATE TABLE retention_external.task_event_2014w10
        PARTITION OF workhorse.task_event
        FOR VALUES FROM ('2014-03-03') TO ('2014-03-10')`);

    const blocker = await pool.connect();
    try {
      await blocker.query("BEGIN");
      await blocker.query("LOCK TABLE retention_external.task_event_2014w10 IN ACCESS SHARE MODE");
      const startedAt = Date.now();
      await expect(
        pool.query(
          "SELECT workhorse.retire_history_partitions_v1('task_event', $1, 1) AS retired",
          ["2014-03-10"],
        ),
      ).resolves.toMatchObject({ rows: [{ retired: 0 }] });
      expect(Date.now() - startedAt).toBeLessThan(1_500);
      await blocker.query("COMMIT");
    } finally {
      await blocker.query("ROLLBACK").catch(() => undefined);
      blocker.release();
    }

    await expect(
      pool.query("SELECT workhorse.retire_history_partitions_v1('task_event', $1, 1) AS retired", [
        "2014-03-10",
      ]),
    ).resolves.toMatchObject({ rows: [{ retired: 1 }] });
    expect(
      (await pool.query("SELECT to_regclass('retention_external.task_event_2014w10') AS relation"))
        .rows[0]?.relation,
    ).toBeNull();
    await pool.query("DROP SCHEMA retention_external");
  });
});
