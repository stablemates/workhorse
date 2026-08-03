import type { QueryResult, QueryResultRow } from "pg";

export interface Queryable {
  /** Minimal structural contract shared by pg Pool and PoolClient. */
  query<R extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<QueryResult<R>>;
}

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/** PostgreSQL-validated retry scheduling persisted with the stable job identity. */
export type RetryPolicy =
  | { type: "fixed"; delayMs: number }
  | {
      type: "exponential";
      initialDelayMs: number;
      multiplier: number;
      maxDelayMs: number;
    }
  | { type: "decorrelated-jitter"; baseDelayMs: number; maxDelayMs: number };

/** PostgreSQL-owned enqueue deduplication identity and retention window. */
export interface EnqueueIdempotency {
  /** Caller-chosen key, unique within `scope` while its retention window remains active. */
  key: string;
  /** Caller namespace. Omitted values use {@link DEFAULT_IDEMPOTENCY_SCOPE}. */
  scope?: string;
  /** Deduplication retention window in milliseconds. Omitted values use the default 24 hours. */
  ttlMs?: number;
}

/** Top-level accepted request fields whose normalized semantics can conflict on replay. */
export type EnqueueIdempotencyConflictField =
  | "queue"
  | "type"
  | "payload"
  | "tags"
  | "runAt"
  | "deadline"
  | "executionTimeoutMs"
  | "maxAttempts"
  | "retryPolicy"
  | "ttlMs";

/** Safe diagnostics for a materially different replay. The raw idempotency key is never exposed. */
export interface EnqueueIdempotencyConflictDetails {
  scope: string;
  keyPreview: string;
  keyDigest: string;
  keyLength: number;
  existingJobId: string;
  ordinal: number;
  conflictingFields: EnqueueIdempotencyConflictField[];
  storedRequestDigest: string;
  rejectedRequestDigest: string;
}

/** Options persisted as part of the accepted job definition or initial dispatch projection. */
export interface EnqueueOptions {
  queue?: string;
  runAt?: Date;
  /** Absolute wall-clock deadline. Reaching it is terminal even when retry budget remains. */
  deadline?: Date;
  /** Maximum active execution time consumed by one logical attempt, excluding durable waits. */
  executionTimeoutMs?: number;
  maxAttempts?: number;
  retryPolicy?: RetryPolicy;
  tags?: string[];
  idempotency?: EnqueueIdempotency;
}

/** One job accepted by {@link Queue.enqueueMany}, with the same semantics as `Queue.enqueue`. */
export interface EnqueueRequest<TPayload extends Json = Json> {
  type: string;
  payload: TPayload;
  options?: EnqueueOptions;
  tags?: string[];
}

/**
 * Maximum supported requests per `enqueueMany` call. This bounds JSON parsing, statement memory,
 * identity allocation, and notification work inside one PostgreSQL transaction.
 */
export const MAX_ENQUEUE_BATCH_SIZE = 1_000;
/** Default namespace for enqueue idempotency keys whose caller omits an explicit scope. */
export const DEFAULT_IDEMPOTENCY_SCOPE = "default";
/** Default enqueue idempotency retention window (24 hours). */
export const DEFAULT_IDEMPOTENCY_TTL_MS = 86_400_000;
/** Maximum UTF-8 size accepted for one enqueue idempotency key. */
export const MAX_IDEMPOTENCY_KEY_BYTES = 512;
/** Maximum UTF-8 size accepted for one enqueue idempotency scope. */
export const MAX_IDEMPOTENCY_SCOPE_BYTES = 256;
/** Maximum enqueue idempotency retention window (365 days). */
export const MAX_IDEMPOTENCY_TTL_MS = 31_536_000_000;
/** Maximum PostgreSQL canonical JSONB text size accepted for one durable checkpoint value. */
export const MAX_CHECKPOINT_VALUE_BYTES = 1_048_576;
/** Maximum relative duration or first absolute target horizon for one durable wait (365 days). */
export const MAX_WAIT_DURATION_MS = 31_536_000_000;
/** Maximum active execution budget for one attempt (365 days). */
export const MAX_EXECUTION_TIMEOUT_MS = 31_536_000_000;
/** Maximum characters accepted for cancellation-request attribution. Attribution is not authorization. */
export const MAX_CANCELLATION_REQUESTED_BY_CHARACTERS = 200;
/** Maximum characters accepted for a cancellation reason. */
export const MAX_CANCELLATION_REASON_CHARACTERS = 2_000;
/** Maximum failed jobs inspected or redriven by one bounded operation. */
export const MAX_REDRIVE_BATCH_SIZE = 1_000;
/** Maximum UTF-8 size accepted for a redrive request identity. */
export const MAX_REDRIVE_REQUEST_ID_BYTES = 512;
/** Maximum jobs or timeline entries returned by one keyset-paginated query. */
export const MAX_JOB_QUERY_PAGE_SIZE = 1_000;
/** Default maximum encoded payload size included by an explicit list projection. */
export const DEFAULT_JOB_QUERY_PAYLOAD_BYTES = 16_384;
/** Maximum encoded payload size accepted by a list projection. */
export const MAX_JOB_QUERY_PAYLOAD_BYTES = 1_048_576;
/** Maximum unique top-level payload keys redacted by one list projection. */
export const MAX_JOB_QUERY_REDACT_KEYS = 50;

