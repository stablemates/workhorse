import type {
  DeadLetter,
  JobListItem,
  JobSnapshot,
  JobTimelineEntry,
  QueueHealth,
  WorkerRegistryEntry,
} from "../types.js";
import type { StoredSchedule } from "../queue/cron-schedules.js";
import type { AdminMaintenanceState, AdminQueueStatus } from "./admin-client.js";

/** Serialize administrative payloads that contain bigint fence tokens and schedule revisions. */
export function adminJsonReplacer(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value;
}

export function toAdminJson(value: unknown): string {
  return `${JSON.stringify(value, adminJsonReplacer, 2)}\n`;
}

/** Render one left-aligned text table with a header row. Rows own their own truncation. */
export function formatTable(
  headers: readonly string[],
  rows: readonly (readonly string[])[],
): string {
  const widths = headers.map((header, column) =>
    Math.max(header.length, ...rows.map((row) => (row[column] ?? "").length)),
  );
  const renderRow = (row: readonly string[]): string =>
    row
      .map((cell, column) => cell.padEnd(widths[column] ?? 0))
      .join("  ")
      .trimEnd();
  return [renderRow(headers), ...rows.map(renderRow)].join("\n");
}

function formatTimestamp(value: Date | null): string {
  return value === null ? "-" : value.toISOString();
}

/** Compact duration for operator tables, such as the age of the oldest ready job. */
export function formatDurationMs(value: number | null): string {
  if (value === null) return "-";
  if (value < 1_000) return `${Math.round(value)}ms`;
  const seconds = value / 1_000;
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const minutes = seconds / 60;
  if (minutes < 60) return `${Math.round(minutes)}m`;
  const hours = minutes / 60;
  if (hours < 48) return `${Math.round(hours)}h`;
  return `${Math.round(hours / 24)}d`;
}

