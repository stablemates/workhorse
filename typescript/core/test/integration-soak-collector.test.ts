import { describe, expect, it } from "vitest";
import { OBSERVATION_FORMAT } from "../../../scripts/soak/observation.js";
import { collectSoakObservation, observationFileName } from "../../../scripts/soak/observe.js";
import { buildSoakReport } from "../../../scripts/soak/report.js";
import { WORKHORSE_SCHEMA_VERSION } from "../src/index.js";
import { createIntegrationTestContext } from "./support/integration.js";

const { pool, queue } = createIntegrationTestContext(import.meta.url);

/** The UTC day a live installation is on, which is the day its newest partitions cover. */
function today(): string {
  return new Date().toISOString().slice(0, 10);
}

describe("soak observation collector", () => {
  it("reads a live installation without writing to it", async () => {
    const observation = await collectSoakObservation(pool);

    // Every statement the collector issues runs inside a read-only transaction. Reaching this
    // assertion at all is the evidence: one write would have failed the whole collection.
    expect(observation.format).toBe(OBSERVATION_FORMAT);
    expect(observation.database.name).toMatch(/workhorse/);
    expect(Date.parse(observation.observedAt)).toBeGreaterThan(0);
    expect(observation.installation.schemaVersion).toBe(WORKHORSE_SCHEMA_VERSION);
    expect(observation.installation.protocolVersions).toContain(1);
    expect(observation.installation.migrations[0]).toMatchObject({
      version: 1,
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
    const observation = await collectSoakObservation(pool);

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
      expect(parent.days).toContain(today());
      expect(parent.defaultRows).toBe(0);
    }
    expect(observation.partitions.oldestSurvivingDay).toBe(today());
    expect(observation.partitions.oldestSurvivingAgeDays).toBe(0);
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
    const taskId = await queue.enqueue("soak-throughput", {});
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
    const result = await queue.rollupStatistics({
      force: true,
      now: new Date(Date.now() + 24 * 60 * 60_000),
      maxBuckets: 2 * 24 * 60,
    });
    expect(result.every(({ error }) => error === null)).toBe(true);

    const observation = await collectSoakObservation(pool);

    const day = observation.throughput.find((entry) => entry.day === today());
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
    const observations = [await collectSoakObservation(pool), await collectSoakObservation(pool)];

    const report = buildSoakReport(observations);

    expect(report.observations).toBe(2);
    expect(report.installation.reinstalls).toEqual([]);
    expect(report.partitions.rolloverDays).toEqual([today()]);
    // A fresh installation meets neither the time bar nor the rollover bar, and says so.
    expect(report.met).toBe(false);
    expect(report.gate.find((check) => check.bar.includes("never reinstalled"))?.met).toBe(true);
  });
});