/** Optional safe attribution attached to a cancellation request. PostgreSQL validates all bounds. */
export interface CancellationRequest {
  requestedBy?: string;
  reason?: string;
}

export type CancelStatus = "canceled" | "cancel_requested" | "already_terminal" | "not_found";
export type HeartbeatStatus =
  | "accepted"
  | "cancel_requested"
  | "deadline_exceeded"
  | "timeout_exceeded"
  | "stale";
export type ExpireOwnedStatus =
  | "not_due"
  | "cancel_requested"
  | "deadline_exceeded"
  | "timeout_exceeded"
  | "stale";

/** Safe lifecycle metadata returned by {@link Queue.cancel}; payloads and worker ownership are omitted. */
export interface CancelResult {
  status: CancelStatus;
  jobId: string;
  state: JobState | null;
  currentAttempt: number | null;
  requestedAt: Date | null;
  /** Caller-provided attribution only. This does not claim that the caller was authorized. */
  requestedBy: string | null;
  reason: string | null;
  finishedAt: Date | null;
}

/** Failure-only filters shared by dead-letter listing and bounded bulk redrive. */
export interface DeadLetterFilter {
  queue?: string;
  type?: string;
  /** Every supplied tag must be present. */
  tags?: string[];
  errorName?: string;
  finishedAfter?: Date;
  finishedBefore?: Date;
}

/** Stable descending cursor over immutable terminal failure time and job identity. */
export interface DeadLetterCursor {
  /** Exact PostgreSQL UTC timestamp text. Treat as opaque continuation state. */
  finishedAt: string;
  jobId: string;
}

export interface DeadLetterQuery extends DeadLetterFilter {
  limit?: number;
  cursor?: DeadLetterCursor;
}

/** One immutable terminal failure projected without re-entering dispatch indexes. */
export interface DeadLetter {
  jobId: string;
  queue: string;
  type: string;
  payload: Json;
  tags: string[];
  currentAttempt: number;
  maxAttempts: number;
  retryPolicy: RetryPolicy | null;
  deadlineAt: Date | null;
  executionTimeoutMs: number | null;
  error: Json;
  finishedAt: Date;
  redriveCount: number;
}

export interface DeadLetterPage {
  items: DeadLetter[];
  nextCursor: DeadLetterCursor | null;
}

/** Stable job identity and lifecycle filters applied by PostgreSQL. */
export interface JobListFilter {
  queue?: string;
  type?: string;
  states?: JobState[];
  createdAfter?: Date;
  createdBefore?: Date;
}

/** Bounded payload projection for job listings. Redaction applies only to top-level object keys. */
export interface JobPayloadProjection {
  include?: boolean;
  maxBytes?: number;
  redactKeys?: string[];
}

/** Signed descending cursor over immutable creation time and job identity. */
export interface JobListCursor {
  /** Exact PostgreSQL timestamp text. Treat as opaque continuation state. */
  createdAt: string;
  jobId: string;
  signature: string;
}

export interface JobListQuery extends JobListFilter {
  limit?: number;
  cursor?: JobListCursor;
  payload?: JobPayloadProjection;
}

export type JobPayloadStatus = "omitted" | "included" | "too_large";

/** One job projection ordered newest-first without exposing outcome or worker ownership details. */
export interface JobListItem {
  id: string;
  queue: string;
  type: string;
  tags: string[];
  state: JobState;
  currentAttempt: number;
  maxAttempts: number;
  retryPolicy: RetryPolicy | null;
  deadlineAt: Date | null;
  executionTimeoutMs: number | null;
  runAt: Date;
  cancelRequestedAt: Date | null;
  /** Caller-provided attribution only. This does not claim that the caller was authorized. */
  cancelRequestedBy: string | null;
  cancelReason: string | null;
  createdAt: Date;
  updatedAt: Date;
  payload: Json | null;
  payloadStatus: JobPayloadStatus;
  payloadBytes: number | null;
}

export interface JobListPage {
  items: JobListItem[];
  nextCursor: JobListCursor | null;
}

/** Stable descending cursor over a job's merged event and closed-attempt timeline. */
export interface JobTimelineCursor {
  jobId: string;
  /** Exact PostgreSQL timestamp text. Treat as opaque continuation state. */
  occurredAt: string;
  kind: "event" | "attempt";
  /** Exact PostgreSQL bigint text. Treat as opaque continuation state. */
  recordId: string;
}

