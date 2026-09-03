import { SQL_STATEMENTS } from "./sql-catalogue.generated.js";
import { databaseErrorCode, databaseErrorDetails, WorkhorseError } from "../errors.js";
import { logInfo, recordRedrive, type QueueMetricSnapshot } from "../telemetry.js";
import type {
  BulkRedriveOptions,
  BulkRedrivePage,
  ChildLineage,
  ConcurrencyPolicy,
  DeadLetter,
  DeadLetterFilter,
  DeadLetterPage,
  DeadLetterQuery,
  DependencyLineage,
  DependencyLineageRecord,
  JobListFilter,
  JobListItem,
  JobListPage,
  JobListQuery,
  JobSnapshot,
  JobState,
  JobTimelineCursor,
  JobTimelineEntry,
  JobTimelinePage,
  JobTimelineQuery,
  Json,
  QueueHealth,
  QueueHealthBudgets,
  QueueHealthStatus,
  RateLimitPolicy,
  RateLimitStatus,
  RedriveIdempotencyConflictDetails,
  RedriveIdempotencyConflictField,
  RedriveLineage,
  RedriveLineageRecord,
  RedriveRequest,
  RedriveResult,
  RetryPolicy,
} from "../types.js";
import {
  EXTERNAL_WAIT_REJECTION_WINDOW_MS,
  MAX_JOB_QUERY_PAGE_SIZE,
  MAX_REDRIVE_BATCH_SIZE,
} from "../types.js";
import { progressRecord } from "./checkpoints-progress-waits.js";
import { QUEUE_HEALTH_SQL } from "./health-protocol.js";
import {
  validateJobListQuery,
  validateJobTimelineCursor,
  validatePageLimit,
  type ValidatedJobListQuery,
} from "./filter-cursor.js";
import { QueueModule } from "./module-context.js";
import { retentionPolicy, type RetentionPolicyRow } from "./retention-maintenance.js";
import { nullableRowTimestamp, rowTimestamp } from "./row-mapping.js";

