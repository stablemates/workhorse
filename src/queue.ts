import { CronExpressionParser } from "cron-parser";
import type { Span } from "@opentelemetry/api";
import type {
  BulkRedrivePage,
  BulkRedriveOptions,
  CancellationRequest,
  CancelResult,
  ClaimedJob,
  DeadLetter,
  DeadLetterFilter,
  DeadLetterPage,
  DeadLetterQuery,
  EnqueueIdempotency,
  EnqueueIdempotencyConflictDetails,
  EnqueueIdempotencyConflictField,
  EnqueueOptions,
  EnqueueRequest,
  ExpireOwnedStatus,
  JobListFilter,
  JobListItem,
  JobListPage,
  JobListQuery,
  JobCheckpoint,
  JobProgress,
  JobSnapshot,
  JobState,
  JobTimelineEntry,
  JobTimelinePage,
  JobTimelineQuery,
  JobWait,
  HeartbeatStatus,
  Json,
  MaintenancePolicy,
  MaintenancePolicyDefinition,
  Queryable,
  QueueHealth,
  RedriveIdempotencyConflictDetails,
  RedriveIdempotencyConflictField,
  RedriveLineage,
  RedriveLineageRecord,
  RedriveRequest,
  RedriveResult,
  RetryPolicy,
  RetentionPolicy,
  RetentionPolicyDefinition,
  WorkerPauseResult,
  WorkerRegistration,
  WorkerRegistryEntry,
  TraceContext,
} from "./types.js";
import {
  injectTraceContext,
  jobMetricAttributes,
  jobSpanAttributes,
  telemetryMetrics,
  type QueueMetricSnapshot,
  withSpan,
} from "./telemetry.js";

export interface ScheduleJobDefinition {
  type: string;
  payload: Json;
  queue?: string;
  maxAttempts?: number;
  retryPolicy?: RetryPolicy;
}

export interface ScheduleDefinition {
  name: string;
  schedule: string;
  enabled?: boolean;
  job: ScheduleJobDefinition;
}

export interface StoredSchedule {
  namespace: string;
  name: string;
  schedule: string;
  revision: bigint;
  lastOccurrenceAt: Date | null;
}

export type RunTaskNowStatus =
  | "released"
  | "already_ready"
  | "not_scheduled"
  | "waiting"
  | "not_found";

export interface RunTaskNowResult {
  status: RunTaskNowStatus;
  jobId: string;
  state: string | null;
  runAt: Date | null;
}

export type MaintenancePhase =
  | "promote"
  | "recover"
  | "history_partitions"
  | "stat_rollup"
  | "stat_retention"
  | "event_retention"
  | "attempt_retention"
  | "schedule_occurrences"
  | "enqueue_idempotency"
  | "terminal_jobs";

export interface MaintenancePhaseResult {
  phase: MaintenancePhase;
  rowsAffected: number;
  durationMs: number;
  skippedLock: boolean;
  error: Json;
}
import {
  DEFAULT_IDEMPOTENCY_SCOPE,
  DEFAULT_IDEMPOTENCY_TTL_MS,
  DEFAULT_JOB_QUERY_PAYLOAD_BYTES,
  MAX_ENQUEUE_BATCH_SIZE,
  MAX_JOB_QUERY_PAGE_SIZE,
  MAX_JOB_QUERY_PAYLOAD_BYTES,
  MAX_JOB_QUERY_REDACT_KEYS,
  MAX_REDRIVE_BATCH_SIZE,
  MAX_WAIT_DURATION_MS,
} from "./types.js";

type ClaimRow = {
  job_id: string;
  job_type: string;
  payload: Json;
  trace_context: TraceContext | null;
  attempt: number;
  max_attempts: number;
  retry_policy: RetryPolicy | null;
  deadline_at: Date | string | null;
  execution_timeout_ms: string | null;
  attempt_timeout_at: Date | string | null;
  fence_token: string;
  lease_expires_at: Date | string;
};

type CancelRow = {
  status: CancelResult["status"];
  state: CancelResult["state"];
  current_attempt: number | null;
  requested_at: Date | null;
  requested_by: string | null;
  reason: string | null;
  finished_at: Date | null;
};

type DeadLetterRow = {
  job_id: string;
  queue_name: string;
  job_type: string;
  payload: Json;
  tags: string[];
  current_attempt: number;
  max_attempts: number;
  retry_policy: RetryPolicy | null;
  deadline_at: Date | string | null;
  execution_timeout_ms: string | null;
  error: Json;
  finished_at: Date | string;
  redrive_count: string;
  has_more: boolean;
  cursor_finished_at: string;
};

type JobListRow = {
  job_id: string;
  queue_name: string;
  job_type: string;
  tags: string[];
  state: JobState;
  current_attempt: number;
  max_attempts: number;
  retry_policy: RetryPolicy | null;
  deadline_at: Date | string | null;
  execution_timeout_ms: string | null;
  run_at: Date | string;
  cancel_requested_at: Date | string | null;
  cancel_requested_by: string | null;
  cancel_reason: string | null;
  created_at: Date | string;
  updated_at: Date | string;
  payload: Json | null;
  payload_status: JobListItem["payloadStatus"];
  payload_bytes: number | string | null;
  has_more: boolean;
  cursor_created_at: string;
  cursor_signature: string;
};

type JobTimelineRow = {
  kind: JobTimelineEntry["kind"];
  record_id: string;
  attempt: number | null;
  event_type: string | null;
  details: Json | null;
  fence_token: string | null;
  worker_id: string | null;
  outcome: Extract<JobTimelineEntry, { kind: "attempt" }>["outcome"] | null;
  started_at: Date | string | null;
  claimed_at: Date | string | null;
  finished_at: Date | string | null;
  error: Json | null;
  occurred_at: Date | string;
  has_more: boolean;
  cursor_occurred_at: string;
};

type RedriveRow = {
  status: RedriveResult["status"];
  source_job_id: string;
  target_job_id: string | null;
  source_state: RedriveResult["sourceState"];
  target_state: RedriveResult["targetState"];
  requested_at: Date | string | null;
};

type BulkRedriveRow = RedriveRow & {
  source_finished_at_cursor: string;
  has_more: boolean;
};

type RedriveLineageRow = {
  source_job_id: string;
  target_job_id: string;
  requested_by: string;
  reason: string;
  request_id_preview: string;
  request_id_digest: string;
  request_id_length: number;
  source_state: "failed";
  target_initial_state: "ready";
  requested_at: Date | string;
};

type CheckpointRow = {
  job_id: string;
  checkpoint_name: string;
  checkpoint_value: Json;
  attempt: number;
  fence_token: string;
  worker_id: string;
  created_at: Date;
};

type SaveCheckpointRow = Omit<CheckpointRow, "job_id" | "checkpoint_name"> & {
  status: "saved" | "existing" | "conflict" | "stale";
};

type ProgressRow = {
  job_id: string;
  progress_value: Json;
  revision: string;
  attempt: number;
  fence_token: string;
  worker_id: string;
  created_at: Date;
  updated_at: Date;
};

type UpdateProgressRow = Omit<ProgressRow, "job_id"> & {
  status: "updated" | "unchanged" | "rate_limited" | "stale";
  retry_after_ms: string | null;
};

type WaitRow = {
  job_id: string;
  wait_name: string;
  mode: JobWait["mode"];
  duration_ms: string | null;
  requested_wake_at: Date | null;
  wake_at: Date;
  attempt: number;
  fence_token: string;
  worker_id: string;
  created_at: Date;
};

type ScheduleWaitRow = Omit<WaitRow, "job_id"> & {
  status: "scheduled" | "elapsed" | "conflict" | "limit_exceeded" | "stale";
};

export type ScheduleWaitRequest =
  | { durationMs: number; wakeAt?: never }
  | {
      durationMs?: never;
      wakeAt: Date;
    };

export interface ScheduleWaitResult {
  status: "scheduled" | "elapsed";
  wait: JobWait;
}

type MaintenancePhaseRow = {
  phase: MaintenancePhase;
  rows_affected: number;
  duration_ms: number;
  skipped_lock: boolean;
  error: Json;
  expired_leases: number;
  retried: number;
  retry_dimensions: Array<{ queue: string; type: string }>;
};

type RecoveryTelemetry = Pick<
  MaintenancePhaseRow,
  "rows_affected" | "expired_leases" | "retried" | "retry_dimensions"
>;

type RetentionPolicyRow = {
  job_identity_retention_days: number | null;
  terminal_outcome_retention_days: number | null;
  job_event_retention_days: number | null;
  attempt_history_retention_days: number | null;
  schedule_occurrence_retention_days: number | null;
  statistics_retention_days: number | null;
  terminal_job_prune_limit: number;
  history_partitions_per_pass: number;
  default_partition_rows_per_pass: number;
  occurrence_rows_per_pass: number;
  statistics_rows_per_pass: number;
  updated_at: Date;
};

type MaintenancePolicyRow = {
  timezone: string;
  partition_preparation_interval_ms: number;
  terminal_cleanup_interval_ms: number;
  history_retention_local_hour: number;
  updated_at: Date;
};

function maintenancePhaseResult(row: MaintenancePhaseRow): MaintenancePhaseResult {
  return {
    phase: row.phase,
    rowsAffected: row.rows_affected,
    durationMs: row.duration_ms,
    skippedLock: row.skipped_lock,
    error: row.error,
  };
}

function recordRecoveryTelemetry(span: Span, recovery: RecoveryTelemetry): void {
  span.setAttributes({
    "workhorse.recovery.rows_affected": recovery.rows_affected,
    "workhorse.recovery.expired_leases": recovery.expired_leases,
    "workhorse.recovery.retried": recovery.retried,
  });
  telemetryMetrics.expiredLeases.add(recovery.expired_leases);
  const retriesByJob = new Map<string, { count: number; queue: string; type: string }>();
  for (const dimension of recovery.retry_dimensions ?? []) {
    const key = `${dimension.queue}\u0000${dimension.type}`;
    const existing = retriesByJob.get(key);
    if (existing === undefined) {
      retriesByJob.set(key, { count: 1, ...dimension });
    } else {
      existing.count += 1;
    }
  }
  let attributedRetries = 0;
  for (const retry of retriesByJob.values()) {
    attributedRetries += retry.count;
    telemetryMetrics.retried.add(retry.count, {
      "workhorse.queue.name": retry.queue,
      "workhorse.job.type": retry.type,
    });
  }
  if (attributedRetries < recovery.retried) {
    telemetryMetrics.retried.add(recovery.retried - attributedRetries, {
      "workhorse.queue.name": "unknown",
      "workhorse.job.type": "unknown",
    });
  }
}

function claimedTimestamp(value: Date | string, field: string): Date {
  const timestamp = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(timestamp.getTime())) {
    throw new TypeError(`Claim returned an invalid ${field} timestamp`);
  }
  return timestamp;
}

function nullableClaimedTimestamp(value: Date | string | null, field: string): Date | null {
  return value === null ? null : claimedTimestamp(value, field);
}

function deadLetterFilter(filter: DeadLetterFilter): Record<string, Json> {
  return {
    ...(filter.queue === undefined ? {} : { queue: filter.queue }),
    ...(filter.type === undefined ? {} : { type: filter.type }),
    ...(filter.tags === undefined ? {} : { tags: filter.tags }),
    ...(filter.errorName === undefined ? {} : { errorName: filter.errorName }),
    ...(filter.finishedAfter === undefined
      ? {}
      : { finishedAfter: filter.finishedAfter.toISOString() }),
    ...(filter.finishedBefore === undefined
      ? {}
      : { finishedBefore: filter.finishedBefore.toISOString() }),
  };
}

function deadLetter(row: DeadLetterRow): DeadLetter {
  return {
    jobId: row.job_id,
    queue: row.queue_name,
    type: row.job_type,
    payload: row.payload,
    tags: row.tags,
    currentAttempt: row.current_attempt,
    maxAttempts: row.max_attempts,
    retryPolicy: row.retry_policy,
    deadlineAt: nullableClaimedTimestamp(row.deadline_at, "deadline_at"),
    executionTimeoutMs: row.execution_timeout_ms === null ? null : Number(row.execution_timeout_ms),
    error: row.error,
    finishedAt: claimedTimestamp(row.finished_at, "finished_at"),
    redriveCount: Number(row.redrive_count),
  };
}

const JOB_STATES = new Set<JobState>([
  "scheduled",
  "ready",
  "active",
  "succeeded",
  "failed",
  "canceled",
]);

function validateFiniteDate(value: Date | undefined, field: string): void {
  if (value !== undefined && (!(value instanceof Date) || !Number.isFinite(value.getTime()))) {
    throw new TypeError(`${field} must be a finite Date`);
  }
}