export interface JobTimelineQuery {
  limit?: number;
  cursor?: JobTimelineCursor;
}

interface JobTimelineEntryBase {
  recordId: string;
  attempt: number | null;
  occurredAt: Date;
}

export interface JobTimelineEvent extends JobTimelineEntryBase {
  kind: "event";
  eventType: string;
  details: Json;
}

export type JobAttemptOutcome =
  | "succeeded"
  | "failed"
  | "retry"
  | "lease_expired"
  | "canceled"
  | "deadline_exceeded"
  | "timeout";

export interface JobTimelineAttempt extends JobTimelineEntryBase {
  kind: "attempt";
  attempt: number;
  fenceToken: bigint;
  workerId: string;
  outcome: JobAttemptOutcome;
  startedAt: Date;
  claimedAt: Date;
  finishedAt: Date;
  error: Json | null;
}

export type JobTimelineEntry = JobTimelineEvent | JobTimelineAttempt;

export interface JobTimelinePage {
  /** Merged events and attempts ordered latest-first. */
  items: JobTimelineEntry[];
  nextCursor: JobTimelineCursor | null;
}

/** Required audit and idempotency identity for a redrive request. */
export interface RedriveRequest {
  requestedBy: string;
  reason: string;
  requestId: string;
}

export type RedriveStatus = "redriven" | "replayed" | "eligible" | "not_found" | "not_failed";

/** PostgreSQL-owned before/after result for one source job. */
export interface RedriveResult {
  status: RedriveStatus;
  sourceJobId: string;
  targetJobId: string | null;
  sourceState: JobState | null;
  targetState: JobState | null;
  requestedAt: Date | null;
}

export interface BulkRedriveOptions {
  limit?: number;
  dryRun?: boolean;
  /** Oldest-first continuation cursor returned by the previous bulk page. */
  cursor?: DeadLetterCursor;
}

export interface BulkRedrivePage {
  results: RedriveResult[];
  nextCursor: DeadLetterCursor | null;
}

export type RedriveIdempotencyConflictField = "requestedBy" | "reason";

/** Safe diagnostics for a materially different replay. The raw request ID is never exposed. */
export interface RedriveIdempotencyConflictDetails {
  sourceJobId: string;
  existingTargetJobId: string;
  requestIdPreview: string;
  requestIdDigest: string;
  requestIdLength: number;
  conflictingFields: RedriveIdempotencyConflictField[];
  storedRequestDigest: string;
  rejectedRequestDigest: string;
}

/** One immutable audited edge in a redrive lineage graph. */
export interface RedriveLineageRecord {
  sourceJobId: string;
  targetJobId: string;
  requestedBy: string;
  reason: string;
  requestIdPreview: string;
  requestIdDigest: string;
  requestIdLength: number;
  sourceState: "failed";
  targetInitialState: "ready";
  requestedAt: Date;
}

export interface RedriveLineage {
  records: RedriveLineageRecord[];
  truncated: boolean;
}

export interface ClaimedJob<TPayload = Json> {
  /** Stable job identity across all attempts. */
  id: string;
  type: string;
  payload: TPayload;
  /** One-based attempt number. Recovery and retry always create the next number. */
  attempt: number;
  maxAttempts: number;
  retryPolicy: RetryPolicy | null;
  /** Immutable absolute job deadline, or null when the job has no deadline. */
  deadlineAt: Date | null;
  /** Persisted active-execution budget for each logical attempt. */
  executionTimeoutMs: number | null;
  /** PostgreSQL-computed timeout target for this active handler activation. */
  attemptTimeoutAt: Date | null;
  /** Ownership generation that must accompany heartbeat, completion, and failure. */
  fenceToken: bigint;
  /** Client-visible expiry snapshot. PostgreSQL remains authoritative. */
  leaseExpiresAt: Date;
}

/** One immutable named result persisted at an explicit handler restart boundary. */
export interface JobCheckpoint<TValue extends Json = Json> {
  jobId: string;
  name: string;
  value: TValue;
  /** Attempt that first persisted this checkpoint. */
  attempt: number;
  /** Ownership generation that authorized the checkpoint write. */
  fenceToken: bigint;
  workerId: string;
  createdAt: Date;
}

/** One immutable named durable timer boundary. */
export interface JobWait {
  jobId: string;
  name: string;
  mode: "relative" | "absolute";
  /** First committed relative duration. Later relative arguments for this name are ignored. */
  durationMs: number | null;
  /** Exact caller target for an absolute wait, or null for a relative wait. */
  requestedWakeAt: Date | null;
  /** PostgreSQL-computed durable target used by promotion. */
  wakeAt: Date;
  /** Logical attempt that first persisted this wait. */
  attempt: number;
  /** Ownership generation that authorized the first write. */
  fenceToken: bigint;
  workerId: string;
  createdAt: Date;
}

