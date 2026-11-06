import { beforeAll, describe, expect, it } from "vitest";
import { OBSERVATION_FORMAT } from "../../../scripts/soak/observation.js";
import { collectSoakObservation, observationFileName } from "../../../scripts/soak/observe.js";
import { buildSoakReport } from "../../../scripts/soak/report.js";
import { WORKHORSE_SCHEMA_BASELINE_VERSION, WORKHORSE_SCHEMA_VERSION } from "../src/index.js";
import { PROTOCOL_VERSION } from "../src/schema.js";
import { createIntegrationTestContext } from "./support/integration.js";

const { pool, queue } = createIntegrationTestContext(import.meta.url);

/** Read the PostgreSQL clock, which also dates the partitions and the statistics. */
async function databaseNow(): Promise<Date> {
  const result = await pool.query<{ now: Date }>("SELECT clock_timestamp() AS now");
  return result.rows[0]!.now;
}

const dayMs = 86_400_000;

function utcDayOf(instant: Date | string | number): string {
  return new Date(instant).toISOString().slice(0, 10);
}

/**
 * The UTC days from the day of `before` through the day of `after`. Both are reads of the
 * PostgreSQL clock around one operation. This is one day, unless a UTC midnight fell between the
 * reads. Only then can the operation see either day.
 */
function daysBetween(before: Date | string, after: Date | string): string[] {
  const days: string[] = [];
  const last = Date.parse(`${utcDayOf(after)}T00:00:00Z`);
  for (let day = Date.parse(`${utcDayOf(before)}T00:00:00Z`); day <= last; day += dayMs) {
    days.push(utcDayOf(day));
  }
  return days;
}

/** The observation read the clock between `before` and `after`, as each collection must. */
function expectObservedBetween(observation: { observedAt: string }, before: Date, after: Date) {
  expect(Date.parse(observation.observedAt)).toBeGreaterThanOrEqual(before.getTime());
  expect(Date.parse(observation.observedAt)).toBeLessThanOrEqual(after.getTime());
}

/**
 * The oldest UTC day that a history partition of this file covers. The harness prepares the
 * partitions from the PostgreSQL clock, so the test reads the day from the partition bounds in
 * the catalog. It does not read a clock again, and it does not use the partition names that the
 * collector parses.
 */
let partitionDay: string;

beforeAll(async () => {
  const result = await pool.query<{ day: string }>(
    `SELECT min(
              ((regexp_match(pg_get_expr(child.relpartbound, child.oid),
                             $$FROM \\('([^']+)'\\)$$))[1]::timestamptz
                AT TIME ZONE 'UTC')::date
            )::text AS day
       FROM pg_inherits
       JOIN pg_class AS parent ON parent.oid = pg_inherits.inhparent
       JOIN pg_namespace ON pg_namespace.oid = parent.relnamespace
       JOIN pg_class AS child ON child.oid = pg_inherits.inhrelid
      WHERE pg_namespace.nspname = 'workhorse'
        AND parent.relname IN ('task_event', 'attempt_history')`,
  );
  const day = result.rows[0]?.day;
  if (day === undefined || !/^\d{4}-\d{2}-\d{2}$/.test(day)) {
    throw new Error(`the history partitions have no lower bound: ${String(day)}`);
  }
  partitionDay = day;
});