function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 1)}…`;
}

function errorName(error: unknown): string {
  if (error && typeof error === "object" && "name" in error && typeof error.name === "string") {
    return error.name;
  }
  if (typeof error === "string") return truncate(error, 40);
  return "-";
}

export const JOBS_TABLE_HEADERS = ["JOB", "STATE", "QUEUE", "TYPE", "ATTEMPT", "RUN AT", "CREATED"];

export function jobsTableRows(items: readonly JobListItem[]): string[][] {
  return items.map((item) => [
    item.id,
    item.state,
    item.queue,
    truncate(item.type, 32),
    `${item.currentAttempt}/${item.maxAttempts}`,
    formatTimestamp(item.runAt),
    formatTimestamp(item.createdAt),
  ]);
}

export const QUEUES_TABLE_HEADERS = [
  "QUEUE",
  "PAUSED",
  "READY",
  "SCHEDULED",
  "ACTIVE",
  "BLOCKED",
  "OLDEST READY",
  "CONCURRENCY",
  "RATE LIMIT",
];

export function queuesTableRows(queues: readonly AdminQueueStatus[]): string[][] {
  return queues.map((status) => [
    status.queue,
    status.paused ? "yes" : "no",
    String(status.readyDepth),
    String(status.scheduledDepth),
    String(status.activeLeases),
    String(status.blockedReadyDepth),
    formatDurationMs(status.oldestReadyAgeMs),
    status.concurrencyLimit === null
      ? "-"
      : `${status.concurrencyActive}/${status.concurrencyLimit}`,
    status.rateLimitPerSecond === null
      ? "-"
      : `${status.rateLimitPerSecond}/s (${status.rateLimitThrottledReadyDepth} throttled)`,
  ]);
}

export const SCHEDULES_TABLE_HEADERS = ["NAMESPACE", "NAME", "CRON", "LAST OCCURRENCE"];

export function schedulesTableRows(schedules: readonly StoredSchedule[]): string[][] {
  return schedules.map((schedule) => [
    schedule.namespace,
    schedule.name,
    schedule.schedule,
    formatTimestamp(schedule.lastOccurrenceAt),
  ]);
}

export const FAILURES_TABLE_HEADERS = [
  "JOB",
  "QUEUE",
  "TYPE",
  "ATTEMPTS",
  "REDRIVEN",
  "ERROR",
  "FINISHED",
];

export function failuresTableRows(items: readonly DeadLetter[]): string[][] {
  return items.map((item) => [
    item.jobId,
    item.queue,
    truncate(item.type, 32),
    `${item.currentAttempt}/${item.maxAttempts}`,
    String(item.redriveCount),
    errorName(item.error),
    formatTimestamp(item.finishedAt),
  ]);
}

export const WORKERS_TABLE_HEADERS = [
  "WORKER",
  "HOST",
  "PID",
  "QUEUE",
  "SLOTS",
  "PAUSED",
  "DRAINING",
  "HEARTBEAT",
];

export function workersTableRows(workers: readonly WorkerRegistryEntry[]): string[][] {
  return workers.map((worker) => [
    worker.workerId,
    truncate(worker.hostname, 24),
    String(worker.pid),
    worker.queues.join(", "),
    `${worker.activeSlots}/${worker.concurrency}`,
    worker.paused ? `yes${worker.pausedBy ? ` (${worker.pausedBy})` : ""}` : "no",
    worker.draining ? "yes" : "no",
    formatTimestamp(worker.lastHeartbeatAt),
  ]);
}

export const TIMELINE_TABLE_HEADERS = ["AT", "KIND", "ATTEMPT", "WHAT"];

export function timelineTableRows(entries: readonly JobTimelineEntry[]): string[][] {
  return entries.map((entry) => [
    formatTimestamp(entry.occurredAt),
    entry.kind,
    entry.attempt === null ? "-" : String(entry.attempt),
    entry.kind === "event"
      ? entry.eventType
      : `${entry.outcome} by ${entry.workerId}${entry.error ? ` (${errorName(entry.error)})` : ""}`,
  ]);
}

/** Health rendered as one status line plus one line per exceeded budget. */
export function healthLines(health: QueueHealth): string[] {
  const lines = [`Workhorse queue is ${health.status.level}.`];
  for (const reason of health.status.reasons) {
    lines.push(
      `- ${reason.severity}: ${reason.code}${reason.queue ? ` (queue ${reason.queue})` : ""}: ` +
        `observed ${reason.observed}, budget ${reason.budget}`,
    );
  }
  return lines;
}

/** Full job snapshot as aligned key/value lines. Payload and result stay JSON. */
export function jobDetailLines(snapshot: JobSnapshot): string[] {
  const entries: Array<[string, string]> = [
    ["id", snapshot.id],
    ["state", snapshot.state],
    ["queue", snapshot.queue],
    ["type", snapshot.type],
    ["priority", String(snapshot.priority)],
    ["attempt", `${snapshot.currentAttempt}/${snapshot.maxAttempts}`],
    ["run at", formatTimestamp(snapshot.runAt)],
    ["created at", formatTimestamp(snapshot.createdAt)],
    ["updated at", formatTimestamp(snapshot.updatedAt)],
    ["deadline at", formatTimestamp(snapshot.deadlineAt)],
    [
      "execution timeout",
      snapshot.executionTimeoutMs === null ? "-" : `${snapshot.executionTimeoutMs}ms`,
    ],
    ["fence token", snapshot.fenceToken.toString()],
    ["tags", snapshot.tags.length === 0 ? "-" : snapshot.tags.join(", ")],
    ["payload", JSON.stringify(snapshot.payload)],
    ["result", snapshot.result === null ? "-" : JSON.stringify(snapshot.result)],
    ["error", snapshot.error === null ? "-" : JSON.stringify(snapshot.error)],
  ];
  if (snapshot.cancelRequestedAt !== null) {
    entries.push([
      "cancel requested",
      `${formatTimestamp(snapshot.cancelRequestedAt)} by ${snapshot.cancelRequestedBy ?? "-"}` +
        `${snapshot.cancelReason ? `: ${snapshot.cancelReason}` : ""}`,
    ]);
  }
  const width = Math.max(...entries.map(([label]) => label.length));
  return entries.map(([label, value]) => `${label.padEnd(width)}  ${value}`);
}

/** Maintenance and retention policies as aligned setting lines with provenance. */
export function maintenanceLines(state: AdminMaintenanceState): string[] {
  const lines: string[] = ["Maintenance policy:"];
  const maintenance = state.maintenancePolicy;
  const retention = state.retentionPolicy;
  const maintenanceEntries: Array<[string, string, string]> = [
    ["timezone", maintenance.timezone, maintenance.provenance.timezone.source],
    [
      "partitionPreparationIntervalMs",
      String(maintenance.partitionPreparationIntervalMs),
      maintenance.provenance.partitionPreparationIntervalMs.source,
    ],
    [
      "terminalCleanupIntervalMs",
      String(maintenance.terminalCleanupIntervalMs),
      maintenance.provenance.terminalCleanupIntervalMs.source,
    ],
    [
      "historyRetentionLocalTime",
      maintenance.historyRetentionLocalTime,
      maintenance.provenance.historyRetentionLocalTime.source,
    ],
  ];
  const retentionEntries: Array<[string, string, string]> = (
    [
      "jobIdentityRetentionDays",
      "terminalOutcomeRetentionDays",
      "jobEventRetentionDays",
      "attemptHistoryRetentionDays",
      "scheduleOccurrenceRetentionDays",
      "statisticsRetentionDays",
      "terminalJobPruneLimit",
      "historyPartitionsPerPass",
      "defaultPartitionRowsPerPass",
      "occurrenceRowsPerPass",
      "statisticsRowsPerPass",
    ] as const
  ).map((setting) => [
    setting,
    retention[setting] === null ? "unlimited" : String(retention[setting]),
    retention.provenance[setting].source,
  ]);
  const width = Math.max(
    ...maintenanceEntries.map(([label]) => label.length),
    ...retentionEntries.map(([label]) => label.length),
  );
  for (const [label, value, source] of maintenanceEntries) {
    lines.push(`  ${label.padEnd(width)}  ${value} (${source})`);
  }
  lines.push(`  updated at: ${formatTimestamp(maintenance.updatedAt)}`, "Retention policy:");
  for (const [label, value, source] of retentionEntries) {
    lines.push(`  ${label.padEnd(width)}  ${value} (${source})`);
  }
  lines.push(`  updated at: ${formatTimestamp(retention.updatedAt)}`);
  return lines;
}
