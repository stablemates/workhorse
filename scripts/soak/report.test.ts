import { describe, expect, it } from "vitest";
import { OBSERVATION_FORMAT, type SoakObservation, type ThroughputDay } from "./observation.js";
import { buildSoakReport, renderSoakReport } from "./report.js";

function throughputDay(day: string, enqueued: number, succeeded: number): ThroughputDay {
  return {
    day,
    enqueued,
    jobSucceeded: succeeded,
    jobFailed: 0,
    jobCanceled: 0,
    attemptSucceeded: succeeded,
    attemptFailed: 0,
    attemptRetry: 0,
    attemptLeaseExpired: 0,
    attemptCanceled: 0,
    attemptOther: 0,
  };
}

interface ObservationOverrides {
  partitionDays?: string[];
  baselineAppliedAt?: string;
  migrations?: { version: number; description: string; appliedAt: string }[];
  retainedBefore?: string;
  throughput?: ThroughputDay[];
  killRecovery?: SoakObservation["killRecovery"];
}

function observation(observedAt: string, overrides: ObservationOverrides = {}): SoakObservation {
  const days = overrides.partitionDays ?? [];
  return {
    format: OBSERVATION_FORMAT,
    observedAt,
    database: { name: "workhorse_demo", serverVersion: "17.4" },
    installation: {
      schemaVersion: 1,
      protocolVersions: [1],
      migrations: overrides.migrations ?? [
        {
          version: 1,
          description: "baseline",
          appliedAt: overrides.baselineAppliedAt ?? "2025-12-01T00:00:00.000Z",
        },
      ],
    },
    partitions: {
      parents: [
        { parent: "job_event", days, defaultRows: 0 },
        { parent: "attempt_history", days, defaultRows: 0 },
      ],
      oldestSurvivingDay: days.at(0) ?? null,
      oldestSurvivingAgeDays: days.length === 0 ? null : 14,
    },
    retention: {
      jobEventRetentionDays: 14,
      attemptHistoryRetentionDays: 14,
      statisticsRetentionDays: 14,
      historyPartitionsPerPass: 4,
      historyRetainedBefore: overrides.retainedBefore ?? "2025-12-18T00:00:00.000Z",
      retentionLastCompletedAt: observedAt,
      retentionLastCompletedLocalDate: observedAt.slice(0, 10),
      partitionsLastCompletedAt: observedAt,
    },
    throughput: overrides.throughput ?? [],
    backlog: { ready: 5, active: 2 },
    workers: [],
    queueHealth: { captured_at: observedAt, status: { level: "healthy", reasons: [] } },
    ...(overrides.killRecovery === undefined ? {} : { killRecovery: overrides.killRecovery }),
  };
}

/** Three observations a day apart, with retention retiring one day between each pair. */
function series(): SoakObservation[] {
  return [
    observation("2026-01-01T00:10:00.000Z", {
      partitionDays: ["2025-12-30", "2025-12-31", "2026-01-01", "2026-01-02"],
      throughput: [throughputDay("2025-12-31", 100, 100)],
    }),
    observation("2026-01-02T00:10:00.000Z", {
      partitionDays: ["2025-12-31", "2026-01-01", "2026-01-02", "2026-01-03"],
      retainedBefore: "2025-12-19T00:00:00.000Z",
      throughput: [throughputDay("2025-12-31", 100, 100), throughputDay("2026-01-01", 200, 190)],
    }),
    observation("2026-01-03T00:10:00.000Z", {
      partitionDays: ["2026-01-01", "2026-01-02", "2026-01-03", "2026-01-04"],
      retainedBefore: "2025-12-20T00:00:00.000Z",
      throughput: [throughputDay("2026-01-01", 200, 190), throughputDay("2026-01-02", 300, 300)],
    }),
  ];
}