type DeadLetterRow = {
  job_id: string;
  queue_name: string;
  job_type: string;
  concurrency_key: string | null;
  priority: number;
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
  concurrency_key: string | null;
  priority: number;
  tags: string[];
  state: JobState;
  prerequisite_job_id: string | null;
  prerequisite_job_ids: string[];
  dependency_on_success: "release" | "cancel" | "fail" | null;
  dependency_on_failure: "release" | "cancel" | "fail" | null;
  dependency_on_cancellation: "release" | "cancel" | "fail" | null;
  blocked_reason: "prerequisite_pending" | null;
  parent_job_id: string | null;
  child_job_ids: string[];
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
  priority: number;
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

export type ConcurrencyPolicyRow = {
  namespace: string;
  queue_name: string;
  max_active: number;
  max_active_per_key: number | null;
  updated_at: Date | string;
};

export type RateLimitPolicyRow = {
  namespace: string;
  queue_name: string;
  rate_limit: number;
  rate_interval_ms: number;
  rate_burst: number;
  per_key_limit: number | null;
  per_key_interval_ms: number | null;
  per_key_burst: number | null;
  updated_at: Date | string;
};

type RateLimitStatusRow = RateLimitPolicyRow & {
  available_tokens: string;
  throttled_ready: string;
  throttled_keys: string;
  next_eligible_at: Date | string | null;
  sample_capped: boolean;
  policy_set_capped: boolean;
};

const RATE_LIMIT_STATUS_SQL = SQL_STATEMENTS["rate_limit_policy__operator_read_sql"];

// Adapters such as Drizzle can hand back timestamptz columns as raw strings rather than pg's
// parsed Dates, so every snapshot timestamp is normalized before it reaches callers.
function healthTimestamp(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

function nullableHealthTimestamp(value: Date | string | null): Date | null {
  return value === null ? null : healthTimestamp(value);
}

/** The raw `queue_health_v1` row. Module-private: callers read the converted `QueueHealth`. */
type QueueHealthDocument = RetentionPolicyRow & {
  captured_at: Date | string;
  schema_version: number | null;
  blocked: string;
  ready: string;
  scheduled: string;
  sleeping: string;
  overdue_waits: string;
  next_wake_at: Date | string | null;
  active: string;
  expired: string;
  oldest_ready_age_ms: number | null;
  overdue_scheduled: string;
  oldest_overdue_scheduled_age_ms: number | null;
  pending_deadlines: string;
  overdue_deadlines: string;
  deadlines_due_within_minute: string;
  earliest_deadline_at: Date | string | null;
  active_execution_timeouts: string;
  overdue_execution_timeouts: string;
  succeeded_count: string;
  failed_count: string;
  canceled_count: string;
  terminal_counts_capped: boolean;
  dependency_blocked_jobs: string;
  dependency_pending_edges: string;
  dependency_failed_resolutions: string;
  dependency_retention_prune_starved: boolean;
  dependency_counts_capped: boolean;
  child_waiting_parents: string;
  child_pending_children: string;
  child_unjoined_results: string;
  child_failed_parents: string;
  child_canceled_parents: string;
  child_counts_capped: boolean;
  pending_signal_waits: string;
  pending_human_waits: string;
  overdue_external_waits: string;
  oldest_external_wait_age_ms: number | null;
  rejected_wait_deliveries: string;
  external_wait_counts_capped: boolean;
  oldest_job_identity_at: Date | string | null;
  oldest_terminal_outcome_at: Date | string | null;
  oldest_job_event_at: Date | string | null;
  oldest_attempt_history_at: Date | string | null;
  oldest_schedule_occurrence_at: Date | string | null;
  oldest_statistics_at: Date | string | null;
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
  rolled_up_through: Date | string;
  rollup_lag_ms: number;
  last_run_at: Date | string | null;
  buckets: string;
  buckets_capped: boolean;
  newest_bucket_at: Date | string | null;
  concurrency_policies: Array<{
    namespace: string;
    queue_name: string;
    max_active: number;
    max_active_per_key: number | null;
    active: string;
    blocked_ready: string;
    saturated_keys: string;
    highest_key_active: string;
    capped: boolean;
  }>;
  rate_limit_policies: RateLimitStatusRow[];
  history_partition_days: Array<{
    day: string;
    starts_at: string;
    has_job_events: boolean;
    has_attempt_history: boolean;
  }> | null;
  budgets: QueueHealthBudgets;
  status: QueueHealthStatus;
  observations: {
    relations: Array<{
      relation: string;
      total_bytes: string;
      table_bytes: string;
      index_bytes: string;
      live_tuples: string;
      dead_tuples: string;
      modifications_since_analyze: string;
      hot_update_ratio: number | null;
      last_vacuum: Date | string | null;
      last_autovacuum: Date | string | null;
      partitions: string;
    }>;
    oldest_transaction_age_ms: number | null;
    lock_wait_count: string;
    notification_queue_usage: number;
  };
};

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
    concurrencyKey: row.concurrency_key,
    priority: row.priority,
    payload: row.payload,
    tags: row.tags,
    currentAttempt: row.current_attempt,
    maxAttempts: row.max_attempts,
    retryPolicy: row.retry_policy,
    deadlineAt: nullableRowTimestamp(row.deadline_at, "deadline_at"),
    executionTimeoutMs: row.execution_timeout_ms === null ? null : Number(row.execution_timeout_ms),
    error: row.error,
    finishedAt: rowTimestamp(row.finished_at, "finished_at"),
    redriveCount: Number(row.redrive_count),
  };
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
    concurrencyKey: row.concurrency_key,
    priority: row.priority,
    tags: row.tags,
    state: row.state,
    prerequisiteJobId: row.prerequisite_job_id,
    prerequisiteJobIds: row.prerequisite_job_ids,
    dependencyPolicy:
      row.dependency_on_failure === null
        ? null
        : {
            onSuccess: row.dependency_on_success!,
            onFailure: row.dependency_on_failure,
            onCancellation: row.dependency_on_cancellation!,
          },
    blockedReason: row.blocked_reason,
    parentJobId: row.parent_job_id,
    childJobIds: row.child_job_ids,
    currentAttempt: row.current_attempt,
    maxAttempts: row.max_attempts,
    retryPolicy: row.retry_policy,
    deadlineAt: nullableRowTimestamp(row.deadline_at, "deadline_at"),
    executionTimeoutMs: row.execution_timeout_ms === null ? null : Number(row.execution_timeout_ms),
    runAt: rowTimestamp(row.run_at, "run_at"),
    cancelRequestedAt: nullableRowTimestamp(row.cancel_requested_at, "cancel_requested_at"),
    cancelRequestedBy: row.cancel_requested_by,
    cancelReason: row.cancel_reason,
    createdAt: rowTimestamp(row.created_at, "created_at"),
    updatedAt: rowTimestamp(row.updated_at, "updated_at"),
    payload: row.payload,
    payloadStatus: row.payload_status,
    payloadBytes: row.payload_bytes === null ? null : Number(row.payload_bytes),
  };
}

