import { describe, expect, it } from "vitest";
import { DEFAULT_QUEUE_HEALTH_BUDGETS, evaluateQueueHealth } from "../src/health.js";
import type { QueueHealth } from "../src/types.js";

type Snapshot = Omit<QueueHealth, "status">;

/** A fully healthy snapshot; tests override the one fact they degrade. */
function snapshot(overrides: Partial<Snapshot> = {}): Snapshot {
  const retentionCategories = {
    jobIdentity: null,
    terminalOutcome: null,
    jobEvents: null,
    attemptHistory: null,
    scheduleOccurrences: null,
    statistics: null,
  };
  return {
    capturedAt: new Date(),
    schemaVersion: 23,
    counts: {
      blocked: 0,
      scheduled: 0,
      ready: 0,
      active: 0,
      succeeded: 0,
      failed: 0,
      canceled: 0,
    },
    terminalCountsCapped: false,
    readyDepth: 0,
    scheduledDepth: 0,
    sleepingJobs: 0,
    overdueWaits: 0,
    nextWakeAt: null,
    activeLeases: 0,
    expiredLeases: 0,
    dependencies: {
      blockedJobs: 0,
      pendingEdges: 0,
      failedResolutions: 0,
      retentionPruneStarved: false,
      capped: false,
    },
    children: {
      waitingParents: 0,
      pendingChildren: 0,
      unjoinedResults: 0,
      failedParents: 0,
      canceledParents: 0,
      capped: false,
    },
    externalWaits: {
      pendingSignals: 0,
      pendingHumanDecisions: 0,
      overdue: 0,
      oldestPendingAgeMs: null,
      rejectedDeliveries: 0,
      capped: false,
    },
    oldestReadyAgeMs: null,
    deadlinePressure: { pending: 0, overdue: 0, dueWithinMinute: 0, earliestAt: null },
    activeExecutionTimeouts: 0,
    overdueExecutionTimeouts: 0,
    overdueScheduled: 0,
    oldestOverdueScheduledAgeMs: null,
    concurrencyPolicies: { policies: [], capped: false },
    rateLimitPolicies: { policies: [], capped: false },
    statistics: {
      rolledUpThrough: new Date(),
      lagMs: 0,
      lastRunAt: null,
      buckets: 0,
      bucketsCapped: false,
      oldestBucketAt: null,
      newestBucketAt: null,
    },
    retentionPolicy: {} as Snapshot["retentionPolicy"],
    retentionLagMs: { ...retentionCategories },
    oldestRetainedAt: { ...retentionCategories },
    eligibleHistoryPartitions: { jobEvents: 0, attemptHistory: 0 },
    defaultHistoryRows: { jobEvents: 0, attemptHistory: 0 },
    defaultHistoryRowsCapped: { jobEvents: false, attemptHistory: false },
    historyPartitionDays: [
      { day: "20260101", startsAt: new Date(), hasJobEvents: true, hasAttemptHistory: true },
    ],
    observations: {
      relations: [],
      oldestTransactionAgeMs: null,
      lockWaitCount: 0,
      notificationQueueUsage: 0,
    },
    ...overrides,
  };
}

