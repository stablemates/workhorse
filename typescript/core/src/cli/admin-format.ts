import type {
  DeadLetter,
  JobCheckpoint,
  JobListItem,
  JobSnapshot,
  JobTimelineEntry,
  JobWait,
  QueueHealth,
  WorkerRegistryEntry,
} from "../types.js";
import type { StoredSchedule } from "../queue/cron-schedules.js";
import type { ExternalWaitRecord } from "../queue/external-waits.js";
import type {
  AdminExternalWaits,
  AdminMaintenanceState,
  AdminQueueStatus,
} from "./admin-client.js";
import type { CliJsonPayloads } from "./surface.js";

/** Serialize administrative payloads that contain bigint fence tokens and schedule revisions. */
export function adminJsonReplacer(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value;
}

/**
 * Serialize one command's `--json` payload.
 *
 * The command names its own entry in {@link CliJsonPayloads}, so the compiler refuses a payload
 * that is not the declared type and `api/cli.txt` cannot describe a shape no command emits.
 */
export function toAdminJson<K extends keyof CliJsonPayloads>(
  command: K,
  payload: CliJsonPayloads[K],
): string {
  // The command is a type-level argument. It binds the payload to its declaration and is not read.
  void command;
  return `${JSON.stringify(payload, adminJsonReplacer, 2)}\n`;
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

/** Render labelled values as aligned lines, the single-entity counterpart to a table. */
function keyValueLines(entries: readonly (readonly [string, string])[]): string[] {
  const width = Math.max(...entries.map(([label]) => label.length));
  return entries.map(([label, value]) => `${label.padEnd(width)}  ${value}`);
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

export const CHECKPOINTS_TABLE_HEADERS = ["NAME", "ATTEMPT", "WORKER", "CREATED", "VALUE"];

export function checkpointsTableRows(checkpoints: readonly JobCheckpoint[]): string[][] {
  return checkpoints.map((checkpoint) => [
    checkpoint.name,
    String(checkpoint.attempt),
    truncate(checkpoint.workerId, 24),
    formatTimestamp(checkpoint.createdAt),
    truncate(JSON.stringify(checkpoint.value), 40),
  ]);
}

/** One checkpoint in full. The value stays JSON, as a job snapshot's payload does. */
export function checkpointDetailLines(checkpoint: JobCheckpoint): string[] {
  return keyValueLines([
    ["job", checkpoint.jobId],
    ["name", checkpoint.name],
    ["attempt", String(checkpoint.attempt)],
    ["fence token", checkpoint.fenceToken.toString()],
    ["worker", checkpoint.workerId],
    ["created at", formatTimestamp(checkpoint.createdAt)],
    ["value", JSON.stringify(checkpoint.value)],
  ]);
}

export const WAITS_TABLE_HEADERS = [
  "NAME",
  "MODE",
  "DURATION",
  "WAKE AT",
  "ATTEMPT",
  "WORKER",
  "CREATED",
];

export function waitsTableRows(waits: readonly JobWait[]): string[][] {
  return waits.map((wait) => [
    wait.name,
    wait.mode,
    formatDurationMs(wait.durationMs),
    formatTimestamp(wait.wakeAt),
    String(wait.attempt),
    truncate(wait.workerId, 24),
    formatTimestamp(wait.createdAt),
  ]);
}

/** One durable timer wait in full, including the caller target an absolute wait asked for. */
export function waitDetailLines(wait: JobWait): string[] {
  return keyValueLines([
    ["job", wait.jobId],
    ["name", wait.name],
    ["mode", wait.mode],
    ["duration", formatDurationMs(wait.durationMs)],
    ["requested wake at", formatTimestamp(wait.requestedWakeAt)],
    ["wake at", formatTimestamp(wait.wakeAt)],
    ["attempt", String(wait.attempt)],
    ["fence token", wait.fenceToken.toString()],
    ["worker", wait.workerId],
    ["created at", formatTimestamp(wait.createdAt)],
  ]);
}

export const EXTERNAL_WAITS_TABLE_HEADERS = [
  "KIND",
  "JOB",
  "QUEUE",
  "TYPE",
  "NAME",
  "ATTEMPT",
  "CREATED",
  "DEADLINE",
  "CONTEXT",
];

/**
 * Both external-wait kinds as one chronological list.
 *
 * An operator reads this to answer "what is the fleet waiting on", so oldest first puts the
 * boundary closest to its deadline at the top. Only a human decision carries context.
 */
export function externalWaitsTableRows(waits: AdminExternalWaits): string[][] {
  const merged: Array<{ kind: string; record: ExternalWaitRecord; context: string }> = [
    ...waits.human.items.map((item) => ({
      kind: "human",
      record: item,
      context: truncate(JSON.stringify(item.context), 40),
    })),
    ...waits.signal.items.map((item) => ({ kind: "signal", record: item, context: "-" })),
  ];
  return merged
    .toSorted((left, right) => left.record.createdAt.getTime() - right.record.createdAt.getTime())
    .map(({ kind, record, context }) => [
      kind,
      record.jobId,
      record.queue,
      truncate(record.jobType, 32),
      record.name,
      String(record.attempt),
      formatTimestamp(record.createdAt),
      formatTimestamp(record.deadlineAt),
      context,
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
  return keyValueLines(entries);
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