describe("soak observation collector", () => {
  it("reads a live installation without writing to it", async () => {
    const observation = await collectSoakObservation(pool);

    // Every statement the collector issues runs inside a read-only transaction. Reaching this
    // assertion at all is the evidence: one write would have failed the whole collection.
    expect(observation.format).toBe(OBSERVATION_FORMAT);
    expect(observation.database.name).toMatch(/workhorse/);
    expect(Date.parse(observation.observedAt)).toBeGreaterThan(0);
    expect(observation.installation.schemaVersion).toBe(WORKHORSE_SCHEMA_VERSION);
    expect(observation.installation.protocolVersions).toContain(PROTOCOL_VERSION);
    // A clean installation opens its lineage at the migration baseline, not at version 1: the
    // chain below the baseline was pruned and this installation applied none of it.
    expect(observation.installation.migrations[0]).toMatchObject({
      version: WORKHORSE_SCHEMA_BASELINE_VERSION,
      description: "baseline",
    });
  });

  it("sizes every task_runtime index and records what autovacuum was told", async () => {
    await queue.enqueue("soak-runtime-storage", {});

    const observation = await collectSoakObservation(pool);
    const storage = observation.runtimeStorage;

    // Named rather than counted: a later migration that adds an index should show up here as a
    // new series in the soak report, not as a silently different number.
    const names = storage.indexes.map((index) => index.name);
    expect(names).toContain("task_runtime_pkey");
    expect(names).toContain("task_runtime_ready_idx");
    expect(names).toContain("task_runtime_ready_age_idx");
    // A partial index holding nothing occupies no file at all, so only the two an enqueued task
    // enters are asserted to have a size. The rest are asserted to be sized, not to be non-empty.
    const sized = new Map(storage.indexes.map((index) => [index.name, index.bytes]));
    expect(sized.get("task_runtime_ready_idx")).toBeGreaterThan(0);
    expect(sized.get("task_runtime_pkey")).toBeGreaterThan(0);
    for (const index of storage.indexes) expect(index.bytes).toBeGreaterThanOrEqual(0);
    expect(storage.heapBytes).toBeGreaterThan(0);

    // A soak series is only readable against the settings the installation actually carried while
    // it ran, so the observation records them verbatim rather than assuming the schema's.
    expect(storage.reloptions).toEqual(["fillfactor=70"]);
    expect(storage.autovacuumCount).toBeGreaterThanOrEqual(0);
  });

  it("sees the daily partitions the installation prepared ahead", async () => {
    const before = await databaseNow();
    const observation = await collectSoakObservation(pool);
    const after = await databaseNow();
    expectObservedBetween(observation, before, after);

    // Installation prepares today plus the horizon derived from the preparation cadence, which
    // stays wider than the four days the health snapshot demands.
    const horizon = await pool.query<{ days: number }>(`
        SELECT workhorse.history_partition_horizon_days_v1(
                 policy.partition_preparation_interval_ms
               ) AS days
          FROM workhorse.maintenance_policy policy
         WHERE policy.singleton`);
    const expectedDays = (horizon.rows[0]?.days ?? 0) + 1;
    expect(expectedDays).toBeGreaterThan(4);
    for (const parent of observation.partitions.parents) {
      expect(parent.days).toHaveLength(expectedDays);
      expect(parent.days).toContain(partitionDay);
      expect(parent.defaultRows).toBe(0);
    }
    expect(observation.partitions.oldestSurvivingDay).toBe(partitionDay);
    // The age counts whole days from the partition day to the clock of the observation. In a run
    // on one UTC day, that is 0. A second age is correct only if the clock reads around the
    // collection show a UTC midnight between them.
    const ageOn = (day: string) => (Date.parse(day) - Date.parse(partitionDay)) / dayMs;
    expect(daysBetween(before, after).map(ageOn)).toContain(
      observation.partitions.oldestSurvivingAgeDays,
    );
  });

  it("takes the queue-health snapshot and the live backlog", async () => {
    await queue.enqueue("soak-backlog", {});

    const observation = await collectSoakObservation(pool);

    expect(observation.queueHealth).toMatchObject({
      captured_at: expect.any(String),
      status: { level: expect.any(String) },
    });
    expect(observation.backlog["ready"]).toBeGreaterThanOrEqual(1);
  });

  it("reconciles an ungraceful kill against the attempts its worker lost", async () => {
    const killedAt = new Date().toISOString();
    const workerId = "soak-killed-worker";
    const lost = await queue.enqueue("soak-killed", {});
    const survivor = await queue.enqueue("soak-killed", {});
    expect(await queue.claim(workerId)).toMatchObject({ id: lost });
    expect(await queue.claim(workerId)).toMatchObject({ id: survivor });

    // A SIGKILLed worker acknowledges nothing, so recovery reaches its tasks through lease expiry.
    await pool.query(
      "UPDATE workhorse.task_runtime SET expires_at = clock_timestamp() - interval '1 second'",
    );
    expect(await queue.recoverExpired()).toBe(2);
    const reclaimed = await queue.claim("soak-replacement-worker");
    expect(await queue.complete(reclaimed!, "soak-replacement-worker", null)).toBe(true);

    const observation = await collectSoakObservation(pool, { killWorker: workerId, killedAt });

    expect(observation.killRecovery).toMatchObject({
      workerId,
      leaseExpiredAttempts: 2,
      affectedTasks: 2,
      tasksSettled: 1,
      tasksLive: 1,
      tasksLost: 0,
      tasksSucceededMoreThanOnce: 0,
    });
  });

  it("reports the closed days the daily statistics tier holds", async () => {
    const beforeEnqueue = await databaseNow();
    const taskId = await queue.enqueue("soak-throughput", {});
    const afterEnqueue = await databaseNow();
    const claimed = await queue.claim("soak-throughput-worker");
    expect(claimed?.id).toBe(taskId);
    expect(await queue.complete(claimed!, "soak-throughput-worker", null)).toBe(true);

    // Roll the statistics forward past today so today closes into the daily tier.
    await pool.query(
      `UPDATE workhorse.task_stat_state
          SET rolled_up_through = date_bin('1 day', clock_timestamp(),
                timestamp '2000-01-01' AT TIME ZONE 'UTC'),
              hourly_rolled_up_through = date_bin('1 day', clock_timestamp(),
                timestamp '2000-01-01' AT TIME ZONE 'UTC'),
              daily_rolled_up_through = date_bin('1 day', clock_timestamp(),
                timestamp '2000-01-01' AT TIME ZONE 'UTC')`,
    );
    // One day after the database clock closes the day of the enqueue, whichever day that is.
    const result = await queue.rollupStatistics({
      force: true,
      now: new Date((await databaseNow()).getTime() + 24 * 60 * 60_000),
      maxBuckets: 2 * 24 * 60,
    });
    expect(result.every(({ error }) => error === null)).toBe(true);

    const observation = await collectSoakObservation(pool);

    // The enqueue counts on the UTC day of its database clock. That is one day, unless the clock
    // reads around the enqueue show a UTC midnight between them.
    const enqueueDays = new Set(daysBetween(beforeEnqueue, afterEnqueue));
    const day = observation.throughput.find(
      (entry) => enqueueDays.has(entry.day) && entry.enqueued >= 1,
    );
    expect(day).toMatchObject({ enqueued: expect.any(Number), taskSucceeded: expect.any(Number) });
    expect(day!.enqueued).toBeGreaterThanOrEqual(1);
  });

  it("names an observation file that sorts into observation order", async () => {
    const earlier = await collectSoakObservation(pool);
    const later = await collectSoakObservation(pool);

    expect(observationFileName(earlier) < observationFileName(later)).toBe(true);
    expect(observationFileName(earlier)).toMatch(/^observation-.*\.json$/);
  });

  it("builds a report from observations of the live installation", async () => {
    const before = await databaseNow();
    const observations = [await collectSoakObservation(pool), await collectSoakObservation(pool)];
    const after = await databaseNow();
    for (const observation of observations) expectObservedBetween(observation, before, after);

    const report = buildSoakReport(observations);

    expect(report.observations).toBe(2);
    expect(report.installation.reinstalls).toEqual([]);
    // Each day from the first to the last observation held a partition. In a run on one UTC day,
    // that is the day of both clock reads. Two days are correct only if a UTC midnight fell
    // between the reads, and the bounds above hold each observation to that window.
    expect(report.partitions.rolloverDays).toEqual(
      daysBetween(observations[0]!.observedAt, observations[1]!.observedAt),
    );
    expect(daysBetween(before, after)).toEqual(
      expect.arrayContaining(report.partitions.rolloverDays),
    );
    // A fresh installation meets neither the time bar nor the rollover bar, and says so.
    expect(report.met).toBe(false);
    expect(report.gate.find((check) => check.bar.includes("never reinstalled"))?.met).toBe(true);
  });
});
