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
/** Maximum characters accepted for cancellation-request attribution. Attribution is not authorization. */
export const MAX_CANCELLATION_REQUESTED_BY_CHARACTERS = 200;
/** Maximum characters accepted for a cancellation reason. */
export const MAX_CANCELLATION_REASON_CHARACTERS = 2_000;

/** Optional safe attribution attached to a cancellation request. PostgreSQL validates all bounds. */
export interface CancellationRequest {
  requestedBy?: string;
  reason?: string;
}

export type CancelStatus = "canceled" | "cancel_requested" | "already_terminal" | "not_found";
export type HeartbeatStatus = "accepted" | "cancel_requested" | "stale";

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

export interface ClaimedJob<TPayload = Json> {
  /** Stable job identity across all attempts. */
  id: string;
  type: string;
  payload: TPayload;
  /** One-based attempt number. Recovery and retry always create the next number. */
  attempt: number;
  maxAttempts: number;
  retryPolicy: RetryPolicy | null;
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
