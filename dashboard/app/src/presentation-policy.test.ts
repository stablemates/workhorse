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
  activityChartModel,
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
  taskIdentityRetentionDays: 14,
  terminalOutcomeRetentionDays: 14,
  taskEventRetentionDays: 14,
  attemptHistoryRetentionDays: 14,
  scheduleOccurrenceRetentionDays: 14,
  statisticsRetentionDays: 30,
  terminalTaskPruneLimit: 1_000,
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
      defaultHistoryRows: { taskEvents: 0, attemptHistory: 0 },
      defaultHistoryRowsCapped: { taskEvents: false, attemptHistory: false },
      enqueueRate: { tasks: 1_000, windowMs: 3_600_000 },
      ...recommendationInputs,
    },
  } as DashboardSettingsPage;
}

const retentionLag = (category: "scheduleOccurrences" | "taskIdentity") => ({
  code: "retention-lag" as const,
  severity: "degraded" as const,
  observed: 108_000_000,
  budget: 21_600_000,
  category,
});

describe("dashboard presentation policy", () => {
  it("derives settings advice and its English summary in the SPA", () => {
    const [ceiling] = deriveSettingsRecommendations(
      settingsPage({ enqueueRate: { tasks: 15_000, windowMs: 3_600_000 } }),
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
    const { criticalChecks, degradedChecks, expectedChecks } = healthCheckMessages([
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
        category: "taskEvents",
      },
    ]);
    expect(criticalChecks.map(({ message }) => message)).toEqual([
      "Expired leases",
      "Daily history storage is missing",
    ]);
    expect(degradedChecks.map(({ message }) => message)).toEqual([
      "Retention cleanup is late for task events",
    ]);
    expect(expectedChecks.map(({ message }) => message)).toEqual([
      "Queue payments has 3+ ready tasks waiting for concurrency capacity",
    ]);
    // Every check tells the operator what to do next and where to read more.
    for (const check of [...criticalChecks, ...degradedChecks, ...expectedChecks]) {
      expect(check.advice.length).toBeGreaterThan(0);
      expect(check.helpHref).toMatch(/^https:\/\/workhorse\.run\/docs\//);
    }
    expect(criticalChecks[1]!.advice).toContain("maintenance has not run recently");
    expect(criticalChecks[1]!.helpHref).toBe("https://workhorse.run/docs/maintenance");
  });

  it("tells the operator to raise the prune limit when terminal cleanup cannot keep pace", () => {
    const { degradedChecks } = healthCheckMessages([
      {
        code: "terminal-cleanup-backlog",
        severity: "degraded",
        observed: 25_200_000,
        budget: 21_600_000,
      },
    ]);
    expect(degradedChecks).toEqual([
      {
        code: "terminal-cleanup-backlog",
        message: "Terminal cleanup is not keeping pace",
        advice: expect.stringContaining("Raise the terminal task prune limit"),
        helpHref: "https://workhorse.run/docs/maintenance",
      },
    ]);
  });

  it("points late schedule runs at the daily history-retention pass", () => {
    const scheduleOnly = healthCheckMessages([retentionLag("scheduleOccurrences")])
      .degradedChecks[0]!;
    expect(scheduleOnly.advice).toContain("daily history-retention pass");
    expect(scheduleOnly.advice).toContain("occurrence rows per pass");
    expect(scheduleOnly.advice).not.toContain("shorten the cleanup intervals");

    const mixed = healthCheckMessages([
      retentionLag("taskIdentity"),
      retentionLag("scheduleOccurrences"),
    ]).degradedChecks[0]!;
    expect(mixed.message).toBe("Retention cleanup is late for task records, schedule runs");
    expect(mixed.advice).toContain("shorten the cleanup intervals");
    expect(mixed.advice).toContain("daily history-retention pass");

    const retentionSummary = (reasons: ReturnType<typeof retentionLag>[]) =>
      deriveSettingsRecommendations(settingsPage({ reasons })).find(
        ({ id }) => id === "retention-lag",
      );
    const scheduleSummary = retentionSummary([retentionLag("scheduleOccurrences")]);
    expect(scheduleSummary!.summary).toContain("daily history-retention pass");
    expect(scheduleSummary!.summary).not.toContain("current cadence");
    const mixedSummary = retentionSummary([
      retentionLag("taskIdentity"),
      retentionLag("scheduleOccurrences"),
    ]);
    expect(mixedSummary!.summary).toContain("current cadence");
    expect(mixedSummary!.summary).toContain("daily history-retention pass");
  });

  it("derives retry labels, worker state, and queue ordering from measurements", () => {
    expect(retryBucketLabel({ upperBoundMs: 300_000, count: 2 })).toBe("5m");
    expect(retryBucketLabel({ upperBoundMs: null, count: 2 })).toBe("later");
    const worker = {
      activeTasks: 0,
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

  it("caps activity in the SPA and folds overflow into one series", () => {
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
    const model = activityChartModel(page);
    expect(model.series).toHaveLength(10);
    expect(model.series.at(-1)).toMatchObject({ label: "Other", overflow: true });
    expect(model.buckets[0]!.values[model.series.at(-1)!.id]).toBe(3);
  });

  it("keys activity series by position, never by a group name", () => {
    // Recharts reads a dot as a path, a group can be named like the axis key, and an application
    // can name a group "other" while the cap also folds overflow.
    const groups = ["a.b", "a_b", "bucket", "other"];
    const page = {
      groups,
      buckets: [
        {
          bucketStart: "2026-08-17T12:00:00.000Z",
          counts: { "a.b": 1, a_b: 2, bucket: 3, other: 4 },
        },
      ],
    } as DashboardActivityPage;
    const model = activityChartModel(page);
    const ids = model.series.map(({ id }) => id);
    expect(new Set(ids).size).toBe(groups.length);
    for (const id of ids) {
      expect(groups).not.toContain(id);
      expect(id).not.toContain(".");
      expect(id).not.toBe("bucket");
    }
    expect(model.series.map(({ label }) => label)).toEqual(["a.b", "a_b", "bucket", "other"]);
    const values = model.buckets[0]!.values;
    expect(model.series.map(({ id }) => values[id])).toEqual([1, 2, 3, 4]);
  });

  it("keeps a group named other apart from the overflow series", () => {
    const groups = ["other", ...Array.from({ length: 10 }, (_, index) => `group-${index}`)];
    const page = {
      groups,
      buckets: [
        {
          bucketStart: "2026-08-17T12:00:00.000Z",
          counts: { other: 100, ...Object.fromEntries(groups.slice(1).map((g, i) => [g, i + 1])) },
        },
      ],
    } as DashboardActivityPage;
    const model = activityChartModel(page);
    const named = model.series.find((series) => series.label === "other")!;
    const overflow = model.series.find((series) => series.overflow)!;
    expect(named.overflow).toBe(false);
    expect(model.buckets[0]!.values[named.id]).toBe(100);
    expect(model.buckets[0]!.values[overflow.id]).toBe(1 + 2);
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
        routines: [],
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
