import { databaseErrorCode, databaseErrorDetails, WorkhorseError } from "../errors.js";
import { DEFAULT_QUEUE_HEALTH_BUDGETS, evaluateQueueHealth } from "../health.js";
import { perQueueDepthSelect } from "../queue-depth.js";
import { logInfo, recordRedrive, type QueueMetricSnapshot } from "../telemetry.js";
import type {
  BulkRedriveOptions,
  BulkRedrivePage,
  ConcurrencyPolicy,
  DeadLetter,
  DeadLetterFilter,
  DeadLetterPage,
  DeadLetterQuery,
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
import { MAX_JOB_QUERY_PAGE_SIZE, MAX_REDRIVE_BATCH_SIZE } from "../types.js";
import { progressRecord } from "./checkpoints-progress-waits.js";
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

export type ConcurrencyPolicyRow = {
  namespace: string;
  queue_name: string;
  max_active: number;
  max_active_per_key: number | null;
  updated_at: Date;
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

export type RateLimitStatusRow = RateLimitPolicyRow & {
  available_tokens: string;
  throttled_ready: string;
  throttled_keys: string;
  next_eligible_at: Date | string | null;
  sample_capped: boolean;
  policy_set_capped: boolean;
};

import { HEALTH_SNAPSHOT_SQL, RATE_LIMIT_STATUS_SQL } from "./operator-read-sql.js";

// Adapters such as Drizzle// Adapters such as Drizzle can hand back timestamptz columns as raw strings rather than pg's
// parsed Dates, so every snapshot timestamp is normalized before it reaches callers.
function healthTimestamp(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

function nullableHealthTimestamp(value: Date | string | null): Date | null {
  return value === null ? null : healthTimestamp(value);
}

type HealthSnapshotRow = RetentionPolicyRow & {
  captured_at: Date | string;
  schema_version: number | null;
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
    tags: row.tags,
    state: row.state,
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
    updatedAt: new Date(row.updated_at),
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
    updatedAt: new Date(row.updated_at),
  };
}

function rateLimitStatus(row: RateLimitStatusRow): RateLimitStatus {
  return {
    ...rateLimitPolicy(row),
    availableTokens: Number(row.available_tokens),
    throttledReady: Number(row.throttled_ready),
    throttledKeys: Number(row.throttled_keys),
    nextEligibleAt: row.next_eligible_at === null ? null : new Date(row.next_eligible_at),
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
    const result = await this.context.database.query<JobListRow>(
      `SELECT job_id, queue_name, job_type, concurrency_key, tags, state, current_attempt, max_attempts,
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
    const { limit, cursor } = this.validateJobTimelineQuery(jobId, query.limit, query.cursor);

    const result = await this.context.database.query<JobTimelineRow>(
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
    const result = await this.context.database.query<DeadLetterRow>(
      "SELECT * FROM workhorse.list_dead_letters_v1($1::jsonb, $2::integer, $3::timestamptz, $4::uuid)",
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
      const result = await this.context.database.query<RedriveRow>(
        "SELECT * FROM workhorse.redrive_v1($1::uuid, $2::text, $3::text, $4::text)",
        [sourceJobId, request.requestedBy, request.reason, request.requestId],
      );
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
        "SELECT status, source_job_id, target_job_id, source_state, target_state, requested_at, source_finished_at_cursor, has_more FROM workhorse.redrive_many_v1($1::jsonb, $2::integer, $3::boolean, $4::text, $5::text, $6::text, $7::timestamptz, $8::uuid) ORDER BY ordinal",
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
      `WITH RECURSIVE connected_edges AS (
         SELECT edge.* FROM workhorse.job_redrive edge
          WHERE edge.source_job_id = $1::uuid OR edge.target_job_id = $1::uuid
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
         FROM (SELECT * FROM connected_edges LIMIT $2::integer) bounded
        ORDER BY bounded.requested_at, bounded.source_job_id, bounded.target_job_id`,
      [jobId, limit + 1],
    );
    return {
      records: result.rows.slice(0, limit).map(redriveLineageRecord),
      truncated: result.rows.length > limit,
    };
  }

  async getJob<TResult = Json>(id: string): Promise<JobSnapshot<TResult> | null> {
    // A job exists in exactly one lifecycle relation: runtime while live, outcome when terminal.
    const result = await this.context.database.query<{
      id: string;
      queue_name: string;
      job_type: string;
      concurrency_key: string | null;
      payload: Json;
      contract_version: string | null;
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
      `SELECT j.id, j.queue_name, j.job_type, j.concurrency_key,
              workhorse.redact_top_level_keys_v1(j.payload, j.payload_redact_keys) AS payload,
              j.contract_version, j.tags, j.retry_policy,
              j.deadline_at, j.execution_timeout_ms::text,
              COALESCE(r.state, o.state) AS state,
              COALESCE(r.current_attempt, o.current_attempt) AS current_attempt,
              j.max_attempts, COALESCE(r.fence_token, o.fence_token) AS version,
              COALESCE(r.run_at, o.run_at) AS run_at,
              workhorse.redact_top_level_keys_v1(o.result, j.result_redact_keys) AS result,
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
        WHERE j.id = $1::uuid`,
      [id],
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      id: row.id,
      queue: row.queue_name,
      type: row.job_type,
      concurrencyKey: row.concurrency_key,
      payload: row.payload,
      contractVersion: row.contract_version,
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

  async health(options: { budgets?: Partial<QueueHealthBudgets> } = {}): Promise<QueueHealth> {
    // The consistent snapshot is one statement and therefore one MVCC snapshot. The remaining
    // queries are PostgreSQL observations — collector estimates and instantaneous server state —
    // which are not transactional facts and can lag until the statistics collector flushes.
    const [snapshot, relations, activity, notification] = await Promise.all([
      this.context.database.query<HealthSnapshotRow>(HEALTH_SNAPSHOT_SQL, [[]]),
      this.context.database.query<{
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
      this.context.database.query<{ age_ms: number | null; lock_wait_count: string }>(`
        SELECT extract(epoch FROM clock_timestamp() - min(xact_start)) * 1000 AS age_ms,
               count(*) FILTER (WHERE wait_event_type = 'Lock')::text AS lock_wait_count
          FROM pg_stat_activity WHERE pid <> pg_backend_pid()`),
      this.context.database.query<{ usage: number }>(
        "SELECT pg_notification_queue_usage() AS usage",
      ),
    ]);

    const row = snapshot.rows[0];
    if (!row) throw new Error("health snapshot returned no row; is the schema installed?");
    const rateLimits = row.rate_limit_policies.map(rateLimitStatus);
    const base: Omit<QueueHealth, "status"> = {
      capturedAt: healthTimestamp(row.captured_at),
      schemaVersion: row.schema_version,
      counts: {
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
        relations: relations.rows.map((relation) => ({
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
          activity.rows[0]?.age_ms === null ? null : Number(activity.rows[0]?.age_ms ?? 0),
        lockWaitCount: Number(activity.rows[0]?.lock_wait_count ?? 0),
        notificationQueueUsage: Number(notification.rows[0]?.usage ?? 0),
      },
    };
    return {
      ...base,
      status: evaluateQueueHealth(base, { ...DEFAULT_QUEUE_HEALTH_BUDGETS, ...options.budgets }),
    };
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
      }>(
        `WITH queue_names AS (
         SELECT $1::text AS queue_name
         UNION SELECT queue_name FROM workhorse.job_runtime
         UNION SELECT queue_name FROM workhorse.queue_control
         UNION SELECT queue_name FROM workhorse.concurrency_policy
         UNION SELECT queue_name FROM workhorse.rate_limit_policy
         UNION SELECT queue_name FROM workhorse.worker_registry
       ), usage AS (
         ${perQueueDepthSelect(
           ["ready", "scheduled", "active", "concurrency_active", "oldest_ready_age_ms"],
           "queue_names",
         )}
       )
       SELECT usage.*, policy.max_active,
              COALESCE(blocked.blocked_ready, 0)::text AS blocked_ready
         FROM usage
         LEFT JOIN workhorse.concurrency_policy policy ON policy.queue_name = usage.queue_name
         LEFT JOIN LATERAL (
           SELECT count(*) FILTER (
                    WHERE usage.concurrency_active::integer >= policy.max_active
                       OR (
                         policy.max_active_per_key IS NOT NULL
                         AND sample.concurrency_key IS NOT NULL
                         AND sample.key_active >= policy.max_active_per_key
                       )
                  )::integer AS blocked_ready
             FROM (
               SELECT ready.concurrency_key,
                      (SELECT count(*)::integer FROM workhorse.job_runtime active
                        WHERE active.state = 'active'
                          AND active.queue_name = usage.queue_name
                          AND active.concurrency_key = ready.concurrency_key
                          AND active.expires_at > clock_timestamp()) AS key_active
                 FROM workhorse.job_runtime ready
                WHERE ready.state = 'ready' AND ready.queue_name = usage.queue_name
                ORDER BY ready.sequence, ready.job_id LIMIT 100
             ) sample
         ) blocked ON policy.queue_name IS NOT NULL
        ORDER BY usage.queue_name`,
        [this.context.defaultQueue],
      ),
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
