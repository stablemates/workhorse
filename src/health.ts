import type {
  QueueHealth,
  QueueHealthBudgets,
  QueueHealthReason,
  QueueHealthStatus,
  RetentionCategoryValues,
} from "./types.js";

/**
 * Default health budgets.
 *
 * Each is generous against its maintenance cadence so routine scheduling jitter never alerts:
 * promotion runs every worker tick, the rollup runs every minute, row retention every five
 * minutes, and partition retention once a day with a bounded per-pass drop count.
 */
export const DEFAULT_QUEUE_HEALTH_BUDGETS: QueueHealthBudgets = {
  promotionLagMs: 10_000,
  rollupStalledLagMs: 30 * 60 * 1_000,
  rowRetentionLagMs: 6 * 60 * 60 * 1_000,
  partitionRetentionLagMs: 2 * 24 * 60 * 60 * 1_000,
  eligibleHistoryPartitions: 2,
};

const retentionCategories: ReadonlyArray<{
  category: keyof RetentionCategoryValues<unknown>;
  prunedByPartition: boolean;
}> = [
  { category: "jobIdentity", prunedByPartition: false },
  { category: "terminalOutcome", prunedByPartition: false },
  { category: "jobEvents", prunedByPartition: true },
  { category: "attemptHistory", prunedByPartition: true },
  { category: "scheduleOccurrences", prunedByPartition: false },
  { category: "statistics", prunedByPartition: false },
];

/**
 * Evaluate one consistent snapshot against health budgets.
 *
 * Critical reasons mean work is stopping or being lost outright: expired leases, overdue
 * deadlines and execution timeouts, stalled promotion, and missing future history partitions.
 * Retention, rollup, and admission pressure only cost storage or throughput, so they degrade.
 */
export function evaluateQueueHealth(
  snapshot: Omit<QueueHealth, "status">,
  budgets: QueueHealthBudgets = DEFAULT_QUEUE_HEALTH_BUDGETS,
): QueueHealthStatus {
  const critical: QueueHealthReason[] = [];
  const degraded: QueueHealthReason[] = [];
  if (snapshot.expiredLeases > 0) {
    critical.push({
      code: "expired-leases",
      severity: "critical",
      observed: snapshot.expiredLeases,
      budget: 0,
    });
  }
  if (snapshot.deadlinePressure.overdue > 0) {
    critical.push({
      code: "overdue-deadlines",
      severity: "critical",
      observed: snapshot.deadlinePressure.overdue,
      budget: 0,
    });
  }
  if (snapshot.overdueExecutionTimeouts > 0) {
    critical.push({
      code: "overdue-execution-timeouts",
      severity: "critical",
      observed: snapshot.overdueExecutionTimeouts,
      budget: 0,
    });
  }
  if (
    snapshot.oldestOverdueScheduledAgeMs !== null &&
    snapshot.oldestOverdueScheduledAgeMs > budgets.promotionLagMs
  ) {
    critical.push({
      code: "stalled-promotion",
      severity: "critical",
      observed: snapshot.oldestOverdueScheduledAgeMs,
      budget: budgets.promotionLagMs,
    });
  }
  const missingPartitions = snapshot.historyPartitionDays.reduce(
    (total, dayRow) => total + (dayRow.hasJobEvents ? 0 : 1) + (dayRow.hasAttemptHistory ? 0 : 1),
    0,
  );
  if (missingPartitions > 0) {
    critical.push({
      code: "missing-history-partitions",
      severity: "critical",
      observed: missingPartitions,
      budget: 0,
    });
  }
  if (snapshot.statistics.lagMs > budgets.rollupStalledLagMs) {
    degraded.push({
      code: "rollup-stalled",
      severity: "degraded",
      observed: snapshot.statistics.lagMs,
      budget: budgets.rollupStalledLagMs,
    });
  }
  for (const { category, prunedByPartition } of retentionCategories) {
    const lagMs = snapshot.retentionLagMs[category];
    const budget = prunedByPartition ? budgets.partitionRetentionLagMs : budgets.rowRetentionLagMs;
    if (lagMs !== null && lagMs > budget) {
      degraded.push({
        code: "retention-lag",
        severity: "degraded",
        observed: lagMs,
        budget,
        category,
      });
    }
  }
  const eligiblePartitions =
    snapshot.eligibleHistoryPartitions.jobEvents +
    snapshot.eligibleHistoryPartitions.attemptHistory;
  if (eligiblePartitions > budgets.eligibleHistoryPartitions) {
    degraded.push({
      code: "eligible-history-partitions",
      severity: "degraded",
      observed: eligiblePartitions,
      budget: budgets.eligibleHistoryPartitions,
    });
  }
  const fallbackRows =
    snapshot.defaultHistoryRows.jobEvents + snapshot.defaultHistoryRows.attemptHistory;
  if (fallbackRows > 0) {
    degraded.push({
      code: "default-history-rows",
      severity: "degraded",
      observed: fallbackRows,
      budget: 0,
    });
  }
  for (const policy of snapshot.concurrencyPolicies.policies) {
    if (policy.blockedReady > 0) {
      degraded.push({
        code: "concurrency-blocked",
        severity: "degraded",
        observed: policy.blockedReady,
        budget: 0,
        queue: policy.queue,
      });
    }
  }
  for (const policy of snapshot.rateLimitPolicies.policies) {
    if (policy.throttledReady > 0) {
      degraded.push({
        code: "rate-limit-throttled",
        severity: "degraded",
        observed: policy.throttledReady,
        budget: 0,
        queue: policy.queue,
      });
    }
  }
  const reasons = [...critical, ...degraded];
  return {
    level: critical.length > 0 ? "critical" : degraded.length > 0 ? "degraded" : "healthy",
    reasons,
  };
}