function jobTimelineEntry(row: JobTimelineRow): JobTimelineEntry {
  const base = {
    recordId: row.record_id,
    priority: row.priority,
    attempt: row.attempt,
    occurredAt: rowTimestamp(row.occurred_at, "occurred_at"),
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
    startedAt: rowTimestamp(row.started_at, "started_at"),
    claimedAt: rowTimestamp(row.claimed_at, "claimed_at"),
    finishedAt: rowTimestamp(row.finished_at, "finished_at"),
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
    requestedAt: row.requested_at === null ? null : rowTimestamp(row.requested_at, "requested_at"),
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
    requestedAt: rowTimestamp(row.requested_at, "requested_at"),
  };
}

/**
 * Column name for every retention setting a caller can name.
 *
 * PostgreSQL owns retention settings, so each one is spelled twice: once as the camel-case field
 * a caller passes and once as the snake-case column `override_retention_policy_v1` and
 * `revert_retention_policy_v1` expect. This table is the only place the two spellings meet.
 * Provenance also keys off the column name, since `operator_overrides` reports columns.
 */
export function concurrencyPolicy(row: ConcurrencyPolicyRow): ConcurrencyPolicy {
  return {
    namespace: row.namespace,
    queue: row.queue_name,
    maxActive: row.max_active,
    maxActivePerKey: row.max_active_per_key,
    updatedAt: rowTimestamp(row.updated_at, "updated_at"),
  };
}

export function rateLimitPolicy(row: RateLimitPolicyRow): RateLimitPolicy {
  return {
    namespace: row.namespace,
    queue: row.queue_name,
    rate: {
      limit: row.rate_limit,
      intervalMs: row.rate_interval_ms,
      burst: row.rate_burst,
    },
    perKey:
      row.per_key_limit === null
        ? null
        : {
            limit: row.per_key_limit,
            intervalMs: row.per_key_interval_ms!,
            burst: row.per_key_burst!,
          },
    updatedAt: rowTimestamp(row.updated_at, "updated_at"),
  };
}

function rateLimitStatus(row: RateLimitStatusRow): RateLimitStatus {
  return {
    ...rateLimitPolicy(row),
    availableTokens: Number(row.available_tokens),
    throttledReady: Number(row.throttled_ready),
    throttledKeys: Number(row.throttled_keys),
    nextEligibleAt: nullableRowTimestamp(row.next_eligible_at, "next_eligible_at"),
    sampleCapped: row.sample_capped,
    policySetCapped: row.policy_set_capped,
  };
}

