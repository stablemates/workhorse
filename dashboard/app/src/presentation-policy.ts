import type {
  DashboardActivityPage,
  DashboardCronPage,
  DashboardRetentionCategory,
  DashboardScheduleRow,
  DashboardSettingsPage,
  DashboardStorageRelation,
  DashboardSystemQueueRow,
  DashboardSystemRetryBucket,
  DashboardWorkerRow,
} from "@stablemates/workhorse-dashboard-server/wire";
import type { QueueHealthReason } from "@stablemates/workhorse";

const DAY_MS = 86_400_000;
const CEILING_PRESSURE = 0.8;
const WORKER_REGISTRATION_STALE_MS = 30_000;
const RECENT_WORKER_MS = 5 * 60_000;
const MAX_ACTIVITY_GROUPS = 10;
const OTHER_ACTIVITY_GROUP = "other";

export interface DashboardSettingsRecommendation {
  id:
    | "terminal-cleanup-ceiling"
    | "retention-lag"
    | "rollup-stalled"
    | "statistics-disabled"
    | "partition-spill";
  severity: "info" | "warning";
  settings: string[];
  summary: string;
  measured: Record<string, number | string | boolean | null>;
}

const retentionCategorySettings: Readonly<Record<string, string[]>> = {
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

export function deriveSettingsRecommendations(
  page: Pick<DashboardSettingsPage, "maintenance" | "retention" | "recommendationInputs">,
): DashboardSettingsRecommendation[] {
  const { maintenance, retention, recommendationInputs: input } = page;
  const recommendations: DashboardSettingsRecommendation[] = [];
  const enqueueRate = input.enqueueRate;

  if (
    retention.terminalOutcomeRetentionDays !== null &&
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

  const retentionReasons = input.reasons.filter((reason) => reason.code === "retention-lag");
  if (retentionReasons.length > 0) {
    const categories = retentionReasons
      .map((reason) => reason.category)
      .filter((category): category is NonNullable<typeof category> => category !== undefined);
    const worst = Math.max(...retentionReasons.map((reason) => reason.observed));
    recommendations.push({
      id: "retention-lag",
      severity: "warning",
      settings: [
        ...new Set(categories.flatMap((category) => retentionCategorySettings[category] ?? [])),
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

  const rollupStalled = input.reasons.find((reason) => reason.code === "rollup-stalled");
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
        lastRunAt: input.statistics.lastRunAt,
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
        rolledUpThrough: input.statistics.rolledUpThrough,
        watermarkLagMs: input.statistics.lagMs,
      },
    });
  }

  const spill = input.defaultHistoryRows.jobEvents + input.defaultHistoryRows.attemptHistory;
  if (spill > 0) {
    const capped =
      input.defaultHistoryRowsCapped.jobEvents || input.defaultHistoryRowsCapped.attemptHistory;
    recommendations.push({
      id: "partition-spill",
      severity: "warning",
      settings: ["partitionPreparationIntervalMs"],
      summary:
        `${capped ? "At least " : ""}${spill.toLocaleString("en-US")} history rows landed in the ` +
        `default partition because no daily partition covered them. Those rows are deleted row by ` +
        `row instead of dropped with their day: prepare partitions more frequently.`,
      measured: {
        jobEventRows: input.defaultHistoryRows.jobEvents,
        attemptHistoryRows: input.defaultHistoryRows.attemptHistory,
        capped,
      },
    });
  }

  return recommendations;
}

export const retentionCategoryLabels: Record<DashboardRetentionCategory, string> = {
  jobIdentity: "Task records",
  terminalOutcome: "Finished results",
  jobEvents: "Task events",
  attemptHistory: "Attempt history",
  scheduleOccurrences: "Schedule runs",
  statistics: "Rolled-up statistics",
};

export interface HealthCheckMessage {
  message: string;
  /** What an operator can do about the failed check, in one or two sentences. */
  advice: string;
  /** Documentation page that explains the failing subsystem. */
  helpHref: string;
}

const docs = (page: string) => `https://workhorse.run/docs/${page}`;

export function healthCheckMessages(reasons: readonly QueueHealthReason[]): {
  criticalChecks: HealthCheckMessage[];
  degradedChecks: HealthCheckMessage[];
} {
  const criticalChecks: HealthCheckMessage[] = [];
  const degradedChecks: HealthCheckMessage[] = [];
  const lateRetentionLabels: string[] = [];
  for (const reason of reasons) {
    switch (reason.code) {
      case "expired-leases":
        criticalChecks.push({
          message: "Expired leases",
          advice:
            "A worker stopped renewing its lease, usually because its process crashed or " +
            "stalled. The next maintenance tick recovers the task; check your worker processes.",
          helpHref: docs("worker-processes"),
        });
        break;
      case "overdue-deadlines":
        criticalChecks.push({
          message: "Tasks are past their deadlines",
          advice:
            "Live tasks passed their deadlines. Deadline maintenance fails them on its next " +
            "pass; if this persists, add worker capacity or relax the deadlines.",
          helpHref: docs("deadlines"),
        });
        break;
      case "overdue-execution-timeouts":
        criticalChecks.push({
          message: "Attempts are past their execution limits",
          advice:
            "Attempts ran longer than their execution limits allow. Maintenance fails them on " +
            "its next pass; check for handlers that hang instead of finishing.",
          helpHref: docs("deadlines"),
        });
        break;
      case "overdue-external-waits":
        criticalChecks.push({
          message: `External waits are overdue (${reason.observed})`,
          advice:
            "A signal or human decision passed its deadline. Review waiting tasks and complete " +
            "the decisions an operator can resolve now.",
          helpHref: docs("human-waits"),
        });
        break;
      case "stalled-promotion":
        criticalChecks.push({
          message: "Scheduled tasks are overdue",
          advice:
            "Due tasks are not being promoted to ready, which usually means no worker is " +
            "running maintenance. Confirm at least one worker process is alive.",
          helpHref: docs("maintenance"),
        });
        break;
      case "missing-history-partitions":
        criticalChecks.push({
          message: "Daily history storage is missing",
          advice:
            "Workers prepare daily history storage during maintenance, so a missing day means " +
            "maintenance has not run recently. Confirm a worker is running and check the " +
            "history-partitions row on the Schedules page.",
          helpHref: docs("maintenance"),
        });
        break;
      case "rollup-stalled":
        degradedChecks.push({
          message: "The statistics summary is behind",
          advice:
            "Retention cannot delete history the rollup has not summarized, so history " +
            "accumulates until the rollup catches up. Check the Storage panel below.",
          helpHref: docs("maintenance"),
        });
        break;
      case "retention-lag":
        if (reason.category) {
          lateRetentionLabels.push(retentionCategoryLabels[reason.category].toLowerCase());
        }
        break;
      case "eligible-history-partitions":
        degradedChecks.push({
          message: `History days await deletion (${reason.observed})`,
          advice:
            "Each retention pass deletes a limited number of history days. If the count keeps " +
            "growing, raise the per-pass limits shown on the Settings page.",
          helpHref: docs("maintenance"),
        });
        break;
      case "default-history-rows":
        degradedChecks.push({
          message: `History rows use fallback storage (${reason.observed})`,
          advice:
            "These rows arrived before their daily storage existed and must be deleted row by " +
            "row. Prepare history storage more frequently to stop the spill.",
          helpHref: docs("maintenance"),
        });
        break;
      case "concurrency-blocked":
        degradedChecks.push({
          message: `Concurrency policy blocks ready tasks on ${reason.queue}`,
          advice:
            "The queue's concurrency policy holds ready tasks back while active work fills the " +
            "limit. Raise the limit if the queue should drain faster.",
          helpHref: docs("concurrency-policies"),
        });
        break;
      case "rate-limit-throttled":
        degradedChecks.push({
          message: `Queue ${reason.queue} has ${reason.observed}+ ready tasks waiting for rate-limit tokens`,
          advice:
            "The queue's rate limit admits work slower than it arrives. Raise the rate if the " +
            "downstream system can absorb more.",
          helpHref: docs("rate-limits"),
        });
        break;
    }
  }
  if (lateRetentionLabels.length > 0) {
    degradedChecks.push({
      message: `Retention cleanup is late for ${lateRetentionLabels.join(", ")}`,
      advice:
        "Cleanup is not keeping up with its retention windows at the current cadence. Raise " +
        "the per-pass limits or shorten the cleanup intervals shown on the Settings page.",
      helpHref: docs("maintenance"),
    });
  }
  return { criticalChecks, degradedChecks };
}

const storageRelationPresentation: Record<
  string,
  { label: string; group: "tasks" | "history" | "statistics" }
> = {
  job: { label: "Task records", group: "tasks" },
  job_outcome: { label: "Finished results", group: "tasks" },
  job_runtime: { label: "Active task state", group: "tasks" },
  job_query: { label: "Dashboard task view", group: "tasks" },
  job_event: { label: "Task events", group: "history" },
  attempt_history: { label: "Attempt history", group: "history" },
  schedule_occurrence: { label: "Schedule runs", group: "history" },
  job_stat_bucket: { label: "Minute summaries", group: "statistics" },
  job_stat_bucket_hour: { label: "Hourly summaries", group: "statistics" },
  job_stat_bucket_day: { label: "Daily summaries", group: "statistics" },
};

export function presentStorageRelation(row: DashboardStorageRelation): DashboardStorageRelation & {
  label: string;
  group: "tasks" | "history" | "statistics";
} {
  const presentation = storageRelationPresentation[row.relation] ?? {
    label: row.relation,
    group: "tasks" as const,
  };
  return { ...row, ...presentation };
}

export function retryBucketLabel(bucket: DashboardSystemRetryBucket): string {
  switch (bucket.upperBoundMs) {
    case 60_000:
      return "1m";
    case 300_000:
      return "5m";
    case 900_000:
      return "15m";
    case 3_600_000:
      return "1h";
    default:
      return "later";
  }
}

export function workerStatus(
  worker: DashboardWorkerRow,
  capturedAt: string,
): "active" | "idle" | "recent" | "offline" {
  if (worker.activeJobs > 0) return "active";
  const capturedAtMs = Date.parse(capturedAt);
  const heartbeatAtMs = worker.lastHeartbeatAt ? Date.parse(worker.lastHeartbeatAt) : Number.NaN;
  if (
    worker.registered &&
    Number.isFinite(heartbeatAtMs) &&
    heartbeatAtMs >= capturedAtMs - WORKER_REGISTRATION_STALE_MS
  ) {
    return "idle";
  }
  const lastSeenAtMs = worker.lastSeenAt ? Date.parse(worker.lastSeenAt) : Number.NaN;
  return Number.isFinite(lastSeenAtMs) && lastSeenAtMs >= capturedAtMs - RECENT_WORKER_MS
    ? "recent"
    : "offline";
}

export function sortQueuesByRisk(
  queues: readonly DashboardSystemQueueRow[],
): DashboardSystemQueueRow[] {
  // oxlint-disable-next-line unicorn/no-array-sort -- ES2022 lacks Array.prototype.toSorted.
  return [...queues].sort((left, right) => {
    const leftRisk = (left.oldestReadyMs ?? 0) + left.ready * 1_000 + left.dueSoon * 100;
    const rightRisk = (right.oldestReadyMs ?? 0) + right.ready * 1_000 + right.dueSoon * 100;
    return rightRisk - leftRisk || left.queue.localeCompare(right.queue);
  });
}

export function capActivityGroups(page: DashboardActivityPage): DashboardActivityPage {
  const totals = new Map(page.groups.map((group) => [group, 0]));
  for (const bucket of page.buckets) {
    for (const [group, count] of Object.entries(bucket.counts)) {
      totals.set(group, (totals.get(group) ?? 0) + count);
    }
  }
  const ranked = [...totals.entries()]
    // oxlint-disable-next-line unicorn/no-array-sort -- ES2022 lacks Array.prototype.toSorted.
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .map(([group]) => group);
  const kept =
    ranked.length > MAX_ACTIVITY_GROUPS ? ranked.slice(0, MAX_ACTIVITY_GROUPS - 1) : ranked;
  const keptSet = new Set(kept);
  const hasOther = ranked.length > kept.length;
  // oxlint-disable-next-line unicorn/no-array-sort -- ES2022 lacks Array.prototype.toSorted.
  const groups = [...kept].sort();
  if (hasOther) groups.push(OTHER_ACTIVITY_GROUP);
  return {
    ...page,
    groups,
    buckets: page.buckets.map((bucket) => {
      const counts: Record<string, number> = {};
      for (const [group, count] of Object.entries(bucket.counts)) {
        const key = keptSet.has(group) ? group : OTHER_ACTIVITY_GROUP;
        counts[key] = (counts[key] ?? 0) + count;
      }
      return { ...bucket, counts };
    }),
  };
}

export interface PresentedScheduleRow extends Omit<
  DashboardScheduleRow,
  "kind" | "identity" | "queue" | "priority" | "occurrenceCount" | "evaluatorCount"
> {
  kind: "user" | "system";
  identity: { kind: "user" | "system"; namespace: string; name: string };
  description: string | null;
  queue: string | null;
  priority: number | null;
  occurrenceCount: number | null;
  evaluatorCount: number | null;
  maintenance: {
    intervalMs: number;
    phases: string[];
    status: "scheduled" | "due" | "incomplete";
    lastStartedAt: string | null;
    lastCompletedAt: string | null;
  } | null;
}

/** Human units for a maintenance cadence, so an expression reads "every 6h", not "every 21600000ms". */
function formatScheduleInterval(milliseconds: number): string {
  if (milliseconds % 3_600_000 === 0) return `${milliseconds / 3_600_000}h`;
  if (milliseconds % 60_000 === 0) return `${milliseconds / 60_000}m`;
  if (milliseconds % 1_000 === 0) return `${milliseconds / 1_000}s`;
  return `${milliseconds}ms`;
}

const scheduleDescriptions: Record<string, string> = {
  "workhorse:tick": "Makes due tasks ready and recovers tasks with expired leases.",
  "workhorse:history-partitions": "Prepares daily history storage before Workhorse needs it.",
  "workhorse:history-retention":
    "Deletes history and schedule runs after their retention periods end.",
  "workhorse:terminal-storage":
    "Deletes expired idempotency records and finished tasks that retention no longer protects.",
};

export function presentSchedules(page: DashboardCronPage): PresentedScheduleRow[] {
  const { cadences, policy, tasks } = page.maintenance;
  const state = new Map(tasks.map((task) => [task.task, task]));
  const maintenance = (
    task: "tick" | "history_partitions" | "history_retention" | "terminal_storage",
    intervalMs: number,
    phases: string[],
  ): PresentedScheduleRow["maintenance"] => {
    const row = state.get(task);
    return {
      intervalMs,
      phases,
      status: row?.incomplete ? "incomplete" : row?.due ? "due" : "scheduled",
      lastStartedAt: row?.lastStartedAt ?? null,
      lastCompletedAt: row?.lastCompletedAt ?? null,
    };
  };
  const system = (
    name: string,
    cron: string,
    type: string,
    lastFiredAt: string | null,
    details: PresentedScheduleRow["maintenance"],
  ): PresentedScheduleRow => ({
    kind: "system",
    identity: { kind: "system", namespace: "workhorse", name },
    namespace: "workhorse",
    name,
    description: scheduleDescriptions[`workhorse:${name}`] ?? null,
    cron,
    queue: null,
    type,
    priority: null,
    enabled: true,
    active: true,
    revision: "1",
    updatedAt: policy.updatedAt,
    occurrenceCount: null,
    evaluatorCount: null,
    lastFiredAt,
    maintenance: details,
  });
  return [
    system(
      "tick",
      `every ${formatScheduleInterval(cadences.tickIntervalMs)}`,
      "workhorse.tick_v1",
      state.get("tick")?.lastCompletedAt ?? state.get("tick")?.lastStartedAt ?? null,
      maintenance("tick", cadences.tickIntervalMs, ["promote", "recover"]),
    ),
    system(
      "history-partitions",
      `every ${formatScheduleInterval(policy.partitionPreparationIntervalMs)}`,
      "workhorse.prepare_history_partitions_v1",
      state.get("history_partitions")?.lastCompletedAt ?? null,
      maintenance("history_partitions", policy.partitionPreparationIntervalMs, [
        "history_partitions",
      ]),
    ),
    system(
      "history-retention",
      `daily at ${policy.historyRetentionLocalTime} ${policy.timezone}`,
      "workhorse.retain_history_v1",
      state.get("history_retention")?.lastCompletedAt ?? null,
      maintenance("history_retention", DAY_MS, [
        "event_retention",
        "attempt_retention",
        "schedule_occurrences",
      ]),
    ),
    system(
      "terminal-storage",
      `every ${formatScheduleInterval(policy.terminalCleanupIntervalMs)}`,
      "workhorse.prune_terminal_storage_v1",
      state.get("terminal_storage")?.lastCompletedAt ?? null,
      maintenance("terminal_storage", policy.terminalCleanupIntervalMs, [
        "enqueue_idempotency",
        "terminal_jobs",
      ]),
    ),
    ...page.schedules.map((schedule) => ({
      ...schedule,
      description: null,
      maintenance: null,
    })),
  ];
}
