import type { MaintenancePolicy, QueueHealth, RetentionPolicy } from "@workhorse/core";
import type { DashboardSettingsRecommendation } from "../wire.js";

const DAY_MS = 86_400_000;

/** Jobs counted over a trailing statistics window, used as the measured arrival rate. */
export interface MeasuredEnqueueRate {
  jobs: number;
  windowMs: number;
}

/** Fraction of the terminal-cleanup ceiling the measured rate may reach before advice appears. */
const CEILING_PRESSURE = 0.8;

const RETENTION_CATEGORY_SETTINGS: Readonly<Record<string, string[]>> = {
  jobIdentity: ["terminalCleanupIntervalMs", "terminalJobPruneLimit"],
  terminalOutcome: ["terminalCleanupIntervalMs", "terminalJobPruneLimit"],
  jobEvents: ["historyRetentionLocalTime"],
  attemptHistory: ["historyRetentionLocalTime"],
  scheduleOccurrences: ["occurrenceRowsPerPass"],
  statistics: ["statisticsRowsPerPass"],
};

function hours(ms: number): string {
  return `${(ms / 3_600_000).toFixed(1)}h`;
}

/**
 * Derive settings advice from measured queue state.
 *
 * ADR 0020: the queue already knows its enqueue rate, retention lag, rollup watermark, and
 * partition spill, so the useful advice is computed from those measurements rather than restated
 * from a table of suggested values. Every threshold reuses the budgets health already evaluates;
 * this function adds no second opinion about what "behind" means.
 */
export function deriveSettingsRecommendations(input: {
  maintenance: MaintenancePolicy;
  retention: RetentionPolicy;
  health: QueueHealth;
  enqueueRate: MeasuredEnqueueRate | null;
}): DashboardSettingsRecommendation[] {
  const { maintenance, retention, health, enqueueRate } = input;
  const recommendations: DashboardSettingsRecommendation[] = [];

  // The worked example from the design: the terminal-cleanup ceiling was found by benchmarking
  // and should have been reported by the product. Ceiling = prune limit x passes per day.
  if (
    retention.terminalOutcomeRetentionDays !== null &&
    enqueueRate !== null &&
    enqueueRate.jobs > 0 &&
    enqueueRate.windowMs > 0
  ) {
    const passesPerDay = DAY_MS / maintenance.terminalCleanupIntervalMs;
    const ceilingPerDay = Math.round(retention.terminalJobPruneLimit * passesPerDay);
    const measuredPerDay = Math.round((enqueueRate.jobs / enqueueRate.windowMs) * DAY_MS);
    if (measuredPerDay > ceilingPerDay * CEILING_PRESSURE) {
      recommendations.push({
        id: "terminal-cleanup-ceiling",
        severity: "warning",
        settings: ["terminalCleanupIntervalMs", "terminalJobPruneLimit"],
        summary:
          `Jobs arrive at roughly ${measuredPerDay.toLocaleString("en-US")} per day, but ` +
          `terminal cleanup can delete at most ${ceilingPerDay.toLocaleString("en-US")} per day ` +
          `(${retention.terminalJobPruneLimit.toLocaleString("en-US")} rows every ` +
          `${Math.round(maintenance.terminalCleanupIntervalMs / 1000)}s). If the rate holds, ` +
          `completed history accumulates: raise the prune limit or shorten the cleanup interval.`,
        measured: {
          enqueuedPerDay: measuredPerDay,
          cleanupCeilingPerDay: ceilingPerDay,
          terminalJobPruneLimit: retention.terminalJobPruneLimit,
          terminalCleanupIntervalMs: maintenance.terminalCleanupIntervalMs,
          windowMs: enqueueRate.windowMs,
        },
      });
    }
  }

  const retentionReasons = health.status.reasons.filter(
    (reason) => reason.code === "retention-lag",
  );
  if (retentionReasons.length > 0) {
    const categories = retentionReasons
      .map((reason) => reason.category)
      .filter((category): category is NonNullable<typeof category> => category !== undefined);
    const worst = Math.max(...retentionReasons.map((reason) => reason.observed));
    recommendations.push({
      id: "retention-lag",
      severity: "warning",
      settings: [
        ...new Set(categories.flatMap((category) => RETENTION_CATEGORY_SETTINGS[category] ?? [])),
      ],
      summary:
        `Retention for ${categories.join(", ")} is ${hours(worst)} past its window. ` +
        `Cleanup is not keeping up at the current cadence and per-pass limits.`,
      measured: Object.fromEntries([
        ...retentionReasons.map((reason) => [`${reason.category}LagMs`, reason.observed] as const),
        ["budgetMs", retentionReasons[0]!.budget],
      ]),
    });
  }

  const rollupStalled = health.status.reasons.find((reason) => reason.code === "rollup-stalled");
  if (rollupStalled !== undefined) {
    recommendations.push({
      id: "rollup-stalled",
      severity: "warning",
      settings: ["statisticsRollupIntervalMs"],
      summary:
        `The statistics rollup watermark is ${hours(rollupStalled.observed)} behind ` +
        `(budget ${hours(rollupStalled.budget)}). History retention refuses to delete past the ` +
        `watermark, so raw history accumulates until the rollup catches up.`,
      measured: {
        rollupLagMs: rollupStalled.observed,
        budgetMs: rollupStalled.budget,
        lastRunAt: health.statistics.lastRunAt?.toISOString() ?? null,
      },
    });
  } else if (
    maintenance.statisticsRollupIntervalMs === 0 &&
    (retention.jobEventRetentionDays !== null || retention.attemptHistoryRetentionDays !== null)
  ) {
    recommendations.push({
      id: "statistics-disabled",
      severity: "info",
      settings: ["statisticsRollupIntervalMs"],
      summary:
        "The statistics rollup is opted out while raw-history retention is enabled. Retention " +
        "cannot delete past the rollup watermark, so history behind it is held indefinitely.",
      measured: {
        statisticsRollupIntervalMs: 0,
        rolledUpThrough: health.statistics.rolledUpThrough.toISOString(),
        watermarkLagMs: health.statistics.lagMs,
      },
    });
  }

  const spill = health.defaultHistoryRows.jobEvents + health.defaultHistoryRows.attemptHistory;
  if (spill > 0) {
    const capped =
      health.defaultHistoryRowsCapped.jobEvents || health.defaultHistoryRowsCapped.attemptHistory;
    recommendations.push({
      id: "partition-spill",
      severity: "warning",
      settings: ["partitionPreparationIntervalMs"],
      summary:
        `${capped ? "At least " : ""}${spill.toLocaleString("en-US")} history rows landed in the ` +
        `default partition because no daily partition covered them. Those rows are deleted row by ` +
        `row instead of dropped with their day: prepare partitions more frequently.`,
      measured: {
        jobEventRows: health.defaultHistoryRows.jobEvents,
        attemptHistoryRows: health.defaultHistoryRows.attemptHistory,
        capped,
      },
    });
  }

  return recommendations;
}