function jobListFilter(filter: JobListFilter): Record<string, Json> {
  return {
    ...(filter.queue === undefined ? {} : { queue: filter.queue }),
    ...(filter.type === undefined ? {} : { type: filter.type }),
    ...(filter.states === undefined ? {} : { states: filter.states }),
    ...(filter.createdAfter === undefined
      ? {}
      : { createdAfter: filter.createdAfter.toISOString() }),
    ...(filter.createdBefore === undefined
      ? {}
      : { createdBefore: filter.createdBefore.toISOString() }),
  };
}

function jobListItem(row: JobListRow): JobListItem {
  return {
    id: row.job_id,
    queue: row.queue_name,
    type: row.job_type,
    tags: row.tags,
    state: row.state,
    currentAttempt: row.current_attempt,
    maxAttempts: row.max_attempts,
    retryPolicy: row.retry_policy,
    deadlineAt: nullableClaimedTimestamp(row.deadline_at, "deadline_at"),
    executionTimeoutMs: row.execution_timeout_ms === null ? null : Number(row.execution_timeout_ms),
    runAt: claimedTimestamp(row.run_at, "run_at"),
    cancelRequestedAt: nullableClaimedTimestamp(row.cancel_requested_at, "cancel_requested_at"),
    cancelRequestedBy: row.cancel_requested_by,
    cancelReason: row.cancel_reason,
    createdAt: claimedTimestamp(row.created_at, "created_at"),
    updatedAt: claimedTimestamp(row.updated_at, "updated_at"),
    payload: row.payload,
    payloadStatus: row.payload_status,
    payloadBytes: row.payload_bytes === null ? null : Number(row.payload_bytes),
  };
}

function jobTimelineEntry(row: JobTimelineRow): JobTimelineEntry {
  const base = {
    recordId: row.record_id,
    attempt: row.attempt,
    occurredAt: claimedTimestamp(row.occurred_at, "occurred_at"),
  };
  if (row.kind === "event") {
    if (row.event_type === null || row.details === null) {
      throw new Error("list_job_timeline_v1 returned an incomplete event row");
    }
    return { ...base, kind: "event", eventType: row.event_type, details: row.details };
  }
  if (
    row.attempt === null ||
    row.fence_token === null ||
    row.worker_id === null ||
    row.outcome === null ||
    row.started_at === null ||
    row.claimed_at === null ||
    row.finished_at === null
  ) {
    throw new Error("list_job_timeline_v1 returned an incomplete attempt row");
  }
  return {
    ...base,
    kind: "attempt",
    attempt: row.attempt,
    fenceToken: BigInt(row.fence_token),
    workerId: row.worker_id,
    outcome: row.outcome,
    startedAt: claimedTimestamp(row.started_at, "started_at"),
    claimedAt: claimedTimestamp(row.claimed_at, "claimed_at"),
    finishedAt: claimedTimestamp(row.finished_at, "finished_at"),
    error: row.error,
  };
}

function redriveResult(row: RedriveRow): RedriveResult {
  return {
    status: row.status,
    sourceJobId: row.source_job_id,
    targetJobId: row.target_job_id,
    sourceState: row.source_state,
    targetState: row.target_state,
    requestedAt:
      row.requested_at === null ? null : claimedTimestamp(row.requested_at, "requested_at"),
  };
}

function redriveLineageRecord(row: RedriveLineageRow): RedriveLineageRecord {
  return {
    sourceJobId: row.source_job_id,
    targetJobId: row.target_job_id,
    requestedBy: row.requested_by,
    reason: row.reason,
    requestIdPreview: row.request_id_preview,
    requestIdDigest: row.request_id_digest,
    requestIdLength: row.request_id_length,
    sourceState: row.source_state,
    targetInitialState: row.target_initial_state,
    requestedAt: claimedTimestamp(row.requested_at, "requested_at"),
  };
}

function retentionPolicy(row: RetentionPolicyRow): RetentionPolicy {
  return {
    jobIdentityRetentionDays: row.job_identity_retention_days,
    terminalOutcomeRetentionDays: row.terminal_outcome_retention_days,
    jobEventRetentionDays: row.job_event_retention_days,
    attemptHistoryRetentionDays: row.attempt_history_retention_days,
    scheduleOccurrenceRetentionDays: row.schedule_occurrence_retention_days,
    statisticsRetentionDays: row.statistics_retention_days,
    terminalJobPruneLimit: row.terminal_job_prune_limit,
    historyPartitionsPerPass: row.history_partitions_per_pass,
    defaultPartitionRowsPerPass: row.default_partition_rows_per_pass,
    occurrenceRowsPerPass: row.occurrence_rows_per_pass,
    statisticsRowsPerPass: row.statistics_rows_per_pass,
    updatedAt: row.updated_at,
  };
}

function maintenancePolicy(row: MaintenancePolicyRow): MaintenancePolicy {
  return {
    timezone: row.timezone,
    partitionPreparationIntervalMs: row.partition_preparation_interval_ms,
    terminalCleanupIntervalMs: row.terminal_cleanup_interval_ms,
    historyRetentionLocalHour: row.history_retention_local_hour,
    updatedAt: row.updated_at,
  };
}

function errorEnvelope(error: unknown): Json {
  // Persist a bounded JSON representation instead of relying on Error's non-enumerable fields.
  if (error instanceof Error) {
    return { name: error.name, message: error.message, stack: error.stack ?? null };
  }
  return { name: "NonErrorThrown", message: String(error) };
}

function checkpointRecord<TValue extends Json>(row: CheckpointRow): JobCheckpoint<TValue> {
  return {
    jobId: row.job_id,
    name: row.checkpoint_name,
    value: row.checkpoint_value as TValue,
    attempt: row.attempt,
    fenceToken: BigInt(row.fence_token),
    workerId: row.worker_id,
    createdAt: row.created_at,
  };
}

