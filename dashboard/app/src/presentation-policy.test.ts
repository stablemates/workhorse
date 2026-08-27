import type {
  DashboardActivityPage,
  DashboardCronPage,
  DashboardSettingsPage,
  DashboardSystemQueueRow,
  DashboardWorkerRow,
} from "@stablemates/workhorse-dashboard-server/wire";
import type { MaintenancePolicy, RetentionPolicy } from "@stablemates/workhorse";
import { describe, expect, it } from "vitest";
import {
  capActivityGroups,
  deriveSettingsRecommendations,
  healthCheckMessages,
  presentSchedules,
  retryBucketLabel,
  sortQueuesByRisk,
  workerStatus,
} from "./presentation-policy.js";

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

function settingsPage(
  recommendationInputs: Partial<DashboardSettingsPage["recommendationInputs"]> = {},
): DashboardSettingsPage {
  return {
    maintenance,
    retention,
    recommendationInputs: {
      reasons: [],
      statistics: {
        rolledUpThrough: "2026-08-17T12:00:00.000Z",
        lagMs: 30_000,
        lastRunAt: "2026-08-17T12:00:30.000Z",
      },
      defaultHistoryRows: { jobEvents: 0, attemptHistory: 0 },
      defaultHistoryRowsCapped: { jobEvents: false, attemptHistory: false },
      enqueueRate: { jobs: 1_000, windowMs: 3_600_000 },
      ...recommendationInputs,
    },
  } as DashboardSettingsPage;
}

describe("dashboard presentation policy", () => {
  it("derives settings advice and its English summary in the SPA", () => {
    const [ceiling] = deriveSettingsRecommendations(
      settingsPage({ enqueueRate: { jobs: 15_000, windowMs: 3_600_000 } }),
    );
    expect(ceiling).toMatchObject({
      id: "terminal-cleanup-ceiling",
      measured: { enqueuedPerDay: 360_000, cleanupCeilingPerDay: 288_000 },
    });
    expect(ceiling!.summary).toContain("360,000");

    const recommendations = deriveSettingsRecommendations(
      settingsPage({
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
      }),
    );
    expect(recommendations.map(({ id }) => id)).toEqual(["retention-lag", "rollup-stalled"]);
  });

  it("words health reason codes with resolution advice and folds retention categories", () => {
    const { criticalChecks, degradedChecks } = healthCheckMessages([
      { code: "expired-leases", severity: "critical", observed: 1, budget: 0 },
      { code: "missing-history-partitions", severity: "critical", observed: 2, budget: 0 },
      {
        code: "concurrency-blocked",
        severity: "degraded",
        observed: 3,
        budget: 0,
        queue: "payments",
      },
      {
        code: "retention-lag",
        severity: "degraded",
        observed: 90_000_000,
        budget: 21_600_000,
        category: "jobEvents",
      },
    ]);
    expect(criticalChecks.map(({ message }) => message)).toEqual([
      "Expired leases",
      "Daily history storage is missing",
    ]);
    expect(degradedChecks.map(({ message }) => message)).toEqual([
      "Concurrency policy blocks ready tasks on payments",
      "Retention cleanup is late for task events",
    ]);
    // Every check tells the operator what to do next and where to read more.
    for (const check of [...criticalChecks, ...degradedChecks]) {
      expect(check.advice.length).toBeGreaterThan(0);
      expect(check.helpHref).toMatch(/^https:\/\/workhorse\.run\/docs\//);
    }
    expect(criticalChecks[1]!.advice).toContain("maintenance has not run recently");
    expect(criticalChecks[1]!.helpHref).toBe("https://workhorse.run/docs/maintenance");
  });

  it("derives retry labels, worker state, and queue ordering from measurements", () => {
    expect(retryBucketLabel({ upperBoundMs: 300_000, count: 2 })).toBe("5m");
    expect(retryBucketLabel({ upperBoundMs: null, count: 2 })).toBe("later");
    const worker = {
      activeJobs: 0,
      registered: true,
      lastHeartbeatAt: "2026-08-17T11:59:45.000Z",
      lastSeenAt: "2026-08-17T11:59:45.000Z",
    } as DashboardWorkerRow;
    expect(workerStatus(worker, "2026-08-17T12:00:00.000Z")).toBe("idle");
    expect(
      sortQueuesByRisk([
        { queue: "low", ready: 1, dueSoon: 0, oldestReadyMs: 0 },
        { queue: "high", ready: 1, dueSoon: 0, oldestReadyMs: 10_000 },
      ] as DashboardSystemQueueRow[]).map(({ queue }) => queue),
    ).toEqual(["high", "low"]);
  });

  it("caps activity in the SPA and folds overflow into other", () => {
    const groups = Array.from({ length: 11 }, (_, index) => `group-${index}`);
    const page = {
      groups,
      buckets: [
        {
          bucketStart: "2026-08-17T12:00:00.000Z",
          counts: Object.fromEntries(groups.map((group, index) => [group, index + 1])),
        },
      ],
    } as DashboardActivityPage;
    const presented = capActivityGroups(page);
    expect(presented.groups).toHaveLength(10);
    expect(presented.groups.at(-1)).toBe("other");
    expect(presented.buckets[0]!.counts.other).toBe(3);
  });

  it("fabricates maintenance schedule labels and expressions in the SPA", () => {
    const schedules = presentSchedules({
      capturedAt: "2026-08-17T12:00:00.000Z",
      schedules: [],
      maintenance: {
        cadences: { tickIntervalMs: 1_000 },
        policy: {
          timezone: "UTC",
          partitionPreparationIntervalMs: 60_000,
          terminalCleanupIntervalMs: 300_000,
          historyRetentionLocalTime: "03:00",
          updatedAt: "2026-08-17T12:00:00.000Z",
        },
        tasks: [],
      },
    } as DashboardCronPage);
    expect(schedules.map(({ name }) => name)).toEqual([
      "tick",
      "history-partitions",
      "history-retention",
      "terminal-storage",
    ]);
    expect(schedules[0]).toMatchObject({ cron: "every 1s", description: expect.any(String) });
    expect(schedules[1]).toMatchObject({ cron: "every 1m" });
    expect(schedules[3]).toMatchObject({ cron: "every 5m" });
  });
});
