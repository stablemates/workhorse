import { describe, expect, it } from "vitest";
import { collectSoakObservation, observationFileName } from "../../../scripts/soak/observe.js";
import { buildSoakReport } from "../../../scripts/soak/report.js";
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
    expect(observation.format).toBe(1);
    expect(observation.database.name).toMatch(/workhorse/);
    expect(Date.parse(observation.observedAt)).toBeGreaterThan(0);
    expect(observation.installation.schemaVersion).toBe(1);
    expect(observation.installation.protocolVersions).toContain(1);
    expect(observation.installation.migrations[0]).toMatchObject({
      version: 1,
      description: "baseline",
    });
  });

  it("sees the daily partitions the installation prepared ahead", async () => {
    const observation = await collectSoakObservation(pool);

    for (const parent of observation.partitions.parents) {
      // Installation prepares today and the three days after it.
      expect(parent.days).toHaveLength(4);
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

    // A SIGKILLed worker acknowledges nothing, so recovery reaches its jobs through lease expiry.
    await pool.query(
      "UPDATE workhorse.job_runtime SET expires_at = clock_timestamp() - interval '1 second'",
    );
    expect(await queue.recoverExpired()).toBe(2);
    const reclaimed = await queue.claim("soak-replacement-worker");
    expect(await queue.complete(reclaimed!, "soak-replacement-worker", null)).toBe(true);

    const observation = await collectSoakObservation(pool, { killWorker: workerId, killedAt });

    expect(observation.killRecovery).toMatchObject({
      workerId,
      leaseExpiredAttempts: 2,
      affectedJobs: 2,
      jobsSettled: 1,
      jobsLive: 1,
      jobsLost: 0,
      jobsSucceededMoreThanOnce: 0,
    });
  });

  it("reports the closed days the daily statistics tier holds", async () => {
    const jobId = await queue.enqueue("soak-throughput", {});
    const claimed = await queue.claim("soak-throughput-worker");
    expect(claimed?.id).toBe(jobId);
    expect(await queue.complete(claimed!, "soak-throughput-worker", null)).toBe(true);

    // Roll the statistics forward past today so today closes into the daily tier.
    await pool.query(
      `UPDATE workhorse.job_stat_state
          SET rolled_up_through = date_bin('1 day', clock_timestamp(),
                timestamp with time zone '2000-01-01'),
              hourly_rolled_up_through = date_bin('1 day', clock_timestamp(),
                timestamp with time zone '2000-01-01'),
              daily_rolled_up_through = date_bin('1 day', clock_timestamp(),
                timestamp with time zone '2000-01-01')`,
    );
    const result = await queue.rollupStatistics({
      force: true,
      now: new Date(Date.now() + 24 * 60 * 60_000),
      maxBuckets: 2 * 24 * 60,
    });
    expect(result.every(({ error }) => error === null)).toBe(true);

    const observation = await collectSoakObservation(pool);

    const day = observation.throughput.find((entry) => entry.day === today());
    expect(day).toMatchObject({ enqueued: expect.any(Number), jobSucceeded: expect.any(Number) });
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
