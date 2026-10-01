import type {
  DashboardActivityPage,
  DashboardCronPage,
  DashboardMaintenanceRun,
  DashboardRetentionCategory,
  DashboardScheduleRow,
  DashboardSettingsPage,
  DashboardStorageRelation,
  DashboardSystemQueueRow,
  DashboardSystemRetryBucket,
  DashboardWorkerRow,
} from "@stablemates/workhorse-dashboard-server/wire";
import type { QueueHealthReason, QueueHealthReasonCode } from "@stablemates/workhorse";
import { formatCount } from "./count-format.js";

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
  taskIdentity: ["terminalCleanupIntervalMs", "terminalTaskPruneLimit"],
  terminalOutcome: ["terminalCleanupIntervalMs", "terminalTaskPruneLimit"],
  taskEvents: ["historyRetentionLocalTime"],
  attemptHistory: ["historyRetentionLocalTime"],
  scheduleOccurrences: ["occurrenceRowsPerPass"],
  statistics: ["statisticsRowsPerPass"],
};

// Schedule runs age by up to a day between passes, so their advice differs from per-pass limits.
const scheduleRunRetentionAdvice =
  "Schedule-run cleanup belongs to the daily history-retention pass. Check that run on the " +
  "Schedules page; if it left rows behind, raise the occurrence rows per pass on the Settings page.";

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
    enqueueRate.tasks > 0 &&
    enqueueRate.windowMs > 0
  ) {
    const passesPerDay = DAY_MS / maintenance.terminalCleanupIntervalMs;
    const ceilingPerDay = Math.round(retention.terminalTaskPruneLimit * passesPerDay);
    const measuredPerDay = Math.round((enqueueRate.tasks / enqueueRate.windowMs) * DAY_MS);
    if (measuredPerDay > ceilingPerDay * CEILING_PRESSURE) {
      recommendations.push({
        id: "terminal-cleanup-ceiling",
        severity: "warning",
        settings: ["terminalCleanupIntervalMs", "terminalTaskPruneLimit"],
        summary:
          `Tasks arrive at roughly ${formatCount(measuredPerDay)} per day, but ` +
          `terminal cleanup can delete at most ${formatCount(ceilingPerDay)} per day ` +
          `(${formatCount(retention.terminalTaskPruneLimit)} rows every ` +
          `${Math.round(maintenance.terminalCleanupIntervalMs / 1000)}s). If the rate holds, ` +
          `completed history accumulates: raise the prune limit or shorten the cleanup interval.`,
        measured: {
          enqueuedPerDay: measuredPerDay,
          cleanupCeilingPerDay: ceilingPerDay,
          terminalTaskPruneLimit: retention.terminalTaskPruneLimit,
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
      summary: [
        `Retention for ${categories.join(", ")} is ${hours(worst)} past its window.`,
        categories.some((category) => category !== "scheduleOccurrences")
          ? "Cleanup is not keeping up at the current cadence and per-pass limits."
          : null,
        categories.includes("scheduleOccurrences") ? scheduleRunRetentionAdvice : null,
      ]
        .filter((sentence) => sentence !== null)
        .join(" "),
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
    (retention.taskEventRetentionDays !== null || retention.attemptHistoryRetentionDays !== null)
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

  const spill = input.defaultHistoryRows.taskEvents + input.defaultHistoryRows.attemptHistory;
  if (spill > 0) {
    const capped =
      input.defaultHistoryRowsCapped.taskEvents || input.defaultHistoryRowsCapped.attemptHistory;
    recommendations.push({
      id: "partition-spill",
      severity: "warning",
      settings: ["partitionPreparationIntervalMs"],
      summary:
        `${capped ? "At least " : ""}${formatCount(spill)} history rows landed in the ` +
        `default partition because no daily partition covered them. Those rows are deleted row by ` +
        `row instead of dropped with their day: prepare partitions more frequently.`,
      measured: {
        taskEventRows: input.defaultHistoryRows.taskEvents,
        attemptHistoryRows: input.defaultHistoryRows.attemptHistory,
        capped,
      },
    });
  }

  return recommendations;
}

export const retentionCategoryLabels: Record<DashboardRetentionCategory, string> = {
  taskIdentity: "Task records",
  terminalOutcome: "Finished results",
  taskEvents: "Task events",
  attemptHistory: "Attempt history",
  scheduleOccurrences: "Schedule runs",
  statistics: "Rolled-up statistics",
};

export interface HealthCheckMessage {
  code: QueueHealthReasonCode;
  message: string;
  /** Structured subject lets the UI emphasize the name without parsing the sentence. */
  subject?: { label: "Queue" | "Budget"; name: string; detail: string };
  /** Resolution advice for a failure, or an explanation of an expected control. */
  advice: string;
  /** Documentation page that explains the failing subsystem. */
  helpHref: string;
}

const docs = (page: string) => `https://workhorse.run/docs/${page}`;

function scopedHealthMessage(
  label: "Queue" | "Budget",
  name: string | undefined,
  detail: string,
): Pick<HealthCheckMessage, "message" | "subject"> {
  return {
    message: `${label} ${name} ${detail}`,
    subject: name === undefined ? undefined : { label, name, detail },
  };
}

export function healthCheckMessages(reasons: readonly QueueHealthReason[]): {
  criticalChecks: HealthCheckMessage[];
  degradedChecks: HealthCheckMessage[];
  expectedChecks: HealthCheckMessage[];
} {
  const criticalChecks: HealthCheckMessage[] = [];
  const degradedChecks: HealthCheckMessage[] = [];
  const expectedChecks: HealthCheckMessage[] = [];
  const lateRetentionLabels: string[] = [];
  const lateRetentionCategories: DashboardRetentionCategory[] = [];
  for (const reason of reasons) {
    switch (reason.code) {
      case "expired-leases":
        criticalChecks.push({
          code: reason.code,
          message: "Expired leases",
          advice:
            "A worker stopped renewing its lease, usually because its process crashed or " +
            "stalled. The next maintenance tick recovers the task; check your worker processes.",
          helpHref: docs("worker-processes"),
        });
        break;
      case "overdue-deadlines":
        criticalChecks.push({
          code: reason.code,
          message: "Tasks are past their deadlines",
          advice:
            "Live tasks passed their deadlines. Deadline maintenance fails them on its next " +
            "pass; if this persists, add worker capacity or relax the deadlines.",
          helpHref: docs("deadlines"),
        });
        break;
      case "overdue-execution-timeouts":
        criticalChecks.push({
          code: reason.code,
          message: "Attempts are past their execution limits",
          advice:
            "Attempts ran longer than their execution limits allow. Maintenance fails them on " +
            "its next pass; check for handlers that hang instead of finishing.",
          helpHref: docs("deadlines"),
        });
        break;
      case "overdue-external-waits":
        criticalChecks.push({
          code: reason.code,
          message: `External waits are overdue (${formatCount(reason.observed)})`,
          advice:
            "A signal or human decision passed its deadline. Review waiting tasks and complete " +
            "the decisions an operator can resolve now.",
          helpHref: docs("human-waits"),
        });
        break;
      case "stalled-promotion":
        criticalChecks.push({
          code: reason.code,
          message: "Scheduled tasks are overdue",
          advice:
            "Due tasks are not being promoted to ready, which usually means no worker is " +
            "running maintenance. Confirm at least one worker process is alive.",
          helpHref: docs("maintenance"),
        });
        break;
      case "missing-history-partitions":
        criticalChecks.push({
          code: reason.code,
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
          code: reason.code,
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
          lateRetentionCategories.push(reason.category);
        }
        break;
      case "eligible-history-partitions":
        degradedChecks.push({
          code: reason.code,
          message: `History days await deletion (${formatCount(reason.observed)})`,
          advice:
            "Each retention pass deletes a limited number of history days. If the count keeps " +
            "growing, raise the per-pass limits shown on the Settings page.",
          helpHref: docs("maintenance"),
        });
        break;
      case "default-history-rows":
        degradedChecks.push({
          code: reason.code,
          message: `History rows use fallback storage (${formatCount(reason.observed)})`,
          advice:
            "These rows arrived before their daily storage existed and must be deleted row by " +
            "row. Prepare history storage more frequently to stop the spill.",
          helpHref: docs("maintenance"),
        });
        break;
      case "concurrency-blocked":
        expectedChecks.push({
          code: reason.code,
          ...scopedHealthMessage(
            "Queue",
            reason.queue,
            `has ${formatCount(reason.observed)}+ ready tasks waiting for concurrency capacity`,
          ),
          advice:
            "The configured concurrency limit keeps active work within capacity. Waiting tasks " +
            "are expected while the limit is in use.",
          helpHref: docs("concurrency-policies"),
        });
        break;
      case "rate-limit-throttled":
        expectedChecks.push({
          code: reason.code,
          ...scopedHealthMessage(
            "Queue",
            reason.queue,
            `has ${formatCount(reason.observed)}+ ready tasks waiting for rate-limit tokens`,
          ),
          advice:
            "The configured rate limit controls how quickly tasks start. Waiting for tokens is " +
            "expected while Workhorse enforces that rate.",
          helpHref: docs("rate-limits"),
        });
        break;
      case "budget-blocked":
        expectedChecks.push({
          code: reason.code,
          ...scopedHealthMessage(
            "Budget",
            reason.budgetName,
            `holds ${formatCount(reason.observed)}+ ready tasks across queues`,
          ),
          advice:
            "The configured budget protects capacity shared across queues. Waiting for capacity " +
            "or start tokens is expected while the budget is in use.",
          helpHref: docs("concurrency-policies"),
        });
        break;
    }
  }
  if (lateRetentionLabels.length > 0) {
    degradedChecks.push({
      code: "retention-lag",
      message: `Retention cleanup is late for ${lateRetentionLabels.join(", ")}`,
      advice: [
        lateRetentionCategories.some((category) => category !== "scheduleOccurrences")
          ? "Cleanup is not keeping up with its retention windows at the current cadence. Raise " +
            "the per-pass limits or shorten the cleanup intervals shown on the Settings page."
          : null,
        lateRetentionCategories.includes("scheduleOccurrences") ? scheduleRunRetentionAdvice : null,
      ]
        .filter((sentence) => sentence !== null)
        .join(" "),
      helpHref: docs("maintenance"),
    });
  }
  return { criticalChecks, degradedChecks, expectedChecks };
}

const healthCheckDefinitions = {
  "expired-leases": { label: "Worker leases", summary: "No expired worker leases." },
  "overdue-deadlines": { label: "Task deadlines", summary: "No tasks are past their deadlines." },
  "overdue-execution-timeouts": {
    label: "Execution timeouts",
    summary: "No attempts are past their execution limits.",
  },
  "overdue-external-waits": {
    label: "External waits",
    summary: "No signals or human decisions are past their deadlines.",
  },
  "stalled-promotion": {
    label: "Scheduled task promotion",
    summary: "No scheduled task promotion exceeds its lag budget.",
  },
  "missing-history-partitions": {
    label: "Daily history partitions",
    summary: "All required daily history partitions exist.",
  },
  "rollup-stalled": {
    label: "Statistics rollup",
    summary: "No statistics rollup stall reported.",
  },
  "retention-lag": {
    label: "Retention cleanup",
    summary: "No retention category exceeds its cleanup budget.",
  },
  "eligible-history-partitions": {
    label: "History partition cleanup",
    summary: "History days awaiting deletion are within the cleanup budget.",
  },
  "default-history-rows": {
    label: "Fallback history storage",
    summary: "No history rows use fallback storage.",
  },
  "concurrency-blocked": {
    label: "Concurrency limits",
    summary: "No sampled ready tasks are waiting for concurrency capacity.",
  },
  "rate-limit-throttled": {
    label: "Rate limits",
    summary: "No sampled ready tasks are waiting for rate-limit tokens.",
  },
  "budget-blocked": {
    label: "Shared budgets",
    summary: "No sampled ready tasks are waiting for shared budget capacity.",
  },
} satisfies Record<QueueHealthReasonCode, { label: string; summary: string }>;

export interface SystemHealthCheck {
  code: QueueHealthReasonCode;
  label: string;
  summary: string;
  status: "critical" | "degraded" | "passing" | "throttling" | "limiting";
  messages: HealthCheckMessage[];
}

/** Every supported check stays visible; only operational failures move to the top. */
export function systemHealthChecks(reasons: readonly QueueHealthReason[]): SystemHealthCheck[] {
  const { criticalChecks, degradedChecks, expectedChecks } = healthCheckMessages(reasons);
  const checks = Object.entries(healthCheckDefinitions).map(
    ([code, definition]): SystemHealthCheck => {
      const critical = criticalChecks.filter((check) => check.code === code);
      const degraded = degradedChecks.filter((check) => check.code === code);
      const expected = expectedChecks.filter((check) => check.code === code);
      return {
        code: code as QueueHealthReasonCode,
        label: definition.label,
        summary: definition.summary,
        status:
          critical.length > 0
            ? "critical"
            : degraded.length > 0
              ? "degraded"
              : expected.length > 0
                ? code === "rate-limit-throttled"
                  ? "throttling"
                  : "limiting"
                : "passing",
        messages: [...critical, ...degraded, ...expected],
      };
    },
  );
  const statusOrder = { critical: 0, degraded: 1, passing: 2, throttling: 2, limiting: 2 };
  // oxlint-disable-next-line unicorn/no-array-sort -- ES2022 lacks Array.prototype.toSorted.
  return [...checks].sort((a, b) => statusOrder[a.status] - statusOrder[b.status]);
}

const storageRelationPresentation: Record<
  string,
  { label: string; group: "tasks" | "history" | "statistics" }
> = {
  task: { label: "Task records", group: "tasks" },
  task_outcome: { label: "Finished results", group: "tasks" },
  task_runtime: { label: "Active task state", group: "tasks" },
  task_query: { label: "Dashboard task view", group: "tasks" },
  task_event: { label: "Task events", group: "history" },
  attempt_history: { label: "Attempt history", group: "history" },
  schedule_occurrence: { label: "Schedule runs", group: "history" },
  task_stat_bucket: { label: "Minute summaries", group: "statistics" },
  task_stat_bucket_hour: { label: "Hourly summaries", group: "statistics" },
  task_stat_bucket_day: { label: "Daily summaries", group: "statistics" },
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
  if (worker.activeTasks > 0) return "active";
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
    recordedRunCount: number;
    runs: DashboardMaintenanceRun[];
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
  const { cadences, policy, routines } = page.maintenance;
  const state = new Map(routines.map((routine) => [routine.routine, routine]));
  const maintenance = (
    routine: "tick" | "history_partitions" | "history_retention" | "terminal_storage",
    intervalMs: number,
    phases: string[],
  ): PresentedScheduleRow["maintenance"] => {
    const row = state.get(routine);
    return {
      intervalMs,
      phases,
      status: row?.incomplete ? "incomplete" : row?.due ? "due" : "scheduled",
      lastStartedAt: row?.lastStartedAt ?? null,
      lastCompletedAt: row?.lastCompletedAt ?? null,
      recordedRunCount: row?.recordedRunCount ?? 0,
      runs: row?.runs ?? [],
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
    catchupPolicy: "skip",
    configuredEnabled: true,
    paused: false,
    pausedBy: null,
    pausedReason: null,
    pausedAt: null,
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
        "terminal_tasks",
      ]),
    ),
    ...page.schedules.map((schedule) => ({
      ...schedule,
      description: null,
      maintenance: null,
    })),
  ];
}