function progressRecord<TValue extends Json>(row: ProgressRow): JobProgress<TValue> {
  return {
    jobId: row.job_id,
    value: row.progress_value as TValue,
    revision: BigInt(row.revision),
    attempt: row.attempt,
    fenceToken: BigInt(row.fence_token),
    workerId: row.worker_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function waitRecord(row: WaitRow): JobWait {
  return {
    jobId: row.job_id,
    name: row.wait_name,
    mode: row.mode,
    durationMs: row.duration_ms === null ? null : Number(row.duration_ms),
    requestedWakeAt: row.requested_wake_at,
    wakeAt: row.wake_at,
    attempt: row.attempt,
    fenceToken: BigInt(row.fence_token),
    workerId: row.worker_id,
    createdAt: row.created_at,
  };
}

function validateWaitName(name: string): void {
  if (typeof name !== "string") throw new TypeError("Wait name must be a string");
  const length = [...name].length;
  if (length < 1 || length > 200) {
    throw new RangeError("Wait name must contain between 1 and 200 characters");
  }
}

export class CheckpointLeaseLostError extends Error {
  constructor(jobId: string, checkpointName: string) {
    super(
      `Cannot save checkpoint ${checkpointName} for job ${jobId} because the lease is stale or expired`,
    );
    this.name = "CheckpointLeaseLostError";
  }
}

export class ProgressLeaseLostError extends Error {
  constructor(jobId: string) {
    super(`Cannot update progress for job ${jobId} because the lease is stale or expired`);
    this.name = "ProgressLeaseLostError";
  }
}

export class ProgressRateLimitError extends Error {
  constructor(
    readonly jobId: string,
    readonly retryAfterMs: number,
  ) {
    super(`Cannot update progress for job ${jobId} yet; retry after ${retryAfterMs} milliseconds`);
    this.name = "ProgressRateLimitError";
  }
}

/** The same scoped enqueue key is still retained for a materially different request. */
export class EnqueueIdempotencyConflictError extends Error {
  constructor(readonly details: EnqueueIdempotencyConflictDetails) {
    super(
      `Enqueue idempotency conflict in scope ${details.scope} for key ${details.keyPreview} (${details.keyDigest}); fields: ${details.conflictingFields.join(", ")}`,
    );
    this.name = "EnqueueIdempotencyConflictError";
  }

  get scope(): string {
    return this.details.scope;
  }
  get keyPreview(): string {
    return this.details.keyPreview;
  }
  get keyDigest(): string {
    return this.details.keyDigest;
  }
  get keyLength(): number {
    return this.details.keyLength;
  }
  get existingJobId(): string {
    return this.details.existingJobId;
  }
  get ordinal(): number {
    return this.details.ordinal;
  }
  get conflictingFields(): EnqueueIdempotencyConflictField[] {
    return this.details.conflictingFields;
  }
  get storedRequestDigest(): string {
    return this.details.storedRequestDigest;
  }
  get rejectedRequestDigest(): string {
    return this.details.rejectedRequestDigest;
  }
}

const enqueueConflictFields = new Set<EnqueueIdempotencyConflictField>([
  "queue",
  "type",
  "payload",
  "tags",
  "runAt",
  "deadline",
  "executionTimeoutMs",
  "maxAttempts",
  "retryPolicy",
  "ttlMs",
]);
const enqueueConflictDetailKeys = new Set([
  "scope",
  "keyPreview",
  "keyDigest",
  "keyLength",
  "existingJobId",
  "ordinal",
  "conflictingFields",
  "storedRequestDigest",
  "rejectedRequestDigest",
]);

const sanitizedEnqueueConflictDetails: EnqueueIdempotencyConflictDetails = {
  scope: "unknown",
  keyPreview: "unknown",
  keyDigest: "000000000000",
  keyLength: 0,
  existingJobId: "unknown",
  ordinal: 0,
  conflictingFields: [],
  storedRequestDigest: "0".repeat(64),
  rejectedRequestDigest: "0".repeat(64),
};

function validEnqueueConflictDetails(value: unknown): value is EnqueueIdempotencyConflictDetails {
  if (typeof value !== "object" || value === null) return false;
  const detail = value as Record<string, unknown>;
  const keys = Object.keys(detail);
  return (
    keys.length === enqueueConflictDetailKeys.size &&
    keys.every((key) => enqueueConflictDetailKeys.has(key)) &&
    typeof detail.scope === "string" &&
    detail.scope.length > 0 &&
    [...detail.scope].length <= 256 &&
    typeof detail.keyPreview === "string" &&
    detail.keyPreview.length > 0 &&
    [...detail.keyPreview].length <= 16 &&
    typeof detail.keyDigest === "string" &&
    /^[0-9a-f]{12}$/.test(detail.keyDigest) &&
    typeof detail.keyLength === "number" &&
    Number.isSafeInteger(detail.keyLength) &&
    detail.keyLength >= 1 &&
    detail.keyLength <= 512 &&
    typeof detail.existingJobId === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      detail.existingJobId,
    ) &&
    typeof detail.ordinal === "number" &&
    Number.isSafeInteger(detail.ordinal) &&
    detail.ordinal >= 1 &&
    detail.ordinal <= MAX_ENQUEUE_BATCH_SIZE &&
    Array.isArray(detail.conflictingFields) &&
    detail.conflictingFields.length > 0 &&
    detail.conflictingFields.every(
      (field): field is EnqueueIdempotencyConflictField =>
        typeof field === "string" &&
        enqueueConflictFields.has(field as EnqueueIdempotencyConflictField),
    ) &&
    new Set(detail.conflictingFields).size === detail.conflictingFields.length &&
    detail.conflictingFields.every(
      (field, index, fields) => index === 0 || fields[index - 1]! < field,
    ) &&
    typeof detail.storedRequestDigest === "string" &&
    /^[0-9a-f]{64}$/.test(detail.storedRequestDigest) &&
    typeof detail.rejectedRequestDigest === "string" &&
    /^[0-9a-f]{64}$/.test(detail.rejectedRequestDigest)
  );
}

function enqueueConflictDetails(error: unknown): EnqueueIdempotencyConflictDetails {
  const seen = new Set<object>();
  let current = error;

  for (let depth = 0; depth < 16; depth++) {
    if (typeof current !== "object" || current === null || seen.has(current)) break;
    seen.add(current);

    try {
      if ("detail" in current && typeof current.detail === "string") {
        try {
          const detail: unknown = JSON.parse(current.detail);
          if (validEnqueueConflictDetails(detail)) return detail;
        } catch {
          // Continue through adapter wrappers in case PostgreSQL's DETAIL is on a cause.
        }
      }
      current = "cause" in current ? current.cause : undefined;
    } catch {
      break;
    }
  }

  return sanitizedEnqueueConflictDetails;
}

function enqueueConflict(error: unknown): EnqueueIdempotencyConflictError | null {
  if (typeof error !== "object" || error === null || !("code" in error) || error.code !== "P1001") {
    return null;
  }
  return new EnqueueIdempotencyConflictError(enqueueConflictDetails(error));
}

const redriveConflictFields = new Set<RedriveIdempotencyConflictField>(["reason", "requestedBy"]);
const redriveConflictDetailKeys = new Set([
  "sourceJobId",
  "existingTargetJobId",
  "requestIdPreview",
  "requestIdDigest",
  "requestIdLength",
  "conflictingFields",
  "storedRequestDigest",
  "rejectedRequestDigest",
]);
const sanitizedRedriveConflictDetails: RedriveIdempotencyConflictDetails = {
  sourceJobId: "unknown",
  existingTargetJobId: "unknown",
  requestIdPreview: "unknown",
  requestIdDigest: "000000000000",
  requestIdLength: 0,
  conflictingFields: [],
  storedRequestDigest: "0".repeat(64),
  rejectedRequestDigest: "0".repeat(64),
};

function validRedriveConflictDetails(value: unknown): value is RedriveIdempotencyConflictDetails {
  if (typeof value !== "object" || value === null) return false;
  const detail = value as Record<string, unknown>;
  const keys = Object.keys(detail);
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  return (
    keys.length === redriveConflictDetailKeys.size &&
    keys.every((key) => redriveConflictDetailKeys.has(key)) &&
    typeof detail.sourceJobId === "string" &&
    uuid.test(detail.sourceJobId) &&
    typeof detail.existingTargetJobId === "string" &&
    uuid.test(detail.existingTargetJobId) &&
    typeof detail.requestIdPreview === "string" &&
    detail.requestIdPreview.length > 0 &&
    [...detail.requestIdPreview].length <= 16 &&
    typeof detail.requestIdDigest === "string" &&
    /^[0-9a-f]{12}$/.test(detail.requestIdDigest) &&
    typeof detail.requestIdLength === "number" &&
    Number.isSafeInteger(detail.requestIdLength) &&
    detail.requestIdLength >= 1 &&
    detail.requestIdLength <= 512 &&
    Array.isArray(detail.conflictingFields) &&
    detail.conflictingFields.length > 0 &&
    detail.conflictingFields.every(
      (field): field is RedriveIdempotencyConflictField =>
        typeof field === "string" &&
        redriveConflictFields.has(field as RedriveIdempotencyConflictField),
    ) &&
    new Set(detail.conflictingFields).size === detail.conflictingFields.length &&
    detail.conflictingFields.every(
      (field, index, fields) => index === 0 || fields[index - 1]! < field,
    ) &&
    typeof detail.storedRequestDigest === "string" &&
    /^[0-9a-f]{64}$/.test(detail.storedRequestDigest) &&
    typeof detail.rejectedRequestDigest === "string" &&
    /^[0-9a-f]{64}$/.test(detail.rejectedRequestDigest)
  );
}

function redriveConflictDetails(error: unknown): RedriveIdempotencyConflictDetails {
  const seen = new Set<object>();
  let current = error;
  for (let depth = 0; depth < 16; depth += 1) {
    if (typeof current !== "object" || current === null || seen.has(current)) break;
    seen.add(current);
    try {
      if ("detail" in current && typeof current.detail === "string") {
        try {
          const detail: unknown = JSON.parse(current.detail);
          if (validRedriveConflictDetails(detail)) return detail;
        } catch {
          // Continue through adapter wrappers in case PostgreSQL's DETAIL is on a cause.
        }
      }
      current = "cause" in current ? current.cause : undefined;
    } catch {
      break;
    }
  }
  return sanitizedRedriveConflictDetails;
}

function redriveConflict(error: unknown): RedriveIdempotencyConflictError | null {
  if (typeof error !== "object" || error === null || !("code" in error) || error.code !== "P1002") {
    return null;
  }
  return new RedriveIdempotencyConflictError(redriveConflictDetails(error));
}

export class RedriveIdempotencyConflictError extends Error {
  constructor(readonly details: RedriveIdempotencyConflictDetails) {
    super(
      `Redrive request conflict for source ${details.sourceJobId} and request ${details.requestIdPreview} (${details.requestIdDigest}); fields: ${details.conflictingFields.join(", ")}`,
    );
    this.name = "RedriveIdempotencyConflictError";
  }
}

export class CheckpointConflictError extends Error {
  constructor(jobId: string, checkpointName: string) {
    super(`Checkpoint ${checkpointName} for job ${jobId} already exists with a different value`);
    this.name = "CheckpointConflictError";
  }
}

export class WaitLeaseLostError extends Error {
  constructor(
    readonly jobId: string,
    readonly waitName: string,
  ) {
    super(
      `Cannot schedule wait ${waitName} for job ${jobId} because the lease is stale or expired`,
    );
    this.name = "WaitLeaseLostError";
  }
}

export class WaitConflictError extends Error {
  constructor(
    readonly jobId: string,
    readonly waitName: string,
    readonly existing: JobWait,
  ) {
    super(
      `Wait ${waitName} for job ${jobId} already exists with a different mode or absolute target`,
    );
    this.name = "WaitConflictError";
  }
}

export class WaitLimitExceededError extends Error {
  constructor(readonly jobId: string) {
    super(`Job ${jobId} already has the maximum of 1000 durable waits`);
    this.name = "WaitLimitExceededError";
  }
}

/**
 * Thin TypeScript facade over the versioned PostgreSQL protocol.
 *
 * Correctness lives in SQL functions. Keeping this layer thin prevents each runtime client from
 * inventing its own locking, fencing, or history behavior.
 */
export class Queue {
  constructor(
    private readonly database: Queryable,
    readonly defaultQueue = "default",
  ) {}

  async enqueue<TPayload extends Json>(
    type: string,
    payload: TPayload,
    options: EnqueueOptions = {},
    transaction: Queryable = this.database,
  ): Promise<string> {
    return (
      await this.enqueueMany([{ type, payload, options, tags: options.tags }], transaction)
    )[0]!;
  }

  async enqueueMany(
    requests: readonly EnqueueRequest[],
    transaction: Queryable = this.database,
  ): Promise<string[]> {
    if (requests.length === 0) return [];
    if (requests.length > MAX_ENQUEUE_BATCH_SIZE) {
      throw new RangeError(`enqueueMany accepts at most ${MAX_ENQUEUE_BATCH_SIZE} requests`);
    }

    const queueNames = new Set(
      requests.map((request) => request.options?.queue ?? this.defaultQueue),
    );
    return withSpan(
      "workhorse.enqueue",
      {
        ...(queueNames.size === 1
          ? { "workhorse.queue.name": queueNames.values().next().value! }
          : {}),
        ...(requests.length === 1 ? { "workhorse.job.type": requests[0]!.type } : {}),
        "workhorse.enqueue.count": requests.length,
      },
      async (span) => {
        const traceContext = injectTraceContext();
        // Supplying an active PoolClient makes the whole batch participate in the caller's transaction.
        const input = requests.map(({ type, payload, options = {}, tags }) => {
          const idempotency: EnqueueIdempotency | undefined = options.idempotency;
          return {
            queue: options.queue ?? this.defaultQueue,
            type,
            payload,
            ...(traceContext === null ? {} : { traceContext }),
            ...(options.runAt === undefined && idempotency !== undefined
              ? {}
              : { runAt: (options.runAt ?? new Date()).toISOString() }),
            deadline: options.deadline?.toISOString() ?? null,
            executionTimeoutMs: options.executionTimeoutMs ?? null,
            maxAttempts: options.maxAttempts ?? 25,
            retryPolicy: options.retryPolicy ?? null,
            tags: tags ?? options.tags ?? [],
            ...(idempotency === undefined
              ? {}
              : {
                  idempotency: {
                    key: idempotency.key,
                    scope: idempotency.scope ?? DEFAULT_IDEMPOTENCY_SCOPE,
                    ttlMs: idempotency.ttlMs ?? DEFAULT_IDEMPOTENCY_TTL_MS,
                  },
                }),
          };
        });
        try {
          const result = await transaction.query<{
            ordinal: number;
            job_id: string;
            accepted: boolean;
          }>(
            "SELECT ordinal, job_id, accepted FROM workhorse.enqueue_many_v1($1::jsonb) ORDER BY ordinal",
            [JSON.stringify(input)],
          );
          const jobIds = result.rows.map((row) => row.job_id);
          for (const row of result.rows) {
            if (!row.accepted) continue;
            const request = requests[row.ordinal - 1]!;
            telemetryMetrics.enqueued.add(1, {
              "workhorse.queue.name": request.options?.queue ?? this.defaultQueue,
              "workhorse.job.type": request.type,
            });
          }
          if (jobIds.length === 1) span.setAttribute("workhorse.job.id", jobIds[0]!);
          return jobIds;
        } catch (error) {
          throw enqueueConflict(error) ?? error;
        }
      },
    );
  }

  async promote(limit = 100): Promise<number> {
    // Promotion is bounded so a large delayed backlog cannot create one long lock transaction.
    const result = await this.database.query<{ count: number }>(
      "SELECT workhorse.promote_v1($1) AS count",
      [limit],
    );
    return result.rows[0]!.count;
  }

  async pauseQueue(queueName = this.defaultQueue): Promise<void> {
    await this.database.query("SELECT workhorse.pause_queue_v1($1)", [queueName]);
  }

  async resumeQueue(queueName = this.defaultQueue): Promise<void> {
    await this.database.query("SELECT workhorse.resume_queue_v1($1)", [queueName]);
  }

  async purgeQueue(queueName = this.defaultQueue): Promise<number> {
    const result = await this.database.query<{ count: number }>(
      "SELECT workhorse.purge_queue_v1($1) AS count",
      [queueName],
    );
    return result.rows[0]!.count;
  }

  /**
   * Announce or refresh this worker's registration and read back the operator-requested pause flag.
   *
   * One round trip pushes the runtime state the worker owns and pulls the pause decision
   * PostgreSQL owns, so an operator surface in a different process can observe and control a
   * worker fleet it does not host.
   *
   * `instanceId` identifies this process incarnation. A refresh from the same instance keeps any
   * operator pause; a new instance of the same worker id clears it, which is what makes pause
   * process-scoped rather than a flag that outlives the process it was aimed at.
   */
  async registerWorker(registration: WorkerRegistration): Promise<{ paused: boolean }> {
    const result = await this.database.query<{ paused: boolean }>(
      "SELECT workhorse.register_worker_v1($1, $2, $3, $4, $5, $6, $7, $8) AS paused",
      [
        registration.workerId,
        registration.instanceId,
        registration.hostname,
        registration.pid,
        registration.queue ?? this.defaultQueue,
        registration.concurrency,
        registration.activeSlots,
        registration.draining,
      ],
    );
    return { paused: result.rows[0]!.paused };
  }

  /** Remove one worker registration. A killed worker instead ages out of the fleet view. */
  async deregisterWorker(workerId: string): Promise<boolean> {
    const result = await this.database.query<{ deregistered: boolean }>(
      "SELECT workhorse.deregister_worker_v1($1) AS deregistered",
      [workerId],
    );
    return result.rows[0]!.deregistered;
  }

  /**
   * Request or clear an operator pause for one registered worker.
   *
   * `requestedBy` and `reason` are bounded audit attribution rather than authorization. The pause
   * is cooperative: the worker stops claiming when it next refreshes its registration, and any
   * in-flight handler runs to completion. Returns null when the worker is not registered.
   */
  async setWorkerPaused(
    workerId: string,
    paused: boolean,
    options: { requestedBy?: string; reason?: string } = {},
  ): Promise<WorkerPauseResult | null> {
    const result = await this.database.query<{
      worker_id: string;
      paused: boolean;
      paused_by: string | null;
      paused_reason: string | null;
      paused_at: Date | null;
      last_heartbeat_at: Date;
    }>("SELECT * FROM workhorse.set_worker_paused_v1($1, $2, $3, $4)", [
      workerId,
      paused,
      options.requestedBy ?? null,
      options.reason ?? null,
    ]);
    const row = result.rows[0];
    if (!row) return null;
    return {
      workerId: row.worker_id,
      paused: row.paused,
      pausedBy: row.paused_by,
      reason: row.paused_reason,
      pausedAt: row.paused_at,
      lastHeartbeatAt: row.last_heartbeat_at,
    };
  }

  /** List every registered worker, most recently seen first. */
  async listWorkers(): Promise<WorkerRegistryEntry[]> {
    const result = await this.database.query<{
      worker_id: string;
      instance_id: string;
      hostname: string;
      pid: number;
      queue_name: string;
      concurrency: number;
      active_slots: number;
      draining: boolean;
      paused: boolean;
      paused_by: string | null;
      paused_reason: string | null;
      paused_at: Date | null;
      started_at: Date;
      last_heartbeat_at: Date;
    }>(
      `SELECT worker_id, instance_id, hostname, pid, queue_name, concurrency, active_slots, draining, paused, paused_by,
              paused_reason, paused_at, started_at, last_heartbeat_at
         FROM workhorse.worker_registry
        ORDER BY last_heartbeat_at DESC, worker_id`,
    );
    return result.rows.map((row) => ({
      workerId: row.worker_id,
      instanceId: row.instance_id,
      hostname: row.hostname,
      pid: row.pid,
      queue: row.queue_name,
      concurrency: row.concurrency,
      activeSlots: row.active_slots,
      draining: row.draining,
      paused: row.paused,
      pausedBy: row.paused_by,
      reason: row.paused_reason,
      pausedAt: row.paused_at,
      startedAt: row.started_at,
      lastHeartbeatAt: row.last_heartbeat_at,
    }));
  }

  /** Drop registrations whose process stopped heartbeating longer ago than the given window. */
  async pruneWorkerRegistry(maxAgeMs = 24 * 60 * 60 * 1_000): Promise<number> {
    const result = await this.database.query<{ count: number }>(
      "SELECT workhorse.prune_worker_registry_v1(make_interval(secs => $1)) AS count",
      [maxAgeMs / 1_000],
    );
    return result.rows[0]!.count;
  }

  async tick(
    options: { promoteLimit?: number; recoverLimit?: number } = {},
  ): Promise<MaintenancePhaseResult[]> {
    return this.maintenanceSpan("tick", () =>
      withSpan("workhorse.recovery", {}, async (span) => {
        const result = await this.database.query<MaintenancePhaseRow>(
          "SELECT * FROM workhorse.tick_v1($1, $2)",
          [options.promoteLimit ?? 1_000, options.recoverLimit ?? 1_000],
        );
        const recovery = result.rows.find((row) => row.phase === "recover");
        if (recovery !== undefined) {
          span.setAttribute("workhorse.recovery.skipped", recovery.skipped_lock);
          if (!recovery.skipped_lock && recovery.error === null) {
            recordRecoveryTelemetry(span, recovery);
          }
        }
        return result.rows.map(maintenancePhaseResult);
      }),
    );
  }

  async prepareHistoryPartitions(
    options: { force?: boolean; now?: Date } = {},
  ): Promise<MaintenancePhaseResult[]> {
    return this.maintenanceSpan("history_partitions", async () => {
      const result = await this.database.query<MaintenancePhaseRow>(
        "SELECT * FROM workhorse.prepare_history_partitions_v1($1, $2)",
        [options.force ?? false, options.now ?? new Date()],
      );
      return result.rows.map(maintenancePhaseResult);
    });
  }

  /**
   * Materialize closed minutes of rolling statistics and advance the rollup watermark.
   *
   * Operator time windows read these aggregates instead of scanning retained history, so this pass
   * is what keeps a dashboard's cost proportional to the window rather than to throughput. It is
   * safe to run from every worker and safe to run repeatedly: a bucket is a pure function of the
   * raw history in its minute, and passes serialize on an advisory lock.
   */
  async rollupStatistics(
    options: { now?: Date; maxBuckets?: number; recomputeBuckets?: number } = {},
  ): Promise<MaintenancePhaseResult[]> {
    return this.maintenanceSpan("statistics_rollup", async () => {
      const result = await this.database.query<MaintenancePhaseRow>(
        "SELECT * FROM workhorse.rollup_stats_v1($1, $2, $3)",
        [options.now ?? new Date(), options.maxBuckets ?? 240, options.recomputeBuckets ?? 2],
      );
      return result.rows.map(maintenancePhaseResult);
    });
  }

  async retainHistory(
    options: { force?: boolean; now?: Date } = {},
  ): Promise<MaintenancePhaseResult[]> {
    return this.maintenanceSpan("history_retention", async () => {
      const result = await this.database.query<MaintenancePhaseRow>(
        "SELECT * FROM workhorse.retain_history_v1($1, $2)",
        [options.force ?? false, options.now ?? new Date()],
      );
      return result.rows.map(maintenancePhaseResult);
    });
  }

  async pruneTerminalStorage(
    options: { force?: boolean; now?: Date } = {},
  ): Promise<MaintenancePhaseResult[]> {
    return this.maintenanceSpan("terminal_storage", async () => {
      const result = await this.database.query<MaintenancePhaseRow>(
        "SELECT * FROM workhorse.prune_terminal_storage_v1($1, $2)",
        [options.force ?? false, options.now ?? new Date()],
      );
      return result.rows.map(maintenancePhaseResult);
    });
  }

  private maintenanceSpan(
    operation: string,
    run: () => Promise<MaintenancePhaseResult[]>,
  ): Promise<MaintenancePhaseResult[]> {
    return withSpan(
      "workhorse.maintenance",
      { "workhorse.maintenance.operation": operation },
      async (span) => {
        const results = await run();
        span.setAttribute(
          "workhorse.maintenance.rows_affected",
          results.reduce((total, result) => total + result.rowsAffected, 0),
        );
        return results;
      },
    );
  }

  async syncRetentionPolicy(definition: RetentionPolicyDefinition): Promise<RetentionPolicy> {
    const result = await this.database.query<RetentionPolicyRow>(
      `SELECT (policy).* FROM workhorse.sync_retention_policy_v1(
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11
       ) policy`,
      [
        definition.jobIdentityRetentionDays,
        definition.terminalOutcomeRetentionDays,
        definition.jobEventRetentionDays,
        definition.attemptHistoryRetentionDays,
        definition.scheduleOccurrenceRetentionDays,
        definition.statisticsRetentionDays,
        definition.terminalJobPruneLimit ?? null,
        definition.historyPartitionsPerPass ?? null,
        definition.defaultPartitionRowsPerPass ?? null,
        definition.occurrenceRowsPerPass ?? null,
        definition.statisticsRowsPerPass ?? null,
      ],
    );
    return retentionPolicy(result.rows[0]!);
  }

  async getRetentionPolicy(): Promise<RetentionPolicy> {
    const result = await this.database.query<RetentionPolicyRow>(
      "SELECT (policy).* FROM workhorse.get_retention_policy_v1() policy",
    );
    return retentionPolicy(result.rows[0]!);
  }

  async syncMaintenancePolicy(definition: MaintenancePolicyDefinition): Promise<MaintenancePolicy> {
    const result = await this.database.query<MaintenancePolicyRow>(
      `SELECT (policy).* FROM workhorse.sync_maintenance_policy_v1($1, $2, $3, $4) policy`,
      [
        definition.timezone,
        definition.partitionPreparationIntervalMs ?? null,
        definition.terminalCleanupIntervalMs ?? null,
        definition.historyRetentionLocalHour ?? null,
      ],
    );
    return maintenancePolicy(result.rows[0]!);
  }

  async getMaintenancePolicy(): Promise<MaintenancePolicy> {
    const result = await this.database.query<MaintenancePolicyRow>(
      "SELECT (policy).* FROM workhorse.get_maintenance_policy_v1() policy",
    );
    return maintenancePolicy(result.rows[0]!);
  }

  async syncSchedules(
    namespace: string,
    definitions: readonly ScheduleDefinition[],
    options: { prune?: boolean } = {},
  ): Promise<void> {
    for (const definition of definitions) {
      try {
        CronExpressionParser.parse(definition.schedule);
      } catch (error) {
        throw new Error(`Invalid cron expression for schedule ${definition.name}`, {
          cause: error,
        });
      }
    }
    const input = definitions.map((definition) => ({
      name: definition.name,
      schedule: definition.schedule,
      enabled: definition.enabled ?? true,
      queue: definition.job.queue ?? this.defaultQueue,
      type: definition.job.type,
      payload: definition.job.payload,
      maxAttempts: definition.job.maxAttempts ?? 25,
      retryPolicy: definition.job.retryPolicy ?? null,
    }));
    await withSpan(
      "workhorse.schedule.synchronize",
      { "workhorse.schedule.definition_count": definitions.length },
      async () => {
        await this.database.query(
          "SELECT workhorse.sync_schedule_definitions_v1($1, $2::jsonb, $3)",
          [namespace, JSON.stringify(input), options.prune ?? true],
        );
      },
    );
  }

  async schedules(namespaces: readonly string[]): Promise<StoredSchedule[]> {
    if (namespaces.length === 0) return [];
    const result = await this.database.query<{
      namespace: string;
      schedule_name: string;
      cron_expression: string;
      revision: string;
      last_occurrence_at: Date | null;
    }>(
      `SELECT definition.namespace, definition.schedule_name, definition.cron_expression,
              definition.revision::text,
              max(occurrence.occurrence_at) AS last_occurrence_at
         FROM workhorse.schedule_definition definition
         LEFT JOIN workhorse.schedule_occurrence occurrence
           ON occurrence.namespace = definition.namespace
          AND occurrence.schedule_name = definition.schedule_name
        WHERE definition.enabled AND definition.namespace = ANY($1::text[])
        GROUP BY definition.namespace, definition.schedule_name
        ORDER BY definition.namespace, definition.schedule_name`,
      [namespaces],
    );
    return result.rows.map((row) => ({
      namespace: row.namespace,
      name: row.schedule_name,
      schedule: row.cron_expression,
      revision: BigInt(row.revision),
      lastOccurrenceAt: row.last_occurrence_at,
    }));
  }

  async fireSchedule(
    namespace: string,
    name: string,
    revision: bigint,
    occurrenceAt: Date,
  ): Promise<string | null> {
    const result = await this.database.query<{ job_id: string | null }>(
      "SELECT workhorse.fire_schedule_v1($1, $2, $3, $4) AS job_id",
      [namespace, name, revision.toString(), occurrenceAt.toISOString()],
    );
    return result.rows[0]!.job_id;
  }

  async runTaskNow(jobId: string): Promise<RunTaskNowResult> {
    const result = await this.database.query<{
      status: RunTaskNowStatus;
      state: string | null;
      run_at: Date | string | null;
    }>("SELECT status, state, run_at FROM workhorse.run_task_now_v1($1)", [jobId]);
    const row = result.rows[0]!;
    return {
      status: row.status,
      jobId,
      state: row.state,
      runAt: nullableClaimedTimestamp(row.run_at, "run_at"),
    };
  }

  async cancel(jobId: string, request: CancellationRequest = {}): Promise<CancelResult> {
    // PostgreSQL validates metadata and serializes cancellation with every lifecycle transition.
    // requestedBy is caller attribution only; this API does not claim authorization.
    const result = await this.database.query<CancelRow>(
      `SELECT status, state, current_attempt, requested_at, requested_by, reason, finished_at
         FROM workhorse.cancel_v1($1, $2, $3)`,
      [jobId, request.requestedBy ?? null, request.reason ?? null],
    );
    const row = result.rows[0]!;
    return {
      status: row.status,
      jobId,
      state: row.state,
      currentAttempt: row.current_attempt,
      requestedAt: row.requested_at,
      requestedBy: row.requested_by,
      reason: row.reason,
      finishedAt: row.finished_at,
    };
  }

  async listJobs(query: JobListQuery = {}): Promise<JobListPage> {
    if (typeof query !== "object" || query === null || Array.isArray(query)) {
      throw new TypeError("listJobs query must be an object");
    }
    const allowedQueryFields = new Set([
      "queue",
      "type",
      "states",
      "createdAfter",
      "createdBefore",
      "limit",
      "cursor",
      "payload",
    ]);
    for (const field of Object.keys(query)) {
      if (!allowedQueryFields.has(field)) {
        throw new TypeError(`listJobs query contains unknown field: ${field}`);
      }
    }

    const limit = query.limit ?? 100;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_JOB_QUERY_PAGE_SIZE) {
      throw new RangeError(
        `listJobs limit must be an integer between 1 and ${MAX_JOB_QUERY_PAGE_SIZE}`,
      );
    }

    validateFiniteDate(query.createdAfter, "listJobs createdAfter");
    validateFiniteDate(query.createdBefore, "listJobs createdBefore");
    if (
      query.createdAfter !== undefined &&
      query.createdBefore !== undefined &&
      query.createdAfter.getTime() >= query.createdBefore.getTime()
    ) {
      throw new RangeError("listJobs createdAfter must be earlier than createdBefore");
    }

    if (query.states !== undefined) {
      if (!Array.isArray(query.states) || query.states.length === 0) {
        throw new RangeError("listJobs states must be a non-empty array when supplied");
      }
      const uniqueStates = new Set<JobState>();
      for (const state of query.states) {
        if (!JOB_STATES.has(state))
          throw new TypeError(`listJobs state is invalid: ${String(state)}`);
        if (uniqueStates.has(state))
          throw new RangeError(`listJobs states must be unique: ${state}`);
        uniqueStates.add(state);
      }
    }

    const cursor = query.cursor;
    if (cursor !== undefined) {
      if (typeof cursor !== "object" || cursor === null) {
        throw new TypeError("listJobs cursor must be an object");
      }
      for (const field of Object.keys(cursor)) {
        if (!new Set(["createdAt", "jobId", "signature"]).has(field)) {
          throw new TypeError(`listJobs cursor contains unknown field: ${field}`);
        }
      }
      for (const [field, value] of [
        ["createdAt", cursor.createdAt],
        ["jobId", cursor.jobId],
        ["signature", cursor.signature],
      ] as const) {
        if (typeof value !== "string" || value.length === 0) {
          throw new TypeError(`listJobs cursor ${field} must be a non-empty string`);
        }
      }
    }

    if (
      query.payload !== undefined &&
      (typeof query.payload !== "object" || query.payload === null || Array.isArray(query.payload))
    ) {
      throw new TypeError("listJobs payload must be an object");
    }
    const projection = query.payload ?? {};
    for (const field of Object.keys(projection)) {
      if (!new Set(["include", "maxBytes", "redactKeys"]).has(field)) {
        throw new TypeError(`listJobs payload contains unknown field: ${field}`);
      }
    }
    if (projection.include !== undefined && typeof projection.include !== "boolean") {
      throw new TypeError("listJobs payload include must be a boolean");
    }
    if (
      projection.maxBytes !== undefined &&
      (!Number.isSafeInteger(projection.maxBytes) ||
        projection.maxBytes < 1 ||
        projection.maxBytes > MAX_JOB_QUERY_PAYLOAD_BYTES)
    ) {
      throw new RangeError(
        `listJobs payload maxBytes must be an integer between 1 and ${MAX_JOB_QUERY_PAYLOAD_BYTES}`,
      );
    }
    const redactKeys = projection.redactKeys ?? [];
    if (!Array.isArray(redactKeys)) {
      throw new TypeError("listJobs payload redactKeys must be an array");
    }
    if (redactKeys.length > MAX_JOB_QUERY_REDACT_KEYS) {
      throw new RangeError(
        `listJobs payload redactKeys must contain at most ${MAX_JOB_QUERY_REDACT_KEYS} keys`,
      );
    }
    const uniqueRedactKeys = new Set<string>();
    for (const key of redactKeys) {
      if (typeof key !== "string") {
        throw new TypeError("listJobs payload redactKeys must contain only strings");
      }
      const length = [...key].length;
      if (length < 1 || length > 200) {
        throw new RangeError("listJobs payload redactKeys must contain 1 to 200 characters");
      }
      if (uniqueRedactKeys.has(key)) {
        throw new RangeError(`listJobs payload redactKeys must be unique: ${key}`);
      }
      uniqueRedactKeys.add(key);
    }

    const payloadProjection = {
      include: projection.include ?? false,
      maxBytes: projection.maxBytes ?? DEFAULT_JOB_QUERY_PAYLOAD_BYTES,
      redactKeys,
    };
    const result = await this.database.query<JobListRow>(
      `SELECT job_id, queue_name, job_type, tags, state, current_attempt, max_attempts,
              retry_policy, deadline_at, execution_timeout_ms::text AS execution_timeout_ms,
              run_at, cancel_requested_at, cancel_requested_by, cancel_reason, created_at,
              updated_at, payload, payload_status, payload_bytes, has_more,
              cursor_created_at::text AS cursor_created_at, cursor_signature
         FROM workhorse.list_jobs_v1(
           $1::jsonb, $2::integer, $3::timestamptz, $4::uuid, $5::text, $6::jsonb
         )`,
      [
        JSON.stringify(jobListFilter(query)),
        limit,
        cursor?.createdAt ?? null,
        cursor?.jobId ?? null,
        cursor?.signature ?? null,
        JSON.stringify(payloadProjection),
      ],
    );
    const items = result.rows.map(jobListItem);
    const last = result.rows.at(-1);
    return {
      items,
      nextCursor:
        last?.has_more === true
          ? {
              createdAt: last.cursor_created_at,
              jobId: last.job_id,
              signature: last.cursor_signature,
            }
          : null,
    };
  }

  async getJobTimeline(jobId: string, query: JobTimelineQuery = {}): Promise<JobTimelinePage> {
    const limit = query.limit ?? 100;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_JOB_QUERY_PAGE_SIZE) {
      throw new RangeError(
        `getJobTimeline limit must be an integer between 1 and ${MAX_JOB_QUERY_PAGE_SIZE}`,
      );
    }

    const cursor = query.cursor;
    if (cursor !== undefined) {
      if (typeof cursor !== "object" || cursor === null) {
        throw new TypeError("getJobTimeline cursor must be an object");
      }
      for (const [field, value] of [
        ["jobId", cursor.jobId],
        ["occurredAt", cursor.occurredAt],
        ["recordId", cursor.recordId],
      ] as const) {
        if (typeof value !== "string" || value.length === 0) {
          throw new TypeError(`getJobTimeline cursor ${field} must be a non-empty string`);
        }
      }
      if (cursor.kind !== "event" && cursor.kind !== "attempt") {
        throw new TypeError("getJobTimeline cursor kind must be event or attempt");
      }
      if (cursor.jobId !== jobId) {
        throw new RangeError("getJobTimeline cursor jobId must match the requested jobId");
      }
    }

    const result = await this.database.query<JobTimelineRow>(
      `SELECT kind, record_id::text AS record_id, attempt, event_type, details,
              fence_token::text AS fence_token, worker_id, outcome, started_at, claimed_at,
              finished_at, error, occurred_at, has_more,
              cursor_occurred_at::text AS cursor_occurred_at
         FROM workhorse.list_job_timeline_v1(
           $1::uuid, $2::integer, $3::timestamptz, $4::text, $5::bigint
         )`,
      [jobId, limit, cursor?.occurredAt ?? null, cursor?.kind ?? null, cursor?.recordId ?? null],
    );
    const items = result.rows.map(jobTimelineEntry);
    const last = result.rows.at(-1);
    return {
      items,
      nextCursor:
        last?.has_more === true
          ? {
              jobId,
              occurredAt: last.cursor_occurred_at,
              kind: last.kind,
              recordId: last.record_id,
            }
          : null,
    };
  }

  async listDeadLetters(query: DeadLetterQuery = {}): Promise<DeadLetterPage> {
    const limit = query.limit ?? 100;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_REDRIVE_BATCH_SIZE) {
      throw new RangeError(
        `listDeadLetters limit must be an integer between 1 and ${MAX_REDRIVE_BATCH_SIZE}`,
      );
    }
    const result = await this.database.query<DeadLetterRow>(
      "SELECT * FROM workhorse.list_dead_letters_v1($1::jsonb, $2, $3, $4)",
      [
        JSON.stringify(deadLetterFilter(query)),
        limit,
        query.cursor?.finishedAt ?? null,
        query.cursor?.jobId ?? null,
      ],
    );
    const items = result.rows.map(deadLetter);
    const last = items.at(-1);
    return {
      items,
      nextCursor:
        result.rows.at(-1)?.has_more === true && last !== undefined
          ? { finishedAt: result.rows.at(-1)!.cursor_finished_at, jobId: last.jobId }
          : null,
    };
  }

  async redrive(sourceJobId: string, request: RedriveRequest): Promise<RedriveResult> {
    try {
      const result = await this.database.query<RedriveRow>(
        "SELECT * FROM workhorse.redrive_v1($1, $2, $3, $4)",
        [sourceJobId, request.requestedBy, request.reason, request.requestId],
      );
      const row = result.rows[0];
      if (!row) throw new Error("redrive_v1 returned no result");
      return redriveResult(row);
    } catch (error) {
      throw redriveConflict(error) ?? error;
    }
  }

  async redriveMany(
    filter: DeadLetterFilter,
    request: RedriveRequest,
    options: BulkRedriveOptions = {},
  ): Promise<BulkRedrivePage> {
    const limit = options.limit ?? 100;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_REDRIVE_BATCH_SIZE) {
      throw new RangeError(
        `redriveMany limit must be an integer between 1 and ${MAX_REDRIVE_BATCH_SIZE}`,
      );
    }
    try {
      const result = await this.database.query<BulkRedriveRow>(
        "SELECT status, source_job_id, target_job_id, source_state, target_state, requested_at, source_finished_at_cursor, has_more FROM workhorse.redrive_many_v1($1::jsonb, $2, $3, $4, $5, $6, $7, $8) ORDER BY ordinal",
        [
          JSON.stringify(deadLetterFilter(filter)),
          limit,
          options.dryRun ?? false,
          request.requestedBy,
          request.reason,
          request.requestId,
          options.cursor?.finishedAt ?? null,
          options.cursor?.jobId ?? null,
        ],
      );
      const last = result.rows.at(-1);
      return {
        results: result.rows.map(redriveResult),
        nextCursor:
          last?.has_more === true
            ? {
                finishedAt: last.source_finished_at_cursor,
                jobId: last.source_job_id,
              }
            : null,
      };
    } catch (error) {
      throw redriveConflict(error) ?? error;
    }
  }

  async getRedriveLineage(jobId: string, limit = MAX_REDRIVE_BATCH_SIZE): Promise<RedriveLineage> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_REDRIVE_BATCH_SIZE) {
      throw new RangeError(
        `getRedriveLineage limit must be an integer between 1 and ${MAX_REDRIVE_BATCH_SIZE}`,
      );
    }
    const result = await this.database.query<RedriveLineageRow>(
      `WITH RECURSIVE connected_edges AS (
         SELECT edge.* FROM workhorse.job_redrive edge
          WHERE edge.source_job_id = $1 OR edge.target_job_id = $1
         UNION
         SELECT edge.*
           FROM connected_edges connected
           JOIN workhorse.job_redrive edge
             ON edge.source_job_id IN (connected.source_job_id, connected.target_job_id)
             OR edge.target_job_id IN (connected.source_job_id, connected.target_job_id)
       )
       SELECT bounded.source_job_id, bounded.target_job_id, bounded.requested_by, bounded.reason,
              bounded.request_id_preview, bounded.request_id_digest, bounded.request_id_length,
              bounded.source_state, bounded.target_initial_state, bounded.requested_at
         FROM (SELECT * FROM connected_edges LIMIT $2) bounded
        ORDER BY bounded.requested_at, bounded.source_job_id, bounded.target_job_id`,
      [jobId, limit + 1],
    );
    return {
      records: result.rows.slice(0, limit).map(redriveLineageRecord),
      truncated: result.rows.length > limit,
    };
  }

  async claim<TPayload = Json>(
    workerId: string,
    options: { queue?: string; leaseMs?: number } = {},
  ): Promise<ClaimedJob<TPayload> | null> {
    const queueName = options.queue ?? this.defaultQueue;
    const startedAt = performance.now();
    return withSpan("workhorse.claim", { "workhorse.queue.name": queueName }, async (span) => {
      // claim_v1 commits ownership before returning the payload. Handler code must run only after
      // this query resolves so no row lock or claim transaction spans user code.
      const result = await this.database.query<ClaimRow>(
        "SELECT * FROM workhorse.claim_v1($1, $2, $3)",
        [queueName, workerId, options.leaseMs ?? 30_000],
      );
      const row = result.rows[0];
      telemetryMetrics.claimDuration.record(performance.now() - startedAt, {
        "workhorse.queue.name": queueName,
        "workhorse.claim.result": row === undefined ? "empty" : "claimed",
      });
      if (!row) return null;
      span.setAttributes({
        "workhorse.job.id": row.job_id,
        "workhorse.job.type": row.job_type,
        "workhorse.job.attempt": row.attempt,
      });
      telemetryMetrics.claimed.add(1, {
        "workhorse.queue.name": queueName,
        "workhorse.job.type": row.job_type,
      });
      return {
        id: row.job_id,
        queue: queueName,
        type: row.job_type,
        payload: row.payload as TPayload,
        traceContext: row.trace_context,
        attempt: row.attempt,
        maxAttempts: row.max_attempts,
        retryPolicy: row.retry_policy,
        deadlineAt: nullableClaimedTimestamp(row.deadline_at, "deadline_at"),
        executionTimeoutMs:
          row.execution_timeout_ms === null ? null : Number(row.execution_timeout_ms),
        attemptTimeoutAt: nullableClaimedTimestamp(row.attempt_timeout_at, "attempt_timeout_at"),
        fenceToken: BigInt(row.fence_token),
        leaseExpiresAt: claimedTimestamp(row.lease_expires_at, "lease_expires_at"),
      };
    });
  }

  async heartbeat(job: ClaimedJob<unknown>, workerId: string, leaseMs = 30_000): Promise<boolean> {
    return (await this.heartbeatStatus(job, workerId, leaseMs)) === "accepted";
  }

  async heartbeatStatus(
    job: ClaimedJob<unknown>,
    workerId: string,
    leaseMs = 30_000,
  ): Promise<HeartbeatStatus> {
    return withSpan("workhorse.heartbeat", jobSpanAttributes(job), async (span) => {
      // Cancellation and stale ownership both stop compatibility callers, while workers can use the
      // status API to deliver a distinct cooperative cancellation signal.
      const result = await this.database.query<{ status: HeartbeatStatus }>(
        "SELECT workhorse.heartbeat_v2($1, $2, $3, $4) AS status",
        [job.id, workerId, job.fenceToken.toString(), leaseMs],
      );
      const status = result.rows[0]!.status;
      span.setAttribute("workhorse.heartbeat.status", status);
      return status;
    });
  }

  async expireOwned(job: ClaimedJob<unknown>, workerId: string): Promise<ExpireOwnedStatus> {
    const result = await this.database.query<{
      status: ExpireOwnedStatus;
      retry_state: "ready" | "scheduled" | null;
    }>("SELECT * FROM workhorse.expire_owned_telemetry_v1($1, $2, $3)", [
      job.id,
      workerId,
      job.fenceToken.toString(),
    ]);
    const expiration = result.rows[0]!;
    if (expiration.retry_state !== null) {
      await withSpan("workhorse.retry", jobSpanAttributes(job), async (span) => {
        span.setAttribute("workhorse.retry.outcome", expiration.retry_state!);
        telemetryMetrics.retried.add(1, jobMetricAttributes(job));
      });
    }
    return expiration.status;
  }

  async acknowledgeCancel(job: ClaimedJob<unknown>, workerId: string): Promise<boolean> {
    const result = await this.database.query<{ accepted: boolean }>(
      "SELECT workhorse.acknowledge_cancel_v1($1, $2, $3) AS accepted",
      [job.id, workerId, job.fenceToken.toString()],
    );
    return result.rows[0]!.accepted;
  }

  async getCheckpoint<TValue extends Json = Json>(
    jobId: string,
    name: string,
  ): Promise<JobCheckpoint<TValue> | null> {
    const result = await this.database.query<CheckpointRow>(
      `SELECT job_id, checkpoint_name, checkpoint_value, attempt, fence_token::text,
              worker_id, created_at
         FROM workhorse.job_checkpoint
        WHERE job_id = $1 AND checkpoint_name = $2`,
      [jobId, name],
    );
    const row = result.rows[0];
    return row ? checkpointRecord<TValue>(row) : null;
  }

  async listCheckpoints<TValue extends Json = Json>(
    jobId: string,
  ): Promise<JobCheckpoint<TValue>[]> {
    const result = await this.database.query<CheckpointRow>(
      `SELECT job_id, checkpoint_name, checkpoint_value, attempt, fence_token::text,
              worker_id, created_at
         FROM workhorse.job_checkpoint
        WHERE job_id = $1
        ORDER BY created_at, checkpoint_name`,
      [jobId],
    );
    return result.rows.map((row) => checkpointRecord<TValue>(row));
  }

  async saveCheckpoint<TValue extends Json>(
    job: ClaimedJob<unknown>,
    workerId: string,
    name: string,
    value: TValue,
  ): Promise<JobCheckpoint<TValue>> {
    const encodedValue = JSON.stringify(value);
    if (encodedValue === undefined) {
      throw new TypeError("Checkpoint value must be JSON serializable");
    }
    const result = await this.database.query<SaveCheckpointRow>(
      `SELECT status, checkpoint_value, attempt, fence_token::text, worker_id, created_at
         FROM workhorse.save_checkpoint_v1($1, $2, $3, $4, $5::jsonb)`,
      [job.id, workerId, job.fenceToken.toString(), name, encodedValue],
    );
    const row = result.rows[0]!;
    if (row.status === "stale") throw new CheckpointLeaseLostError(job.id, name);
    if (row.status === "conflict") throw new CheckpointConflictError(job.id, name);
    if (row.status !== "saved" && row.status !== "existing") {
      throw new Error(`Unexpected checkpoint status: ${String(row.status)}`);
    }
    return checkpointRecord<TValue>({
      ...row,
      job_id: job.id,
      checkpoint_name: name,
    });
  }

  async getProgress<TValue extends Json = Json>(
    jobId: string,
  ): Promise<JobProgress<TValue> | null> {
    const result = await this.database.query<ProgressRow>(
      `SELECT job_id, progress_value, revision::text, attempt, fence_token::text,
              worker_id, created_at, updated_at
         FROM workhorse.job_progress
        WHERE job_id = $1`,
      [jobId],
    );
    const row = result.rows[0];
    return row ? progressRecord<TValue>(row) : null;
  }

  async updateProgress<TValue extends Json>(
    job: ClaimedJob<unknown>,
    workerId: string,
    value: TValue,
  ): Promise<JobProgress<TValue>> {
    const encodedValue = JSON.stringify(value);
    if (encodedValue === undefined) {
      throw new TypeError("Progress value must be JSON serializable");
    }
    const result = await this.database.query<UpdateProgressRow>(
      `SELECT status, progress_value, revision::text, attempt, fence_token::text,
              worker_id, created_at, updated_at, retry_after_ms::text
         FROM workhorse.update_progress_v1($1, $2, $3, $4::jsonb)`,
      [job.id, workerId, job.fenceToken.toString(), encodedValue],
    );
    const row = result.rows[0]!;
    if (row.status === "stale") throw new ProgressLeaseLostError(job.id);
    if (row.status === "rate_limited") {
      throw new ProgressRateLimitError(job.id, Number(row.retry_after_ms));
    }
    if (row.status !== "updated" && row.status !== "unchanged") {
      throw new Error(`Unexpected progress status: ${String(row.status)}`);
    }
    return progressRecord<TValue>({ ...row, job_id: job.id });
  }

  async getWait(jobId: string, name: string): Promise<JobWait | null> {
    validateWaitName(name);
    const result = await this.database.query<WaitRow>(
      `SELECT job_id, wait_name, mode, duration_ms::text, requested_wake_at, wake_at,
              attempt, fence_token::text, worker_id, created_at
         FROM workhorse.job_wait
        WHERE job_id = $1 AND wait_name = $2`,
      [jobId, name],
    );
    const row = result.rows[0];
    return row ? waitRecord(row) : null;
  }

  async listWaits(jobId: string): Promise<JobWait[]> {
    const result = await this.database.query<WaitRow>(
      `SELECT job_id, wait_name, mode, duration_ms::text, requested_wake_at, wake_at,
              attempt, fence_token::text, worker_id, created_at
         FROM workhorse.job_wait
        WHERE job_id = $1
        ORDER BY created_at, wait_name`,
      [jobId],
    );
    return result.rows.map(waitRecord);
  }

  async scheduleWait(
    job: ClaimedJob<unknown>,
    workerId: string,
    name: string,
    request: ScheduleWaitRequest,
  ): Promise<ScheduleWaitResult> {
    validateWaitName(name);
    if (typeof workerId !== "string" || workerId.length === 0) {
      throw new TypeError("Worker ID must be a non-empty string");
    }

    const hasDuration = "durationMs" in request && request.durationMs !== undefined;
    const hasWakeAt = "wakeAt" in request && request.wakeAt !== undefined;
    if (hasDuration === hasWakeAt) {
      throw new TypeError("Exactly one of durationMs or wakeAt is required");
    }

    let durationWire: string | null = null;
    let wakeAtWire: string | null = null;
    if (hasDuration) {
      const durationMs = request.durationMs;
      if (!Number.isSafeInteger(durationMs)) {
        throw new TypeError("Wait durationMs must be a safe integer number of milliseconds");
      }
      if (durationMs < 1 || durationMs > MAX_WAIT_DURATION_MS) {
        throw new RangeError(`Wait durationMs must be between 1 and ${MAX_WAIT_DURATION_MS}`);
      }
      // pg must receive bigint as text so JavaScript never rounds the wire value.
      durationWire = durationMs.toString();
    } else {
      const wakeAt = request.wakeAt;
      if (!(wakeAt instanceof Date) || !Number.isFinite(wakeAt.getTime())) {
        throw new TypeError("Wait wakeAt must be a finite Date");
      }
      if (wakeAt.getTime() - Date.now() > MAX_WAIT_DURATION_MS) {
        throw new RangeError("Wait wakeAt must be no more than 365 days in the future");
      }
      wakeAtWire = wakeAt.toISOString();
    }

    const result = await this.database.query<ScheduleWaitRow>(
      `SELECT status, wait_name, mode, duration_ms::text, requested_wake_at, wake_at,
              attempt, fence_token::text, worker_id, created_at
         FROM workhorse.schedule_wait_v1($1, $2, $3, $4, $5::bigint, $6::timestamptz)`,
      [job.id, workerId, job.fenceToken.toString(), name, durationWire, wakeAtWire],
    );
    const row = result.rows[0]!;
    if (row.status === "stale") throw new WaitLeaseLostError(job.id, name);
    if (row.status === "conflict") {
      throw new WaitConflictError(job.id, name, waitRecord({ ...row, job_id: job.id }));
    }
    if (row.status === "limit_exceeded") throw new WaitLimitExceededError(job.id);
    if (row.status !== "scheduled" && row.status !== "elapsed") {
      throw new Error(`Unexpected wait status: ${String(row.status)}`);
    }
    return {
      status: row.status,
      wait: waitRecord({ ...row, job_id: job.id }),
    };
  }

  async complete<TResult extends Json>(
    job: ClaimedJob<unknown>,
    workerId: string,
    result: TResult,
  ): Promise<boolean> {
    return withSpan("workhorse.complete", jobSpanAttributes(job), async (span) => {
      // Completion is conditional on the exact unexpired lease and fence. A stale worker gets false
      // rather than overwriting the result of a recovered attempt.
      const query = await this.database.query<{ accepted: boolean }>(
        "SELECT workhorse.complete_v1($1, $2, $3, $4::jsonb) AS accepted",
        [job.id, workerId, job.fenceToken.toString(), JSON.stringify(result)],
      );
      const accepted = query.rows[0]!.accepted;
      span.setAttribute("workhorse.complete.accepted", accepted);
      if (accepted) telemetryMetrics.completed.add(1, jobMetricAttributes(job));
      return accepted;
    });
  }

  async fail(
    job: ClaimedJob<unknown>,
    workerId: string,
    error: unknown,
    retryDelayMs?: number,
  ): Promise<
    | "ready"
    | "scheduled"
    | "failed"
    | "cancel_requested"
    | "deadline_exceeded"
    | "timeout_exceeded"
    | "stale"
  > {
    return withSpan("workhorse.retry", jobSpanAttributes(job), async (span) => {
      // PostgreSQL decides whether retry budget remains and atomically closes the old attempt before
      // creating the next projection. Undefined selects SQL-owned backoff; a number explicitly
      // overrides it, including zero for an immediate retry.
      const result = await this.database.query<{
        state:
          | "ready"
          | "scheduled"
          | "failed"
          | "cancel_requested"
          | "deadline_exceeded"
          | "timeout_exceeded"
          | "stale";
      }>("SELECT workhorse.fail_v1($1, $2, $3, $4::jsonb, $5) AS state", [
        job.id,
        workerId,
        job.fenceToken.toString(),
        JSON.stringify(errorEnvelope(error)),
        retryDelayMs ?? null,
      ]);
      const state = result.rows[0]!.state;
      span.setAttribute("workhorse.retry.outcome", state);
      telemetryMetrics.failed.add(1, {
        ...jobMetricAttributes(job),
        "workhorse.attempt.outcome": state,
      });
      if (state === "ready" || state === "scheduled") {
        telemetryMetrics.retried.add(1, jobMetricAttributes(job));
      }
      return state;
    });
  }

  async recoverExpired(limit = 100, retryDelayMs?: number): Promise<number> {
    return withSpan("workhorse.recovery", {}, async (span) => {
      // Recovery may be called by many workers. SKIP LOCKED inside the function partitions work
      // between callers while fence checks prevent an old lease from recovering a newer attempt.
      const result = await this.database.query<{
        rows_affected: number;
        expired_leases: number;
        retried: number;
        retry_dimensions: Array<{ queue: string; type: string }>;
      }>("SELECT * FROM workhorse.recover_expired_telemetry_v1($1, $2)", [
        limit,
        retryDelayMs ?? null,
      ]);
      const recovery = result.rows[0]!;
      recordRecoveryTelemetry(span, recovery);
      return recovery.rows_affected;
    });
  }

  async getJob<TResult = Json>(id: string): Promise<JobSnapshot<TResult> | null> {
    // A job exists in exactly one lifecycle relation: runtime while live, outcome when terminal.
    const result = await this.database.query<{
      id: string;
      queue_name: string;
      job_type: string;
      payload: Json;
      tags: string[];
      state: JobSnapshot["state"];
      current_attempt: number;
      max_attempts: number;
      retry_policy: RetryPolicy | null;
      deadline_at: Date | null;
      execution_timeout_ms: string | null;
      version: string;
      run_at: Date;
      result: TResult | null;
      error: Json | null;
      cancel_requested_at: Date | null;
      cancel_requested_by: string | null;
      cancel_reason: string | null;
      progress_value: Json | null;
      progress_revision: string | null;
      progress_attempt: number | null;
      progress_fence_token: string | null;
      progress_worker_id: string | null;
      progress_created_at: Date | null;
      progress_updated_at: Date | null;
      created_at: Date;
      updated_at: Date;
    }>(
      `SELECT j.id, j.queue_name, j.job_type, j.payload, j.tags, j.retry_policy,
              j.deadline_at, j.execution_timeout_ms::text,
              COALESCE(r.state, o.state) AS state,
              COALESCE(r.current_attempt, o.current_attempt) AS current_attempt,
              j.max_attempts, COALESCE(r.fence_token, o.fence_token) AS version,
              COALESCE(r.run_at, o.run_at) AS run_at, o.result,
              COALESCE(r.error, o.error) AS error, r.cancel_requested_at,
              r.cancel_requested_by, r.cancel_reason,
              p.progress_value, p.revision::text AS progress_revision,
              p.attempt AS progress_attempt, p.fence_token::text AS progress_fence_token,
              p.worker_id AS progress_worker_id, p.created_at AS progress_created_at,
              p.updated_at AS progress_updated_at, j.created_at,
              COALESCE(r.updated_at, o.updated_at) AS updated_at
         FROM workhorse.job j
         LEFT JOIN workhorse.job_runtime r ON r.job_id = j.id
         LEFT JOIN workhorse.job_outcome o ON o.job_id = j.id
         LEFT JOIN workhorse.job_progress p ON p.job_id = j.id
        WHERE j.id = $1`,
      [id],
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      id: row.id,
      queue: row.queue_name,
      type: row.job_type,
      payload: row.payload,
      tags: row.tags,
      state: row.state,
      currentAttempt: row.current_attempt,
      maxAttempts: row.max_attempts,
      retryPolicy: row.retry_policy,
      deadlineAt: row.deadline_at,
      executionTimeoutMs:
        row.execution_timeout_ms === null ? null : Number(row.execution_timeout_ms),
      fenceToken: BigInt(row.version),
      runAt: row.run_at,
      result: row.result,
      error: row.error,
      cancelRequestedAt: row.cancel_requested_at,
      cancelRequestedBy: row.cancel_requested_by,
      cancelReason: row.cancel_reason,
      progress:
        row.progress_revision === null
          ? null
          : progressRecord({
              job_id: row.id,
              progress_value: row.progress_value,
              revision: row.progress_revision,
              attempt: row.progress_attempt!,
              fence_token: row.progress_fence_token!,
              worker_id: row.progress_worker_id!,
              created_at: row.progress_created_at!,
              updated_at: row.progress_updated_at!,
            }),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  async health(): Promise<QueueHealth> {
    // Run independent read-only diagnostics concurrently. PostgreSQL statistics are observations,
    // not transactional facts, and can lag until the statistics collector flushes.
    const [version, counts, depths, relations, activity, notification, retention, statistics] =
      await Promise.all([
        this.database.query<{ version: number }>(
          `SELECT CASE
                  WHEN count(*) = 1
                   AND min(version) = max(version)
                   AND NOT EXISTS (
                     SELECT 1
                       FROM unnest(ARRAY['job_current', 'ready_job', 'scheduled_job', 'lease'])
                         AS legacy(relation_name)
                      WHERE to_regclass(format('workhorse.%I', relation_name)) IS NOT NULL
                   )
                  THEN min(version)::integer
                  ELSE NULL
                END AS version
           FROM workhorse.schema_version`,
        ),
        this.database.query<{ state: JobSnapshot["state"]; count: string }>(
          `SELECT state, count(*)::text AS count
           FROM (SELECT state FROM workhorse.job_runtime UNION ALL
                 SELECT state FROM workhorse.job_outcome) lifecycle
          GROUP BY state`,
        ),
        this.database.query<{
          ready: string;
          scheduled: string;
          sleeping: string;
          overdue_waits: string;
          next_wake_at: Date | null;
          active: string;
          expired: string;
          oldest_ready_age_ms: number | null;
          pending_deadlines: string;
          overdue_deadlines: string;
          deadlines_due_within_minute: string;
          earliest_deadline_at: Date | null;
          active_execution_timeouts: string;
          overdue_execution_timeouts: string;
        }>(`
        SELECT count(*) FILTER (WHERE state = 'ready')::text AS ready,
               count(*) FILTER (WHERE state = 'scheduled')::text AS scheduled,
               count(*) FILTER (WHERE state = 'scheduled' AND wait_name IS NOT NULL)::text AS sleeping,
               count(*) FILTER (
                 WHERE state = 'scheduled' AND wait_name IS NOT NULL
                   AND run_at <= clock_timestamp()
               )::text AS overdue_waits,
               min(run_at) FILTER (
                 WHERE state = 'scheduled' AND wait_name IS NOT NULL
               ) AS next_wake_at,
               count(*) FILTER (WHERE state = 'active')::text AS active,
               count(*) FILTER (WHERE state = 'active' AND expires_at <= clock_timestamp())::text AS expired,
               extract(epoch FROM clock_timestamp() - min(ready_at) FILTER (WHERE state = 'ready')) * 1000
                 AS oldest_ready_age_ms,
               count(*) FILTER (WHERE deadline_at IS NOT NULL)::text AS pending_deadlines,
               count(*) FILTER (
                 WHERE deadline_at IS NOT NULL AND deadline_at <= clock_timestamp()
               )::text AS overdue_deadlines,
               count(*) FILTER (
                 WHERE deadline_at > clock_timestamp()
                   AND deadline_at <= clock_timestamp() + interval '1 minute'
               )::text AS deadlines_due_within_minute,
               min(deadline_at) AS earliest_deadline_at,
               count(*) FILTER (
                 WHERE state = 'active' AND attempt_timeout_at IS NOT NULL
               )::text AS active_execution_timeouts,
               count(*) FILTER (
                 WHERE state = 'active' AND attempt_timeout_at <= clock_timestamp()
               )::text AS overdue_execution_timeouts
          FROM workhorse.job_runtime`),
        this.database.query<{
          relation: string;
          total_bytes: string;
          table_bytes: string;
          index_bytes: string;
          live_tuples: string;
          dead_tuples: string;
          modifications_since_analyze: string;
          hot_update_ratio: number | null;
          last_vacuum: Date | null;
          last_autovacuum: Date | null;
          partitions: string;
        }>(`
        -- Partitioned parents own no storage themselves, so a plain pg_class lookup reports the two
        -- largest relations as empty. Summing each partition tree is what makes history visible.
        SELECT parent.relname AS relation,
               sum(pg_total_relation_size(COALESCE(tree.relid, parent.oid)))::text AS total_bytes,
               sum(pg_relation_size(COALESCE(tree.relid, parent.oid)))::text AS table_bytes,
               sum(pg_indexes_size(COALESCE(tree.relid, parent.oid)))::text AS index_bytes,
               sum(COALESCE(s.n_live_tup, 0))::text AS live_tuples,
               sum(COALESCE(s.n_dead_tup, 0))::text AS dead_tuples,
               sum(COALESCE(s.n_mod_since_analyze, 0))::text AS modifications_since_analyze,
               CASE WHEN sum(COALESCE(s.n_tup_upd, 0)) = 0 THEN NULL
                    ELSE sum(s.n_tup_hot_upd)::double precision / sum(s.n_tup_upd) END
                 AS hot_update_ratio,
               max(s.last_vacuum) AS last_vacuum, max(s.last_autovacuum) AS last_autovacuum,
               count(*) FILTER (WHERE tree.relid IS NOT NULL AND tree.relid <> parent.oid)::text
                 AS partitions
          FROM pg_class parent
          JOIN pg_namespace n ON n.oid = parent.relnamespace
          -- pg_partition_tree returns no rows for an ordinary table, so the join must be outer and
          -- fall back to the relation itself. A plain inner join silently drops every unpartitioned
          -- relation from health, which is most of them.
          LEFT JOIN LATERAL pg_partition_tree(parent.oid) tree ON true
          LEFT JOIN pg_stat_user_tables s ON s.relid = COALESCE(tree.relid, parent.oid)
         WHERE n.nspname = 'workhorse' AND parent.relkind IN ('r', 'p')
           AND parent.relispartition = false
         GROUP BY parent.relname, parent.oid
         ORDER BY parent.relname`),
        this.database.query<{ age_ms: number | null; lock_wait_count: string }>(`
        SELECT extract(epoch FROM clock_timestamp() - min(xact_start)) * 1000 AS age_ms,
               count(*) FILTER (WHERE wait_event_type = 'Lock')::text AS lock_wait_count
          FROM pg_stat_activity WHERE pid <> pg_backend_pid()`),
        this.database.query<{ usage: number }>("SELECT pg_notification_queue_usage() AS usage"),
        this.database.query<
          RetentionPolicyRow & {
            oldest_job_identity_at: Date | null;
            oldest_terminal_outcome_at: Date | null;
            oldest_job_event_at: Date | null;
            oldest_attempt_history_at: Date | null;
            oldest_schedule_occurrence_at: Date | null;
            oldest_statistics_at: Date | null;
            job_identity_lag_ms: number | null;
            terminal_outcome_lag_ms: number | null;
            job_event_lag_ms: number | null;
            attempt_history_lag_ms: number | null;
            schedule_occurrence_lag_ms: number | null;
            statistics_lag_ms: number | null;
            eligible_event_partitions: string;
            eligible_attempt_partitions: string;
            default_event_rows: string;
            default_attempt_rows: string;
            default_event_rows_capped: boolean;
            default_attempt_rows_capped: boolean;
          }
        >(`
        WITH policy AS (
          SELECT * FROM workhorse.retention_policy WHERE singleton
        ), boundaries AS (
          SELECT
            (SELECT job.created_at
               FROM workhorse.job job
               JOIN workhorse.job_outcome outcome ON outcome.job_id = job.id
              ORDER BY job.created_at, job.id LIMIT 1)
              AS oldest_job_identity_at,
            (SELECT finished_at FROM workhorse.job_outcome ORDER BY finished_at, job_id LIMIT 1)
              AS oldest_terminal_outcome_at,
            (SELECT job.created_at
               FROM workhorse.job job
               JOIN workhorse.job_outcome outcome ON outcome.job_id = job.id
              WHERE policy.job_identity_retention_days IS NOT NULL
                AND policy.terminal_outcome_retention_days IS NOT NULL
                AND job.created_at < clock_timestamp()
                  - make_interval(days => policy.job_identity_retention_days)
                AND outcome.finished_at < clock_timestamp()
                  - make_interval(days => policy.terminal_outcome_retention_days)
              ORDER BY job.created_at, job.id LIMIT 1)
              AS eligible_job_identity_at,
            (SELECT outcome.finished_at
               FROM workhorse.job job
               JOIN workhorse.job_outcome outcome ON outcome.job_id = job.id
              WHERE policy.job_identity_retention_days IS NOT NULL
                AND policy.terminal_outcome_retention_days IS NOT NULL
                AND job.created_at < clock_timestamp()
                  - make_interval(days => policy.job_identity_retention_days)
                AND outcome.finished_at < clock_timestamp()
                  - make_interval(days => policy.terminal_outcome_retention_days)
              ORDER BY outcome.finished_at, outcome.job_id LIMIT 1)
              AS eligible_terminal_outcome_at,
            (SELECT occurred_at FROM workhorse.job_event ORDER BY occurred_at, event_id LIMIT 1)
              AS oldest_job_event_at,
            (SELECT occurred_at FROM workhorse.job_event
              WHERE tableoid <> 'workhorse.job_event_default'::regclass
              ORDER BY occurred_at, event_id LIMIT 1) AS oldest_partitioned_job_event_at,
            (SELECT occurred_at FROM workhorse.job_event_default
              ORDER BY occurred_at, event_id LIMIT 1) AS oldest_default_job_event_at,
            (SELECT occurred_at FROM workhorse.attempt_history ORDER BY occurred_at, attempt_id LIMIT 1)
              AS oldest_attempt_history_at,
            (SELECT occurred_at FROM workhorse.attempt_history
              WHERE tableoid <> 'workhorse.attempt_history_default'::regclass
              ORDER BY occurred_at, attempt_id LIMIT 1) AS oldest_partitioned_attempt_history_at,
            (SELECT occurred_at FROM workhorse.attempt_history_default
              ORDER BY occurred_at, attempt_id LIMIT 1) AS oldest_default_attempt_history_at,
            (SELECT occurrence_at FROM workhorse.schedule_occurrence ORDER BY occurrence_at LIMIT 1)
              AS oldest_schedule_occurrence_at,
            (SELECT bucket_start FROM workhorse.job_stat_bucket ORDER BY bucket_start LIMIT 1)
              AS oldest_statistics_at
          FROM policy
        ), partitions AS (
          SELECT parent.relname AS parent_name,
                 ((regexp_match(
                   pg_get_expr(child.relpartbound, child.oid),
                   'TO \\(''([^'']+)''\\)'
                 ))[1])::timestamptz AS upper_bound
            FROM pg_inherits inheritance
            JOIN pg_class parent ON parent.oid = inheritance.inhparent
            JOIN pg_namespace namespace ON namespace.oid = parent.relnamespace
            JOIN pg_class child ON child.oid = inheritance.inhrelid
           WHERE namespace.nspname = 'workhorse'
             AND parent.relname IN ('job_event', 'attempt_history')
             AND child.relname <> parent.relname || '_default'
        ), eligible AS (
          SELECT
            count(*) FILTER (
              WHERE parent_name = 'job_event'
                AND policy.job_event_retention_days IS NOT NULL
                AND upper_bound <= clock_timestamp()
                  - make_interval(days => policy.job_event_retention_days)
                AND upper_bound <= (
                  date_trunc('day', clock_timestamp() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
                )
            )::text AS eligible_event_partitions,
            count(*) FILTER (
              WHERE parent_name = 'attempt_history'
                AND policy.attempt_history_retention_days IS NOT NULL
                AND upper_bound <= clock_timestamp()
                  - make_interval(days => policy.attempt_history_retention_days)
                AND upper_bound <= (
                  date_trunc('day', clock_timestamp() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
                )
            )::text AS eligible_attempt_partitions
          FROM partitions CROSS JOIN policy
        ), default_rows AS (
          SELECT event_rows::text AS default_event_rows,
                 attempt_rows::text AS default_attempt_rows,
                 event_rows > 10000 AS default_event_rows_capped,
                 attempt_rows > 10000 AS default_attempt_rows_capped
            FROM (
              SELECT
                (SELECT count(*) FROM (
                  SELECT 1 FROM workhorse.job_event_default LIMIT 10001
                ) sampled_events) AS event_rows,
                (SELECT count(*) FROM (
                  SELECT 1 FROM workhorse.attempt_history_default LIMIT 10001
                ) sampled_attempts) AS attempt_rows
            ) sampled
        )
        SELECT policy.*, boundaries.*,
               CASE WHEN policy.job_identity_retention_days IS NULL
                           OR boundaries.eligible_job_identity_at IS NULL THEN NULL
                    ELSE GREATEST(0, extract(epoch FROM
                      clock_timestamp() - make_interval(days => policy.job_identity_retention_days)
                      - boundaries.eligible_job_identity_at) * 1000) END AS job_identity_lag_ms,
               CASE WHEN policy.terminal_outcome_retention_days IS NULL
                           OR boundaries.eligible_terminal_outcome_at IS NULL THEN NULL
                    ELSE GREATEST(0, extract(epoch FROM
                      clock_timestamp() - make_interval(days => policy.terminal_outcome_retention_days)
                      - boundaries.eligible_terminal_outcome_at) * 1000) END AS terminal_outcome_lag_ms,
               CASE WHEN policy.job_event_retention_days IS NULL
                           OR boundaries.oldest_job_event_at IS NULL THEN NULL
                    ELSE GREATEST(
                      0,
                      COALESCE(extract(epoch FROM
                        date_trunc(
                          'day',
                          (clock_timestamp() - make_interval(
                            days => policy.job_event_retention_days
                          )) AT TIME ZONE 'UTC'
                        ) AT TIME ZONE 'UTC'
                        - boundaries.oldest_partitioned_job_event_at) * 1000, 0),
                      COALESCE(extract(epoch FROM
                        clock_timestamp() - make_interval(days => policy.job_event_retention_days)
                        - boundaries.oldest_default_job_event_at) * 1000, 0)
                    ) END AS job_event_lag_ms,
               CASE WHEN policy.attempt_history_retention_days IS NULL
                           OR boundaries.oldest_attempt_history_at IS NULL THEN NULL
                    ELSE GREATEST(
                      0,
                      COALESCE(extract(epoch FROM
                        date_trunc(
                          'day',
                          (clock_timestamp() - make_interval(
                            days => policy.attempt_history_retention_days
                          )) AT TIME ZONE 'UTC'
                        ) AT TIME ZONE 'UTC'
                        - boundaries.oldest_partitioned_attempt_history_at) * 1000, 0),
                      COALESCE(extract(epoch FROM
                        clock_timestamp()
                        - make_interval(days => policy.attempt_history_retention_days)
                        - boundaries.oldest_default_attempt_history_at) * 1000, 0)
                    ) END AS attempt_history_lag_ms,
               CASE WHEN policy.schedule_occurrence_retention_days IS NULL
                           OR boundaries.oldest_schedule_occurrence_at IS NULL THEN NULL
                    ELSE GREATEST(0, extract(epoch FROM
                      clock_timestamp()
                      - make_interval(days => policy.schedule_occurrence_retention_days)
                      - boundaries.oldest_schedule_occurrence_at) * 1000) END
                 AS schedule_occurrence_lag_ms,
               CASE WHEN policy.statistics_retention_days IS NULL
                      OR boundaries.oldest_statistics_at IS NULL THEN NULL
                    ELSE GREATEST(0, extract(epoch FROM
                      clock_timestamp()
                      - make_interval(days => policy.statistics_retention_days)
                      - boundaries.oldest_statistics_at) * 1000) END
                 AS statistics_lag_ms,
               eligible.*, default_rows.*
          FROM policy CROSS JOIN boundaries CROSS JOIN eligible CROSS JOIN default_rows`),
        this.database.query<{
          rolled_up_through: Date;
          lag_ms: number;
          last_run_at: Date | null;
          buckets: string;
          newest_bucket_at: Date | null;
        }>(`
        SELECT state.rolled_up_through,
               GREATEST(0, extract(epoch FROM clock_timestamp() - state.rolled_up_through) * 1000)
                 AS lag_ms,
               state.last_run_at,
               (SELECT count(*) FROM workhorse.job_stat_bucket)::text AS buckets,
               (SELECT max(bucket_start) FROM workhorse.job_stat_bucket) AS newest_bucket_at
          FROM workhorse.job_stat_state state WHERE state.singleton`),
      ]);

    const stateCounts: QueueHealth["counts"] = {
      scheduled: 0,
      ready: 0,
      active: 0,
      succeeded: 0,
      failed: 0,
      canceled: 0,
    };
    for (const row of counts.rows) stateCounts[row.state] = Number(row.count);
    const depth = depths.rows[0]!;
    const retentionRow = retention.rows[0]!;
    const statisticsRow = statistics.rows[0]!;
    return {
      schemaVersion: version.rows[0]?.version ?? null,
      counts: stateCounts,
      readyDepth: Number(depth.ready),
      scheduledDepth: Number(depth.scheduled),
      sleepingJobs: Number(depth.sleeping),
      overdueWaits: Number(depth.overdue_waits),
      nextWakeAt: depth.next_wake_at,
      activeLeases: Number(depth.active),
      expiredLeases: Number(depth.expired),
      oldestReadyAgeMs:
        depth.oldest_ready_age_ms === null ? null : Number(depth.oldest_ready_age_ms),
      deadlinePressure: {
        pending: Number(depth.pending_deadlines),
        overdue: Number(depth.overdue_deadlines),
        dueWithinMinute: Number(depth.deadlines_due_within_minute),
        earliestAt: depth.earliest_deadline_at,
      },
      activeExecutionTimeouts: Number(depth.active_execution_timeouts),
      overdueExecutionTimeouts: Number(depth.overdue_execution_timeouts),
      statistics: {
        rolledUpThrough: statisticsRow.rolled_up_through,
        lagMs: Number(statisticsRow.lag_ms),
        lastRunAt: statisticsRow.last_run_at,
        buckets: Number(statisticsRow.buckets),
        oldestBucketAt: retentionRow.oldest_statistics_at,
        newestBucketAt: statisticsRow.newest_bucket_at,
      },
      retentionPolicy: retentionPolicy(retentionRow),
      retentionLagMs: {
        jobIdentity:
          retentionRow.job_identity_lag_ms === null
            ? null
            : Number(retentionRow.job_identity_lag_ms),
        terminalOutcome:
          retentionRow.terminal_outcome_lag_ms === null
            ? null
            : Number(retentionRow.terminal_outcome_lag_ms),
        jobEvents:
          retentionRow.job_event_lag_ms === null ? null : Number(retentionRow.job_event_lag_ms),
        attemptHistory:
          retentionRow.attempt_history_lag_ms === null
            ? null
            : Number(retentionRow.attempt_history_lag_ms),
        scheduleOccurrences:
          retentionRow.schedule_occurrence_lag_ms === null
            ? null
            : Number(retentionRow.schedule_occurrence_lag_ms),
        statistics:
          retentionRow.statistics_lag_ms === null ? null : Number(retentionRow.statistics_lag_ms),
      },
      oldestRetainedAt: {
        jobIdentity: retentionRow.oldest_job_identity_at,
        terminalOutcome: retentionRow.oldest_terminal_outcome_at,
        jobEvents: retentionRow.oldest_job_event_at,
        attemptHistory: retentionRow.oldest_attempt_history_at,
        scheduleOccurrences: retentionRow.oldest_schedule_occurrence_at,
        statistics: retentionRow.oldest_statistics_at,
      },
      eligibleHistoryPartitions: {
        jobEvents: Number(retentionRow.eligible_event_partitions),
        attemptHistory: Number(retentionRow.eligible_attempt_partitions),
      },
      defaultHistoryRows: {
        jobEvents: Number(retentionRow.default_event_rows),
        attemptHistory: Number(retentionRow.default_attempt_rows),
      },
      defaultHistoryRowsCapped: {
        jobEvents: retentionRow.default_event_rows_capped,
        attemptHistory: retentionRow.default_attempt_rows_capped,
      },
      relations: relations.rows.map((row) => ({
        relation: row.relation,
        totalBytes: Number(row.total_bytes),
        tableBytes: Number(row.table_bytes),
        indexBytes: Number(row.index_bytes),
        liveTuples: Number(row.live_tuples),
        deadTuples: Number(row.dead_tuples),
        modificationsSinceAnalyze: Number(row.modifications_since_analyze),
        hotUpdateRatio: row.hot_update_ratio === null ? null : Number(row.hot_update_ratio),
        lastVacuum: row.last_vacuum,
        lastAutovacuum: row.last_autovacuum,
        partitions: Number(row.partitions),
      })),
      oldestTransactionAgeMs:
        activity.rows[0]?.age_ms === null ? null : Number(activity.rows[0]?.age_ms ?? 0),
      lockWaitCount: Number(activity.rows[0]?.lock_wait_count ?? 0),
      notificationQueueUsage: Number(notification.rows[0]?.usage ?? 0),
    };
  }

  /** Read the per-queue live pressure used by OpenTelemetry observable instruments. */
  async queueMetricSnapshot(): Promise<QueueMetricSnapshot[]> {
    const result = await this.database.query<{
      queue_name: string;
      ready: string;
      scheduled: string;
      active: string;
      oldest_ready_age_ms: number | null;
    }>(
      `WITH queue_names AS (
         SELECT $1::text AS queue_name
         UNION SELECT queue_name FROM workhorse.job_runtime
         UNION SELECT queue_name FROM workhorse.queue_control
         UNION SELECT queue_name FROM workhorse.worker_registry
       )
       SELECT names.queue_name,
              count(runtime.job_id) FILTER (WHERE runtime.state = 'ready')::text AS ready,
              count(runtime.job_id) FILTER (WHERE runtime.state = 'scheduled')::text AS scheduled,
              count(runtime.job_id) FILTER (WHERE runtime.state = 'active')::text AS active,
              extract(epoch FROM clock_timestamp() - min(runtime.ready_at) FILTER (
                WHERE runtime.state = 'ready'
              )) * 1000 AS oldest_ready_age_ms
         FROM queue_names names
         LEFT JOIN workhorse.job_runtime runtime ON runtime.queue_name = names.queue_name
        GROUP BY names.queue_name
        ORDER BY names.queue_name`,
      [this.defaultQueue],
    );
    return result.rows.map((row) => ({
      queue: row.queue_name,
      readyDepth: Number(row.ready),
      scheduledDepth: Number(row.scheduled),
      activeLeases: Number(row.active),
      oldestReadyAgeMs: row.oldest_ready_age_ms === null ? null : Number(row.oldest_ready_age_ms),
    }));
  }
}