function conflictDetails<TDetails>(
  error: unknown,
  valid: (value: unknown) => value is TDetails,
  sanitized: TDetails,
): TDetails {
  for (const detail of databaseErrorDetails(error)) {
    try {
      const parsed: unknown = JSON.parse(detail);
      if (valid(parsed)) return parsed;
    } catch {
      // Keep walking; PostgreSQL's DETAIL may sit behind an adapter wrapper's own detail string.
    }
  }
  return sanitized;
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

function redriveConflict(error: unknown): RedriveIdempotencyConflictError | null {
  if (databaseErrorCode(error) !== "P1002") return null;
  return new RedriveIdempotencyConflictError(
    conflictDetails(error, validRedriveConflictDetails, sanitizedRedriveConflictDetails),
  );
}

export class RedriveIdempotencyConflictError extends WorkhorseError {
  constructor(readonly details: RedriveIdempotencyConflictDetails) {
    super(
      `Redrive request conflict for source ${details.sourceJobId} and request ${details.requestIdPreview} (${details.requestIdDigest}); fields: ${details.conflictingFields.join(", ")}`,
    );
    this.name = "RedriveIdempotencyConflictError";
  }
}

/** Convert the versioned PostgreSQL health document into the public TypeScript shape. */
function queueHealthFromDocument(row: QueueHealthDocument): QueueHealth {
  const rateLimits = row.rate_limit_policies.map(rateLimitStatus);
  const base: Omit<QueueHealth, "status" | "budgets"> = {
    capturedAt: healthTimestamp(row.captured_at),
    schemaVersion: row.schema_version,
    counts: {
      blocked: Number(row.blocked),
      scheduled: Number(row.scheduled),
      ready: Number(row.ready),
      active: Number(row.active),
      succeeded: Number(row.succeeded_count),
      failed: Number(row.failed_count),
      canceled: Number(row.canceled_count),
    },
    terminalCountsCapped: row.terminal_counts_capped,
    readyDepth: Number(row.ready),
    scheduledDepth: Number(row.scheduled),
    sleepingJobs: Number(row.sleeping),
    overdueWaits: Number(row.overdue_waits),
    nextWakeAt: nullableHealthTimestamp(row.next_wake_at),
    activeLeases: Number(row.active),
    expiredLeases: Number(row.expired),
    dependencies: {
      blockedJobs: Number(row.dependency_blocked_jobs),
      pendingEdges: Number(row.dependency_pending_edges),
      failedResolutions: Number(row.dependency_failed_resolutions),
      retentionPruneStarved: row.dependency_retention_prune_starved,
      capped: row.dependency_counts_capped,
    },
    children: {
      waitingParents: Number(row.child_waiting_parents),
      pendingChildren: Number(row.child_pending_children),
      unjoinedResults: Number(row.child_unjoined_results),
      failedParents: Number(row.child_failed_parents),
      canceledParents: Number(row.child_canceled_parents),
      capped: row.child_counts_capped,
    },
    externalWaits: {
      pendingSignals: Number(row.pending_signal_waits),
      pendingHumanDecisions: Number(row.pending_human_waits),
      overdue: Number(row.overdue_external_waits),
      oldestPendingAgeMs:
        row.oldest_external_wait_age_ms === null ? null : Number(row.oldest_external_wait_age_ms),
      rejectedDeliveries: Number(row.rejected_wait_deliveries),
      capped: row.external_wait_counts_capped,
    },
    oldestReadyAgeMs: row.oldest_ready_age_ms === null ? null : Number(row.oldest_ready_age_ms),
    deadlinePressure: {
      pending: Number(row.pending_deadlines),
      overdue: Number(row.overdue_deadlines),
      dueWithinMinute: Number(row.deadlines_due_within_minute),
      earliestAt: nullableHealthTimestamp(row.earliest_deadline_at),
    },
    activeExecutionTimeouts: Number(row.active_execution_timeouts),
    overdueExecutionTimeouts: Number(row.overdue_execution_timeouts),
    overdueScheduled: Number(row.overdue_scheduled),
    oldestOverdueScheduledAgeMs:
      row.oldest_overdue_scheduled_age_ms === null
        ? null
        : Number(row.oldest_overdue_scheduled_age_ms),
    concurrencyPolicies: {
      policies: row.concurrency_policies.map((policy) => ({
        namespace: policy.namespace,
        queue: policy.queue_name,
        maxActive: policy.max_active,
        active: Number(policy.active),
        available: Math.max(0, policy.max_active - Number(policy.active)),
        blockedReady: Number(policy.blocked_ready),
        maxActivePerKey: policy.max_active_per_key,
        saturatedKeys: Number(policy.saturated_keys),
        highestKeyActive: Number(policy.highest_key_active),
      })),
      capped: row.concurrency_policies.some((policy) => policy.capped),
    },
    rateLimitPolicies: {
      policies: rateLimits,
      capped: rateLimits.some((policy) => policy.policySetCapped || policy.sampleCapped),
    },
    statistics: {
      rolledUpThrough: healthTimestamp(row.rolled_up_through),
      lagMs: Number(row.rollup_lag_ms),
      lastRunAt: nullableHealthTimestamp(row.last_run_at),
      buckets: Number(row.buckets),
      bucketsCapped: row.buckets_capped,
      oldestBucketAt: nullableHealthTimestamp(row.oldest_statistics_at),
      newestBucketAt: nullableHealthTimestamp(row.newest_bucket_at),
    },
    retentionPolicy: retentionPolicy(row),
    retentionLagMs: {
      jobIdentity: row.job_identity_lag_ms === null ? null : Number(row.job_identity_lag_ms),
      terminalOutcome:
        row.terminal_outcome_lag_ms === null ? null : Number(row.terminal_outcome_lag_ms),
      jobEvents: row.job_event_lag_ms === null ? null : Number(row.job_event_lag_ms),
      attemptHistory:
        row.attempt_history_lag_ms === null ? null : Number(row.attempt_history_lag_ms),
      scheduleOccurrences:
        row.schedule_occurrence_lag_ms === null ? null : Number(row.schedule_occurrence_lag_ms),
      statistics: row.statistics_lag_ms === null ? null : Number(row.statistics_lag_ms),
    },
    oldestRetainedAt: {
      jobIdentity: nullableHealthTimestamp(row.oldest_job_identity_at),
      terminalOutcome: nullableHealthTimestamp(row.oldest_terminal_outcome_at),
      jobEvents: nullableHealthTimestamp(row.oldest_job_event_at),
      attemptHistory: nullableHealthTimestamp(row.oldest_attempt_history_at),
      scheduleOccurrences: nullableHealthTimestamp(row.oldest_schedule_occurrence_at),
      statistics: nullableHealthTimestamp(row.oldest_statistics_at),
    },
    eligibleHistoryPartitions: {
      jobEvents: Number(row.eligible_event_partitions),
      attemptHistory: Number(row.eligible_attempt_partitions),
    },
    defaultHistoryRows: {
      jobEvents: Number(row.default_event_rows),
      attemptHistory: Number(row.default_attempt_rows),
    },
    defaultHistoryRowsCapped: {
      jobEvents: row.default_event_rows_capped,
      attemptHistory: row.default_attempt_rows_capped,
    },
    historyPartitionDays: (row.history_partition_days ?? []).map((dayRow) => ({
      day: dayRow.day,
      startsAt: new Date(dayRow.starts_at),
      hasJobEvents: dayRow.has_job_events,
      hasAttemptHistory: dayRow.has_attempt_history,
    })),
    observations: {
      relations: row.observations.relations.map((relation) => ({
        relation: relation.relation,
        totalBytes: Number(relation.total_bytes),
        tableBytes: Number(relation.table_bytes),
        indexBytes: Number(relation.index_bytes),
        liveTuples: Number(relation.live_tuples),
        deadTuples: Number(relation.dead_tuples),
        modificationsSinceAnalyze: Number(relation.modifications_since_analyze),
        hotUpdateRatio:
          relation.hot_update_ratio === null ? null : Number(relation.hot_update_ratio),
        lastVacuum: nullableHealthTimestamp(relation.last_vacuum),
        lastAutovacuum: nullableHealthTimestamp(relation.last_autovacuum),
        partitions: Number(relation.partitions),
      })),
      oldestTransactionAgeMs:
        row.observations.oldest_transaction_age_ms === null
          ? null
          : Number(row.observations.oldest_transaction_age_ms),
      lockWaitCount: Number(row.observations.lock_wait_count),
      notificationQueueUsage: Number(row.observations.notification_queue_usage),
    },
  };
  return {
    ...base,
    budgets: row.budgets,
    status: row.status,
  };
}

/** Owns operator reads, redrive operations, health, and metric snapshots. */
export class OperatorReadsModule extends QueueModule {
  validateJobListQuery(query: JobListQuery): ValidatedJobListQuery {
    return validateJobListQuery(query);
  }

  validateJobTimelineQuery(
    jobId: string,
    limit: number | undefined,
    cursor: JobTimelineCursor | undefined,
  ): { limit: number; cursor: JobTimelineCursor | undefined } {
    return {
      limit: validatePageLimit(limit, 100, MAX_JOB_QUERY_PAGE_SIZE, "getJobTimeline limit"),
      cursor: validateJobTimelineCursor(jobId, cursor),
    };
  }

  async rateLimitStatuses(queueNames: readonly string[] = []): Promise<RateLimitStatus[]> {
    const result = await this.context.database.query<RateLimitStatusRow>(RATE_LIMIT_STATUS_SQL, [
      queueNames,
    ]);
    return result.rows.map(rateLimitStatus);
  }

  async listJobs(query: JobListQuery = {}): Promise<JobListPage> {
    const { limit, cursor, payloadProjection } = this.validateJobListQuery(query);
    const result = await this.context.database.query<JobListRow>(SQL_STATEMENTS["list_jobs_v1"], [
      JSON.stringify(jobListFilter(query)),
      limit,
      cursor?.createdAt ?? null,
      cursor?.jobId ?? null,
      cursor?.signature ?? null,
      JSON.stringify(payloadProjection),
    ]);
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
    const { limit, cursor } = this.validateJobTimelineQuery(jobId, query.limit, query.cursor);

    const result = await this.context.database.query<JobTimelineRow>(
      SQL_STATEMENTS["list_job_timeline_v1"],
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
    const result = await this.context.database.query<DeadLetterRow>(
      SQL_STATEMENTS["list_dead_letters_v1"],
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
      const result = await this.context.database.query<RedriveRow>(SQL_STATEMENTS["redrive"], [
        sourceJobId,
        request.requestedBy,
        request.reason,
        request.requestId,
      ]);
      const row = result.rows[0];
      if (!row) throw new Error("redrive_v1 returned no result");
      recordRedrive(row.status);
      logInfo("workhorse.job.redrive_processed", "Dead-letter job redrive processed", {
        "workhorse.job.id": sourceJobId,
        "workhorse.redrive.target_job_id": row.target_job_id ?? "none",
        "workhorse.operation.status": row.status,
      });
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
      const result = await this.context.database.query<BulkRedriveRow>(
        SQL_STATEMENTS["redrive_many_v1"],
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
      const statuses = new Map<RedriveResult["status"], number>();
      for (const row of result.rows) statuses.set(row.status, (statuses.get(row.status) ?? 0) + 1);
      for (const [status, count] of statuses) recordRedrive(status, count);
      logInfo("workhorse.jobs.redrive_processed", "Dead-letter job redrive batch processed", {
        "workhorse.job.count": result.rows.length,
        "workhorse.redrive.dry_run": options.dryRun ?? false,
      });
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
    const result = await this.context.database.query<RedriveLineageRow>(
      SQL_STATEMENTS["redrive_lineage_v1"],
      [jobId, limit + 1],
    );
    return {
      records: result.rows.slice(0, limit).map(redriveLineageRecord),
      truncated: result.rows.length > limit,
    };
  }

  async getDependencyLineage(
    jobId: string,
    requestedLimit = MAX_JOB_QUERY_PAGE_SIZE,
  ): Promise<DependencyLineage> {
    const limit = validatePageLimit(
      requestedLimit,
      MAX_JOB_QUERY_PAGE_SIZE,
      MAX_JOB_QUERY_PAGE_SIZE,
      "getDependencyLineage limit",
    );
    const result = await this.context.database.query<{
      dependent_job_id: string;
      prerequisite_job_id: string;
      on_success: DependencyLineageRecord["onSuccess"];
      on_failure: DependencyLineageRecord["onFailure"];
      on_cancellation: DependencyLineageRecord["onCancellation"];
      created_at: Date | string;
      released_at: Date | string | null;
      resolution: DependencyLineageRecord["resolution"];
    }>(SQL_STATEMENTS["job_dependency"], [jobId, limit + 1]);
    return {
      records: result.rows.slice(0, limit).map((row) => ({
        dependentJobId: row.dependent_job_id,
        prerequisiteJobId: row.prerequisite_job_id,
        onSuccess: row.on_success,
        onFailure: row.on_failure,
        onCancellation: row.on_cancellation,
        createdAt: rowTimestamp(row.created_at, "created_at"),
        releasedAt: nullableRowTimestamp(row.released_at, "released_at"),
        resolution: row.resolution,
      })),
      truncated: result.rows.length > limit,
    };
  }

  async getChildLineage(
    jobId: string,
    requestedLimit = MAX_JOB_QUERY_PAGE_SIZE,
  ): Promise<ChildLineage> {
    const limit = validatePageLimit(
      requestedLimit,
      MAX_JOB_QUERY_PAGE_SIZE,
      MAX_JOB_QUERY_PAGE_SIZE,
      "getChildLineage limit",
    );
    const result = await this.context.database.query<{
      parent_job_id: string;
      child_job_id: string;
      child_name: string;
      child_type: string;
      created_at: Date | string;
      joined_at: Date | string | null;
      outcome_state: "succeeded" | "failed" | "canceled" | null;
      outcome_error: Json | null;
    }>(SQL_STATEMENTS["job_child"], [jobId, limit + 1]);
    return {
      records: result.rows.slice(0, limit).map((row) => ({
        parentJobId: row.parent_job_id,
        childJobId: row.child_job_id,
        name: row.child_name,
        type: row.child_type,
        createdAt: rowTimestamp(row.created_at, "created_at"),
        joinedAt: nullableRowTimestamp(row.joined_at, "joined_at"),
        outcomeState: row.outcome_state,
        error: row.outcome_error,
      })),
      truncated: result.rows.length > limit,
    };
  }

  async getJob<TResult extends Json = Json>(id: string): Promise<JobSnapshot<TResult> | null> {
    // A job exists in exactly one lifecycle relation: runtime while live, outcome when terminal.
    const result = await this.context.database.query<{
      id: string;
      queue_name: string;
      job_type: string;
      concurrency_key: string | null;
      priority: number;
      payload: Json;
      contract_version: string | null;
      tags: string[];
      state: JobSnapshot["state"];
      prerequisite_job_id: string | null;
      prerequisite_job_ids: string[];
      dependency_on_success: "release" | "cancel" | "fail" | null;
      dependency_on_failure: "release" | "cancel" | "fail" | null;
      dependency_on_cancellation: "release" | "cancel" | "fail" | null;
      blocked_reason: "prerequisite_pending" | null;
      parent_job_id: string | null;
      child_job_ids: string[];
      current_attempt: number;
      max_attempts: number;
      retry_policy: RetryPolicy | null;
      deadline_at: Date | string | null;
      execution_timeout_ms: string | null;
      version: string;
      run_at: Date | string;
      result: TResult | null;
      error: Json | null;
      cancel_requested_at: Date | string | null;
      cancel_requested_by: string | null;
      cancel_reason: string | null;
      progress_value: Json | null;
      progress_revision: string | null;
      progress_attempt: number | null;
      progress_fence_token: string | null;
      progress_worker_id: string | null;
      progress_created_at: Date | string | null;
      progress_updated_at: Date | string | null;
      created_at: Date | string;
      updated_at: Date | string;
    }>(SQL_STATEMENTS["redact_top_level_keys_v1"], [id]);
    const row = result.rows[0];
    if (!row) return null;
    return {
      id: row.id,
      queue: row.queue_name,
      type: row.job_type,
      concurrencyKey: row.concurrency_key,
      priority: row.priority,
      payload: row.payload,
      contractVersion: row.contract_version,
      tags: row.tags,
      state: row.state,
      prerequisiteJobId: row.prerequisite_job_id,
      prerequisiteJobIds: row.prerequisite_job_ids,
      dependencyPolicy:
        row.dependency_on_failure === null
          ? null
          : {
              onSuccess: row.dependency_on_success!,
              onFailure: row.dependency_on_failure,
              onCancellation: row.dependency_on_cancellation!,
            },
      blockedReason: row.blocked_reason,
      parentJobId: row.parent_job_id,
      childJobIds: row.child_job_ids,
      currentAttempt: row.current_attempt,
      maxAttempts: row.max_attempts,
      retryPolicy: row.retry_policy,
      deadlineAt: nullableRowTimestamp(row.deadline_at, "deadline_at"),
      executionTimeoutMs:
        row.execution_timeout_ms === null ? null : Number(row.execution_timeout_ms),
      fenceToken: BigInt(row.version),
      runAt: rowTimestamp(row.run_at, "run_at"),
      result: row.result,
      error: row.error,
      cancelRequestedAt: nullableRowTimestamp(row.cancel_requested_at, "cancel_requested_at"),
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
              created_at: rowTimestamp(row.progress_created_at!, "progress_created_at"),
              updated_at: rowTimestamp(row.progress_updated_at!, "progress_updated_at"),
            }),
      createdAt: rowTimestamp(row.created_at, "created_at"),
      updatedAt: rowTimestamp(row.updated_at, "updated_at"),
    };
  }

  async health(): Promise<QueueHealth> {
    const rejectedSince = new Date(Date.now() - EXTERNAL_WAIT_REJECTION_WINDOW_MS);
    const result = await this.context.database.query<{ snapshot: QueueHealthDocument }>(
      QUEUE_HEALTH_SQL,
      [rejectedSince],
    );
    const row = result.rows[0]?.snapshot;
    if (!row) throw new Error("queue_health_v1 returned no snapshot; is the schema installed?");
    return queueHealthFromDocument(row);
  }

  /** Read the per-queue live pressure used by OpenTelemetry observable instruments. */
  async queueMetricSnapshot(): Promise<QueueMetricSnapshot[]> {
    const [result, rateLimitStatuses] = await Promise.all([
      this.context.database.query<{
        queue_name: string;
        ready: string;
        scheduled: string;
        active: string;
        oldest_ready_age_ms: number | null;
        max_active: number | null;
        concurrency_active: string;
        blocked_ready: string;
        dependency_blocked: string;
        dependency_pending_edges: string;
        dependency_failed_resolutions: string;
        dependency_counts_capped: boolean;
        child_waiting_parents: string;
        child_pending_children: string;
        child_unjoined_results: string;
        child_failed_parents: string;
        child_canceled_parents: string;
        child_counts_capped: boolean;
      }>(SQL_STATEMENTS["queue_metric_snapshot"], [this.context.defaultQueue]),
      this.rateLimitStatuses(),
    ]);
    const rateLimits = new Map(rateLimitStatuses.map((status) => [status.queue, status]));
    return result.rows.map((row) => {
      const rateLimit = rateLimits.get(row.queue_name);
      return {
        queue: row.queue_name,
        readyDepth: Number(row.ready),
        scheduledDepth: Number(row.scheduled),
        activeLeases: Number(row.active),
        dependencyBlockedDepth: Number(row.dependency_blocked),
        dependencyPendingEdges: Number(row.dependency_pending_edges),
        dependencyFailedResolutions: Number(row.dependency_failed_resolutions),
        dependencyCountsCapped: row.dependency_counts_capped,
        childWaitingParents: Number(row.child_waiting_parents),
        childPendingChildren: Number(row.child_pending_children),
        childUnjoinedResults: Number(row.child_unjoined_results),
        childFailedParents: Number(row.child_failed_parents),
        childCanceledParents: Number(row.child_canceled_parents),
        childCountsCapped: row.child_counts_capped,
        oldestReadyAgeMs: row.oldest_ready_age_ms === null ? null : Number(row.oldest_ready_age_ms),
        concurrencyLimit: row.max_active,
        concurrencyActive: Number(row.concurrency_active),
        blockedReadyDepth: Number(row.blocked_ready),
        rateLimitPerSecond:
          rateLimit === undefined
            ? null
            : (rateLimit.rate.limit * 1_000) / rateLimit.rate.intervalMs,
        rateLimitAvailableTokens: rateLimit?.availableTokens ?? 0,
        rateLimitThrottledReadyDepth: rateLimit?.throttledReady ?? 0,
        rateLimitNextEligibleDelayMs:
          rateLimit?.nextEligibleAt == null
            ? null
            : Math.max(0, rateLimit.nextEligibleAt.getTime() - Date.now()),
      };
    });
  }
}
