import type { MaintenancePolicy, QueueHealth, RetentionPolicy } from "@workhorse/core";
import { describe, expect, it } from "vitest";
import { deriveSettingsRecommendations } from "./settings-recommendations.js";

const maintenance = {
  timezone: "UTC",
  partitionPreparationIntervalMs: 21_600_000,
  terminalCleanupIntervalMs: 300_000,
  historyRetentionLocalTime: "03:00",
  statisticsRollupIntervalMs: 60_000,
  statisticsGroupLimit: 200,
  statisticsRecomputeBuckets: 2,
} as MaintenancePolicy;

const retention = {
  jobIdentityRetentionDays: 14,
  terminalOutcomeRetentionDays: 14,
  jobEventRetentionDays: 14,
  attemptHistoryRetentionDays: 14,
  scheduleOccurrenceRetentionDays: 14,
  statisticsRetentionDays: 30,
  terminalJobPruneLimit: 1_000,
} as RetentionPolicy;

const health = {
  status: { level: "healthy", reasons: [] },
  statistics: {
    rolledUpThrough: new Date("2026-08-17T12:00:00Z"),
    lagMs: 30_000,
    lastRunAt: new Date("2026-08-17T12:00:30Z"),
  },
  defaultHistoryRows: { jobEvents: 0, attemptHistory: 0 },
  defaultHistoryRowsCapped: { jobEvents: false, attemptHistory: false },
} as unknown as QueueHealth;

describe("settings recommendations", () => {
  it("stays silent while every measurement is inside its budget", () => {
    expect(
      deriveSettingsRecommendations({
        maintenance,
        retention,
        health,
        enqueueRate: { jobs: 1_000, windowMs: 3_600_000 },
      }),
    ).toEqual([]);
  });

  it("reports the terminal-cleanup throughput ceiling from the measured arrival rate", () => {
    // 1,000 rows per 5-minute pass is 288,000 deletions/day; 15,000 jobs/hour is 360,000/day.
    const [ceiling] = deriveSettingsRecommendations({
      maintenance,
      retention,
      health,
      enqueueRate: { jobs: 15_000, windowMs: 3_600_000 },
    });
    expect(ceiling).toMatchObject({
      id: "terminal-cleanup-ceiling",
      severity: "warning",
      settings: ["terminalCleanupIntervalMs", "terminalJobPruneLimit"],
      measured: { enqueuedPerDay: 360_000, cleanupCeilingPerDay: 288_000 },
    });
    expect(ceiling!.summary).toContain("288,000");
    expect(ceiling!.summary).toContain("360,000");
  });

  it("skips the ceiling when terminal cleanup is disabled by a null retention window", () => {
    expect(
      deriveSettingsRecommendations({
        maintenance,
        retention: { ...retention, terminalOutcomeRetentionDays: null } as RetentionPolicy,
        health,
        enqueueRate: { jobs: 1_000_000, windowMs: 3_600_000 },
      }),
    ).toEqual([]);
  });

  it("surfaces retention lag and a stalled rollup from the health budgets", () => {
    const degraded = {
      ...health,
      status: {
        level: "degraded",
        reasons: [
          {
            code: "retention-lag",
            severity: "degraded",
            observed: 36_000_000,
            budget: 21_600_000,
            category: "terminalOutcome",
          },
          {
            code: "rollup-stalled",
            severity: "degraded",
            observed: 7_200_000,
            budget: 1_800_000,
          },
        ],
      },
    } as unknown as QueueHealth;
    const recommendations = deriveSettingsRecommendations({
      maintenance,
      retention,
      health: degraded,
      enqueueRate: null,
    });
    expect(recommendations.map(({ id }) => id)).toEqual(["retention-lag", "rollup-stalled"]);
    expect(recommendations[0]).toMatchObject({
      settings: ["terminalCleanupIntervalMs", "terminalJobPruneLimit"],
      measured: { terminalOutcomeLagMs: 36_000_000 },
    });
    expect(recommendations[1]).toMatchObject({
      settings: ["statisticsRollupIntervalMs"],
      measured: { rollupLagMs: 7_200_000 },
    });
  });

  it("notes an opted-out rollup only while raw-history retention depends on the watermark", () => {
    const optedOut = { ...maintenance, statisticsRollupIntervalMs: 0 } as MaintenancePolicy;
    const [note] = deriveSettingsRecommendations({
      maintenance: optedOut,
      retention,
      health,
      enqueueRate: null,
    });
    expect(note).toMatchObject({ id: "statistics-disabled", severity: "info" });

    expect(
      deriveSettingsRecommendations({
        maintenance: optedOut,
        retention: {
          ...retention,
          jobEventRetentionDays: null,
          attemptHistoryRetentionDays: null,
        } as RetentionPolicy,
        health,
        enqueueRate: null,
      }),
    ).toEqual([]);
  });

  it("reports history rows spilled into the default partition", () => {
    const spilled = {
      ...health,
      defaultHistoryRows: { jobEvents: 1_200, attemptHistory: 300 },
      defaultHistoryRowsCapped: { jobEvents: false, attemptHistory: false },
    } as unknown as QueueHealth;
    const [spill] = deriveSettingsRecommendations({
      maintenance,
      retention,
      health: spilled,
      enqueueRate: null,
    });
    expect(spill).toMatchObject({
      id: "partition-spill",
      severity: "warning",
      settings: ["partitionPreparationIntervalMs"],
      measured: { jobEventRows: 1_200, attemptHistoryRows: 300, capped: false },
    });
    expect(spill!.summary).toContain("1,500");
  });
});