describe("soak report", () => {
  it("refuses to report on nothing", () => {
    expect(() => buildSoakReport([])).toThrow(/at least one observation/);
  });

  it("counts a day as rolled over only once and only inside the window", () => {
    const report = buildSoakReport(series());

    // 2025-12-31 precedes the window and 2026-01-04 is prepared rather than reached.
    expect(report.partitions.rolloverDays).toEqual(["2026-01-01", "2026-01-02", "2026-01-03"]);
  });

  it("reads a dropped partition as a retention pass", () => {
    const report = buildSoakReport(series());

    expect(report.retention.droppedDays).toEqual(["2025-12-30", "2025-12-31"]);
    expect(report.retention.passesThatDroppedAPartition).toBe(2);
    expect(report.retention.passes[0]).toMatchObject({
      dropped: [
        { parent: "job_event", day: "2025-12-30" },
        { parent: "attempt_history", day: "2025-12-30" },
      ],
      retainedBeforeFrom: "2025-12-18T00:00:00.000Z",
      retainedBeforeTo: "2025-12-19T00:00:00.000Z",
    });
  });

  it("records a retention movement that dropped nothing", () => {
    const observations = [
      observation("2026-01-01T00:10:00.000Z", { partitionDays: ["2026-01-01"] }),
      observation("2026-01-02T00:10:00.000Z", {
        partitionDays: ["2026-01-01", "2026-01-02"],
        retainedBefore: "2025-12-19T00:00:00.000Z",
      }),
    ];

    const report = buildSoakReport(observations);

    expect(report.retention.passes).toHaveLength(1);
    expect(report.retention.passesThatDroppedAPartition).toBe(0);
  });

  it("merges closed days once and reports totals only from inside the window", () => {
    const report = buildSoakReport(series());

    // 2025-12-31 closed before the first observation, so it is context and not window throughput.
    expect(report.throughput.days.map((day) => day.day)).toEqual(["2026-01-01", "2026-01-02"]);
    expect(report.throughput.totals.enqueued).toBe(500);
    expect(report.throughput.totals.jobSucceeded).toBe(490);
    expect(report.throughput.disagreements).toEqual([]);
    expect(report.reconciliation).toMatchObject({ enqueued: 500, settled: 490, residual: 10 });
  });

  it("names a closed day two observations disagreed about", () => {
    const observations = series();
    observations[2]!.throughput = [throughputDay("2026-01-01", 999, 190)];

    expect(buildSoakReport(observations).throughput.disagreements).toEqual(["2026-01-01"]);
  });

  it("reads a new baseline timestamp as a reinstall", () => {
    const observations = series();
    observations[2]!.installation.migrations = [
      { version: 1, description: "baseline", appliedAt: "2026-01-02T12:00:00.000Z" },
    ];

    const report = buildSoakReport(observations);

    expect(report.installation.reinstalls).toHaveLength(1);
    expect(report.gate.find((check) => check.bar.includes("never reinstalled"))?.met).toBe(false);
  });

  it("counts only migrations applied inside the window", () => {
    const observations = series();
    observations[2]!.installation.migrations = [
      { version: 1, description: "baseline", appliedAt: "2025-12-01T00:00:00.000Z" },
      { version: 2, description: "before the window", appliedAt: "2025-12-20T00:00:00.000Z" },
      { version: 3, description: "inside the window", appliedAt: "2026-01-02T00:00:00.000Z" },
    ];

    const report = buildSoakReport(observations);

    expect(report.installation.migrationsAppliedInWindow.map((row) => row.version)).toEqual([3]);
  });

  it("calls a kill clean only when nothing was lost and nothing ran twice", () => {
    const clean = {
      workerId: "demo-typescript-1",
      killedAt: "2026-01-02T09:00:00.000Z",
      windowEnd: "2026-01-02T15:00:00.000Z",
      leaseExpiredAttempts: 12,
      affectedJobs: 12,
      jobsSettled: 11,
      jobsLive: 1,
      jobsLost: 0,
      jobsSucceededMoreThanOnce: 0,
    };
    const observations = series();
    observations[1]!.killRecovery = clean;
    observations[2]!.killRecovery = { ...clean, jobsLost: 1, jobsSettled: 10 };

    const report = buildSoakReport(observations);

    expect(report.kills.map((kill) => kill.clean)).toEqual([true, false]);
  });

  it("does not call a kill that expired no lease clean", () => {
    const observations = series();
    observations[1]!.killRecovery = {
      workerId: "demo-go-1",
      killedAt: "2026-01-02T09:00:00.000Z",
      windowEnd: "2026-01-02T15:00:00.000Z",
      leaseExpiredAttempts: 0,
      affectedJobs: 0,
      jobsSettled: 0,
      jobsLive: 0,
      jobsLost: 0,
      jobsSucceededMoreThanOnce: 0,
    };

    expect(buildSoakReport(observations).kills[0]?.clean).toBe(false);
  });

  it("names the day nobody observed", () => {
    const observations = [
      observation("2026-01-01T00:10:00.000Z", { partitionDays: ["2026-01-01"] }),
      observation("2026-01-03T00:10:00.000Z", { partitionDays: ["2026-01-03"] }),
    ];

    const report = buildSoakReport(observations);

    expect(report.coverage.gapDays).toEqual(["2026-01-02"]);
    expect(report.coverage.longestConsecutiveDays).toBe(1);
  });

  it("holds the gate open until every bar is met", () => {
    const report = buildSoakReport(series());

    expect(report.met).toBe(false);
    expect(report.gate.filter((check) => check.met)).toHaveLength(2);
  });

  it("renders every section a reader has to check", () => {
    const markdown = renderSoakReport(buildSoakReport(series()));

    for (const heading of [
      "## Gate 4",
      "## Window",
      "## Installation continuity",
      "## Partition rollovers",
      "## Retention passes",
      "## Throughput and failures",
      "## Enqueued against settled",
      "## Ungraceful kills",
      "## Queue health at each end",
    ]) {
      expect(markdown).toContain(heading);
    }
    expect(markdown).toContain("No kill was reconciled.");
  });
});