export type JobState = "scheduled" | "ready" | "active" | "succeeded" | "failed" | "canceled";

export interface JobSnapshot<TResult = Json> {
  id: string;
  queue: string;
  type: string;
  payload: Json;
  tags: string[];
  state: JobState;
  currentAttempt: number;
  maxAttempts: number;
  retryPolicy: RetryPolicy | null;
  deadlineAt: Date | null;
  executionTimeoutMs: number | null;
  /** Current ownership generation, or zero before the first claim. */
  fenceToken: bigint;
  runAt: Date;
  result: TResult | null;
  error: Json | null;
  cancelRequestedAt: Date | null;
  /** Caller-provided attribution only. This does not claim that the caller was authorized. */
  cancelRequestedBy: string | null;
  cancelReason: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** All windows are explicit; null disables a category. Omitted work limits retain persisted values. */
export interface RetentionPolicyDefinition {
  jobIdentityRetentionDays: number | null;
  terminalOutcomeRetentionDays: number | null;
  jobEventRetentionDays: number | null;
  attemptHistoryRetentionDays: number | null;
  scheduleOccurrenceRetentionDays: number | null;
  terminalJobPruneLimit?: number;
  historyPartitionsPerPass?: number;
  defaultPartitionRowsPerPass?: number;
  occurrenceRowsPerPass?: number;
}

/** Persisted retention policy plus its PostgreSQL-owned update timestamp. */
export interface RetentionPolicy extends Required<RetentionPolicyDefinition> {
  updatedAt: Date;
}

export interface MaintenancePolicyDefinition {
  timezone: string;
  partitionPreparationIntervalMs?: number;
  terminalCleanupIntervalMs?: number;
  historyRetentionLocalHour?: number;
}

export interface MaintenancePolicy extends Required<MaintenancePolicyDefinition> {
  updatedAt: Date;
}

export interface RetentionCategoryValues<T> {
  jobIdentity: T;
  terminalOutcome: T;
  jobEvents: T;
  attemptHistory: T;
  scheduleOccurrences: T;
}

export interface QueueHealth {
  /** Canonical schema protocol version installed in this database. */
  schemaVersion: number | null;
  counts: Record<JobState, number>;
  readyDepth: number;
  scheduledDepth: number;
  /** Scheduled runtimes currently suspended at a named durable timer boundary. */
  sleepingJobs: number;
  /** Durable timer runtimes whose not-before target has passed but remain unpromoted. */
  overdueWaits: number;
  /** Earliest not-before target among currently suspended durable timers. */
  nextWakeAt: Date | null;
  activeLeases: number;
  expiredLeases: number;
  oldestReadyAgeMs: number | null;
  /** Pressure from absolute deadlines among live runtimes. */
  deadlinePressure: {
    pending: number;
    overdue: number;
    dueWithinMinute: number;
    earliestAt: Date | null;
  };
  /** Active attempts with a persisted execution timeout target. */
  activeExecutionTimeouts: number;
  /** Active attempts whose execution timeout target has elapsed but is not yet reaped. */
  overdueExecutionTimeouts: number;
  retentionPolicy: RetentionPolicy;
  /** Delay beyond each enabled policy cutoff. Null means disabled or no retained data. */
  retentionLagMs: RetentionCategoryValues<number | null>;
  /** Oldest retained timestamp used to compute category lag. */
  oldestRetainedAt: RetentionCategoryValues<Date | null>;
  eligibleHistoryPartitions: {
    jobEvents: number;
    attemptHistory: number;
  };
  defaultHistoryRows: {
    jobEvents: number;
    attemptHistory: number;
  };
  /** True when the corresponding fallback-row count hit the 10,001-row health scan cap. */
  defaultHistoryRowsCapped: {
    jobEvents: boolean;
    attemptHistory: boolean;
  };
  /** PostgreSQL relation statistics are estimates and may lag until stats flush. */
  relations: Array<{
    relation: string;
    totalBytes: number;
    tableBytes: number;
    indexBytes: number;
    liveTuples: number;
    deadTuples: number;
    modificationsSinceAnalyze: number;
    /** HOT updates divided by all updates, or null when no updates were observed. */
    hotUpdateRatio: number | null;
    lastVacuum: Date | null;
    lastAutovacuum: Date | null;
  }>;
  oldestTransactionAgeMs: number | null;
  /** Sessions currently waiting on PostgreSQL locks, excluding the health query itself. */
  lockWaitCount: number;
  /** Fraction of PostgreSQL's global async notification queue currently occupied. */
  notificationQueueUsage: number;
}