describe("evaluateQueueHealth", () => {
  it("reports a quiet snapshot as healthy with no reasons", () => {
    expect(evaluateQueueHealth(snapshot())).toEqual({ level: "healthy", reasons: [] });
  });

  it("flags an external wait that remains open past its PostgreSQL deadline", () => {
    expect(
      evaluateQueueHealth(
        snapshot({
          externalWaits: {
            pendingSignals: 1,
            pendingHumanDecisions: 0,
            overdue: 1,
            oldestPendingAgeMs: 60_000,
            rejectedDeliveries: 2,
            capped: false,
          },
        }),
      ),
    ).toMatchObject({
      level: "critical",
      reasons: [expect.objectContaining({ code: "overdue-external-waits", observed: 1 })],
    });
  });

  it("treats work-stopping conditions as critical with zero budget", () => {
    const status = evaluateQueueHealth(
      snapshot({
        expiredLeases: 2,
        deadlinePressure: { pending: 3, overdue: 1, dueWithinMinute: 0, earliestAt: null },
        overdueExecutionTimeouts: 4,
      }),
    );
    expect(status.level).toBe("critical");
    expect(status.reasons).toEqual([
      { code: "expired-leases", severity: "critical", observed: 2, budget: 0 },
      { code: "overdue-deadlines", severity: "critical", observed: 1, budget: 0 },
      { code: "overdue-execution-timeouts", severity: "critical", observed: 4, budget: 0 },
    ]);
  });

  it("flags stalled promotion only past the budget", () => {
    const withinBudget = evaluateQueueHealth(
      snapshot({ overdueScheduled: 5, oldestOverdueScheduledAgeMs: 500 }),
    );
    expect(withinBudget.level).toBe("healthy");
    const stalled = evaluateQueueHealth(
      snapshot({ overdueScheduled: 5, oldestOverdueScheduledAgeMs: 15_000 }),
    );
    expect(stalled.reasons).toEqual([
      {
        code: "stalled-promotion",
        severity: "critical",
        observed: 15_000,
        budget: DEFAULT_QUEUE_HEALTH_BUDGETS.promotionLagMs,
      },
    ]);
  });

  it("counts every missing daily partition side as critical", () => {
    const status = evaluateQueueHealth(
      snapshot({
        historyPartitionDays: [
          { day: "20260101", startsAt: new Date(), hasJobEvents: false, hasAttemptHistory: true },
          { day: "20260102", startsAt: new Date(), hasJobEvents: false, hasAttemptHistory: false },
        ],
      }),
    );
    expect(status.reasons).toEqual([
      { code: "missing-history-partitions", severity: "critical", observed: 3, budget: 0 },
    ]);
  });

  it("degrades storage pressure without making it critical", () => {
    const status = evaluateQueueHealth(
      snapshot({
        statistics: {
          rolledUpThrough: new Date(),
          lagMs: DEFAULT_QUEUE_HEALTH_BUDGETS.rollupStalledLagMs + 1,
          lastRunAt: null,
          buckets: 0,
          bucketsCapped: false,
          oldestBucketAt: null,
          newestBucketAt: null,
        },
        retentionLagMs: {
          jobIdentity: DEFAULT_QUEUE_HEALTH_BUDGETS.rowRetentionLagMs + 1,
          terminalOutcome: DEFAULT_QUEUE_HEALTH_BUDGETS.rowRetentionLagMs,
          jobEvents: DEFAULT_QUEUE_HEALTH_BUDGETS.partitionRetentionLagMs + 1,
          attemptHistory: DEFAULT_QUEUE_HEALTH_BUDGETS.rowRetentionLagMs + 1,
          scheduleOccurrences: null,
          statistics: null,
        },
        eligibleHistoryPartitions: { jobEvents: 2, attemptHistory: 1 },
        defaultHistoryRows: { jobEvents: 7, attemptHistory: 0 },
      }),
    );
    expect(status.level).toBe("degraded");
    expect(status.reasons.map((reason) => [reason.code, reason.category ?? null])).toEqual([
      ["rollup-stalled", null],
      ["retention-lag", "jobIdentity"],
      ["retention-lag", "jobEvents"],
      ["eligible-history-partitions", null],
      ["default-history-rows", null],
    ]);
    // attemptHistory is partition-pruned: exceeding only the row grace stays within its budget,
    // so no attemptHistory reason appears above.
  });

  it("names the queue on admission-pressure reasons", () => {
    const policy = {
      namespace: "default",
      queue: "payments",
      maxActive: 2,
      active: 2,
      available: 0,
      blockedReady: 3,
      maxActivePerKey: null,
      saturatedKeys: 0,
      highestKeyActive: 0,
    };
    const rateLimit = {
      namespace: "default",
      queue: "emails",
      rate: { limit: 1, intervalMs: 1000, burst: 1 },
      perKey: null,
      updatedAt: new Date(),
      availableTokens: 0,
      throttledReady: 4,
      throttledKeys: 0,
      nextEligibleAt: null,
      sampleCapped: false,
      policySetCapped: false,
    };
    const status = evaluateQueueHealth(
      snapshot({
        concurrencyPolicies: { policies: [policy], capped: false },
        rateLimitPolicies: { policies: [rateLimit], capped: false },
      }),
    );
    expect(status.reasons).toEqual([
      {
        code: "concurrency-blocked",
        severity: "degraded",
        observed: 3,
        budget: 0,
        queue: "payments",
      },
      {
        code: "rate-limit-throttled",
        severity: "degraded",
        observed: 4,
        budget: 0,
        queue: "emails",
      },
    ]);
  });

  it("honors caller budget overrides", () => {
    const status = evaluateQueueHealth(
      snapshot({ oldestOverdueScheduledAgeMs: 5, overdueScheduled: 1 }),
      {
        ...DEFAULT_QUEUE_HEALTH_BUDGETS,
        promotionLagMs: 1,
      },
    );
    expect(status.level).toBe("critical");
    expect(status.reasons[0]).toMatchObject({ code: "stalled-promotion", budget: 1 });
  });
});
