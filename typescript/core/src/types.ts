import type { QueryResult, QueryResultRow } from "pg";

export interface DatabaseNotification {
  channel: string;
  payload?: string;
}

/** Dedicated node-postgres connection used for LISTEN/NOTIFY wake hints. */
export interface NotificationClient extends Queryable {
  on(event: "notification", listener: (notification: DatabaseNotification) => void): this;
  on(event: "error", listener: (error: Error) => void): this;
  on(event: "end", listener: () => void): this;
  removeListener(
    event: "notification",
    listener: (notification: DatabaseNotification) => void,
  ): this;
  removeListener(event: "error", listener: (error: Error) => void): this;
  removeListener(event: "end", listener: () => void): this;
  release(error?: Error | boolean): void;
}

export interface Queryable {
  /** Minimal structural contract shared by pg Pool and PoolClient. */
  query<R extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<QueryResult<R>>;
}

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/** Application validator for one versioned payload or result contract. */
export type JobContractValidator = (value: Json) => boolean;

/** One immutable application contract version for a job type. */
export interface JobContractVersion {
  validatePayload?: JobContractValidator;
  validateResult?: JobContractValidator;
  maxPayloadBytes?: number;
  maxResultBytes?: number;
  /** Top-level object keys removed from operator payload views. */
  sensitivePayloadKeys?: readonly string[];
  /** Top-level object keys removed from operator result views. */
  sensitiveResultKeys?: readonly string[];
}

/** Available versions and the version assigned to newly accepted jobs of one type. */
export interface JobTypeContracts {
  currentVersion: string;
  versions: Readonly<Record<string, JobContractVersion>>;
}

/** Queue-wide defaults and optional per-job-type contracts. */
export interface QueueOptions {
  contracts?: Readonly<Record<string, JobTypeContracts>>;
  defaultMaxPayloadBytes?: number;
  defaultMaxResultBytes?: number;
}

/** Bounded W3C trace metadata persisted separately from the application payload. */
export interface TraceContext {
  traceparent?: string;
  tracestate?: string;
}

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

/** PostgreSQL-owned keyed debounce window for one pending job. */
export interface EnqueueDebounce {
  /** Caller-chosen key, unique within `scope` while the debounce window remains active. */
  key: string;
  /** Caller namespace. Omitted values use {@link DEFAULT_IDEMPOTENCY_SCOPE}. */
  scope?: string;
  /** Delay and replacement window measured from PostgreSQL's clock. */
  windowMs: number;
  /** Whether a replacement starts a fresh window or keeps the retained job's run time. */
  schedule: "reset" | "preserve";
}

/** PostgreSQL-owned keyed throttle window for one accepted job. */
export interface EnqueueThrottle {
  /** Caller-chosen key, unique within `scope` while the throttle window remains active. */
  key: string;
  /** Caller namespace. Omitted values use {@link DEFAULT_IDEMPOTENCY_SCOPE}. */
  scope?: string;
  /** Acceptance window measured from PostgreSQL's clock. */
  windowMs: number;
}

/** PostgreSQL's durable disposition for one enqueue request. */
export type EnqueueOutcome = "accepted" | "replayed" | "replaced" | "non_replaceable" | "coalesced";

/** Why PostgreSQL retained a debounced job instead of applying the proposed replacement. */
export type EnqueueNonReplaceableReason =
  | "incompatible_key_mode"
  | "not_pending"
  | "window_elapsed_pending";

/** Stable identity plus the durable disposition of one enqueue request. */
export type EnqueueResult =
  | {
      jobId: string;
      outcome: Exclude<EnqueueOutcome, "non_replaceable">;
      reason?: never;
    }
  | {
      jobId: string;
      outcome: "non_replaceable";
      reason: EnqueueNonReplaceableReason;
    };

/** Top-level accepted request fields whose normalized semantics can conflict on replay. */
export type EnqueueIdempotencyConflictField =
  | "queue"
  | "type"
  | "payload"
  | "priority"
  | "concurrencyKey"
  | "contractVersion"
  | "payloadMaxBytes"
  | "resultMaxBytes"
  | "sensitivePayloadKeys"
  | "sensitiveResultKeys"
  | "tags"
  | "runAt"
  | "deadline"
  | "executionTimeoutMs"
  | "maxAttempts"
  | "retryPolicy"
  | "prerequisiteJobId"
  | "dependencies"
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

/** Options shared by every enqueue ingress mode. */
interface EnqueueBaseOptions {
  queue?: string;
  /** Dispatch rank from 0 through 100. Higher values are claimed first. */
  priority?: number;
  /** Queue-scoped application group used by durable concurrency admission. */
  concurrencyKey?: string;
  runAt?: Date;
  /** Absolute wall-clock deadline. Reaching it is terminal even when retry budget remains. */
  deadline?: Date;
  /** Maximum active execution time consumed by one logical attempt, excluding durable waits. */
  executionTimeoutMs?: number;
  maxAttempts?: number;
  retryPolicy?: RetryPolicy;
  tags?: string[];
}

type EnqueueDependencyOptions =
  | {
      /** @deprecated Use `dependencies` with one prerequisite and explicit terminal policies. */
      prerequisiteJobId: string;
      dependencies?: never;
    }
  | {
      prerequisiteJobId?: never;
      /** Bounded fan-in and the terminal outcomes accepted from each prerequisite. */
      dependencies?: JobDependencies;
    };

/** Options persisted as part of the accepted job definition or initial dispatch projection. */
export type EnqueueOptions = EnqueueBaseOptions &
  (
    | (EnqueueDependencyOptions & {
        idempotency?: EnqueueIdempotency;
        debounce?: never;
        throttle?: never;
      })
    | {
        idempotency?: never;
        /** Replace one still-pending keyed job during a PostgreSQL-owned window. */
        debounce: EnqueueDebounce;
        throttle?: never;
        prerequisiteJobId?: never;
        dependencies?: never;
      }
    | {
        idempotency?: never;
        debounce?: never;
        /** Accept at most one equivalent job per PostgreSQL-owned window. */
        throttle: EnqueueThrottle;
        prerequisiteJobId?: never;
        dependencies?: never;
      }
  );

/** What a dependent does when one prerequisite reaches a non-success terminal state. */
export type DependencyTerminalPolicy = "release" | "cancel" | "fail";

/** A bounded set of prerequisites which must all satisfy their declared terminal policy. */
export interface JobDependencies {
  prerequisiteJobIds: readonly string[];
  onSuccess: DependencyTerminalPolicy;
  onFailure: DependencyTerminalPolicy;
  onCancellation: DependencyTerminalPolicy;
}

/** One queue's deployment-synchronized concurrency budget. */
export interface ConcurrencyPolicyDefinition {
  queue: string;
  maxActive: number;
  /** Uniform active-job budget for each non-null concurrency key. Null disables the keyed budget. */
  maxActivePerKey?: number | null;
}

/** Persisted queue concurrency policy. */
export interface ConcurrencyPolicy {
  namespace: string;
  queue: string;
  maxActive: number;
  maxActivePerKey: number | null;
  updatedAt: Date;
}

/** One continuously refilled token bucket. PostgreSQL supplies the clock for every refill. */
export interface RateLimit {
  /** Tokens added during each interval. One token admits one job start. */
  limit: number;
  intervalMs: number;
  /** Maximum tokens retained after idle time. */
  burst: number;
}

/** One queue's deployment-synchronized start-rate budget. */
export interface RateLimitPolicyDefinition {
  queue: string;
  rate: RateLimit;
  /** Uniform independent bucket for each non-null concurrency key. */
  perKey?: RateLimit | null;
}

/** Persisted and normalized queue rate-limit policy. */
export interface RateLimitPolicy {
  namespace: string;
  queue: string;
  rate: RateLimit;
  perKey: RateLimit | null;
  updatedAt: Date;
}

/** A bounded operational observation of one rate-limit policy. */
export interface RateLimitStatus extends RateLimitPolicy {
  availableTokens: number;
  throttledReady: number;
  throttledKeys: number;
  nextEligibleAt: Date | null;
  sampleCapped: boolean;
  policySetCapped: boolean;
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
/** Maximum prerequisite edges accepted for one dependent job. */
export const MAX_JOB_DEPENDENCIES = 100;
/** Maximum dependent edges accepted for one prerequisite job. */
export const MAX_JOB_DEPENDENTS = 100;
/** Trailing window used by health and metrics for rejected external-wait deliveries (24 hours). */
export const EXTERNAL_WAIT_REJECTION_WINDOW_MS = 86_400_000;
/** Highest accepted job priority. Priority zero is the default. */
export const MAX_JOB_PRIORITY = 100;
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
/** Maximum keyed debounce window (365 days). */
export const MAX_DEBOUNCE_WINDOW_MS = 31_536_000_000;
/** Maximum keyed throttle window (365 days). */
export const MAX_THROTTLE_WINDOW_MS = 31_536_000_000;
/** Maximum PostgreSQL canonical JSONB text size accepted for one durable checkpoint value. */
export const MAX_CHECKPOINT_VALUE_BYTES = 1_048_576;
/** Maximum PostgreSQL canonical JSONB text size accepted for latest mutable job progress. */
export const MAX_PROGRESS_VALUE_BYTES = 65_536;
/** Minimum interval between changed progress writes from one ownership generation. */
export const MIN_PROGRESS_UPDATE_INTERVAL_MS = 100;
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
/** Maximum rows inspected for each dependency pressure fact in one health or telemetry read. */
export const DEPENDENCY_OPERATIONS_SCAN_LIMIT = 10_000;
/** Default maximum encoded payload size included by an explicit list projection. */
export const DEFAULT_JOB_QUERY_PAYLOAD_BYTES = 16_384;
/** Maximum encoded payload size accepted by a list projection. */
export const MAX_JOB_QUERY_PAYLOAD_BYTES = 1_048_576;
/** Maximum unique top-level payload keys redacted by one list projection. */
export const MAX_JOB_QUERY_REDACT_KEYS = 50;
/** Default PostgreSQL-canonical JSON size accepted for a job payload or result. */
export const DEFAULT_JOB_VALUE_MAX_BYTES = 1_048_576;
/** Largest configurable PostgreSQL-canonical JSON size accepted for a job payload or result. */
export const MAX_JOB_VALUE_MAX_BYTES = 16_777_216;
/** Maximum persisted top-level sensitive keys for one payload or result contract. */
export const MAX_JOB_CONTRACT_SENSITIVE_KEYS = 50;

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
  concurrencyKey: string | null;
  priority: number;
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
  concurrencyKey: string | null;
  priority: number;
  tags: string[];
  state: JobState;
  prerequisiteJobId: string | null;
  prerequisiteJobIds: string[];
  dependencyPolicy: Omit<JobDependencies, "prerequisiteJobIds"> | null;
  blockedReason: "prerequisite_pending" | null;
  parentJobId: string | null;
  childJobIds: string[];
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
  priority: number;
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

/** One retained prerequisite edge, including the policy decision PostgreSQL recorded. */
export interface DependencyLineageRecord {
  dependentJobId: string;
  prerequisiteJobId: string;
  onSuccess: DependencyTerminalPolicy;
  onFailure: DependencyTerminalPolicy;
  onCancellation: DependencyTerminalPolicy;
  createdAt: Date;
  releasedAt: Date | null;
  resolution: DependencyTerminalPolicy | null;
}

/** Bounded edges where the requested job is either the prerequisite or the dependent. */
export interface DependencyLineage {
  records: DependencyLineageRecord[];
  truncated: boolean;
}

/** One immutable parent-to-child edge created by a fenced handler activation. */
export interface ChildJob<TResult extends Json = Json> {
  parentJobId: string;
  childJobId: string;
  name: string;
  type: string;
  createdAt: Date;
  joinedAt: Date | null;
  result: TResult | null;
}

/** Enqueue fields accepted for one linked child. Its parent supplies idempotency and dependency. */
export type ChildJobOptions = Omit<
  EnqueueOptions,
  "idempotency" | "debounce" | "throttle" | "prerequisiteJobId" | "dependencies"
>;

/** One named child request in a bounded fan-out created by a fenced parent activation. */
export interface ChildJobRequest<TPayload extends Json = Json> {
  name: string;
  type: string;
  payload: TPayload;
  options?: ChildJobOptions;
}

/** PostgreSQL's decision when a handler creates or replays its single named child. */
export type CreateChildResult<TResult extends Json = Json> =
  | { status: "created"; child: ChildJob<TResult> }
  | { status: "completed"; child: ChildJob<TResult> };

/** PostgreSQL's decision when a handler creates or replays one bounded child set. */
export type CreateChildrenResult<TResult extends Record<string, Json> = Record<string, Json>> =
  | { status: "created"; children: ChildJob[] }
  | { status: "completed"; children: ChildJob[]; results: TResult };

/** Bounded edges where the requested job is either the parent or the child. */
export interface ChildLineage {
  records: Array<
    Omit<ChildJob, "result"> & {
      outcomeState: "succeeded" | "failed" | "canceled" | null;
      error: Json | null;
    }
  >;
  truncated: boolean;
}

export interface ClaimedJob<TPayload = Json> {
  /** Stable job identity across all attempts. */
  id: string;
  /** Queue from which PostgreSQL granted this attempt. */
  queue: string;
  type: string;
  /** Immutable dispatch rank. Higher values are claimed first. */
  priority: number;
  payload: TPayload;
  /** Contract version captured when PostgreSQL accepted this job, or null for an uncontracted job. */
  contractVersion: string | null;
  /** Immutable PostgreSQL-canonical JSON size limit for the terminal result. */
  resultMaxBytes: number;
  /** Whether handler error details must be removed before telemetry or persistence. */
  redactErrorDetails: boolean;
  /** W3C parent context captured when PostgreSQL first accepted this stable job identity. */
  traceContext: TraceContext | null;
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

/** Latest mutable progress projection for a stable job identity. */
export interface JobProgress<TValue extends Json = Json> {
  jobId: string;
  value: TValue;
  /** Monotonic accepted-change revision for this job. */
  revision: bigint;
  /** Attempt that wrote the latest value. */
  attempt: number;
  /** Ownership generation that authorized the latest value. */
  fenceToken: bigint;
  workerId: string;
  createdAt: Date;
  updatedAt: Date;
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

export type JobState =
  | "blocked"
  | "scheduled"
  | "ready"
  | "active"
  | "succeeded"
  | "failed"
  | "canceled";

export interface JobSnapshot<TResult = Json> {
  id: string;
  queue: string;
  type: string;
  concurrencyKey: string | null;
  priority: number;
  payload: Json;
  contractVersion: string | null;
  tags: string[];
  state: JobState;
  prerequisiteJobId: string | null;
  prerequisiteJobIds: string[];
  dependencyPolicy: Omit<JobDependencies, "prerequisiteJobIds"> | null;
  blockedReason: "prerequisite_pending" | null;
  parentJobId: string | null;
  childJobIds: string[];
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
  /** Latest bounded mutable progress, retained across retries and terminal materialization. */
  progress: JobProgress | null;
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
  /**
   * How long derived per-minute statistics are kept.
   *
   * Deliberately independent of every window above rather than bounded by job identity. A bucket
   * summarizes jobs, it does not attribute one, so keeping aggregates long after the history they
   * came from has been deleted is the intended use rather than a violation. Null keeps them forever.
   */
  statisticsRetentionDays: number | null;
  terminalJobPruneLimit?: number;
  historyPartitionsPerPass?: number;
  defaultPartitionRowsPerPass?: number;
  occurrenceRowsPerPass?: number;
  statisticsRowsPerPass?: number;
}

/** Persisted retention policy plus its PostgreSQL-owned update timestamp. */
export interface RetentionPolicy extends Required<RetentionPolicyDefinition> {
  provenance: {
    jobIdentityRetentionDays: PolicyValueProvenance<number | null>;
    terminalOutcomeRetentionDays: PolicyValueProvenance<number | null>;
    jobEventRetentionDays: PolicyValueProvenance<number | null>;
    attemptHistoryRetentionDays: PolicyValueProvenance<number | null>;
    scheduleOccurrenceRetentionDays: PolicyValueProvenance<number | null>;
    statisticsRetentionDays: PolicyValueProvenance<number | null>;
    terminalJobPruneLimit: PolicyValueProvenance<number>;
    historyPartitionsPerPass: PolicyValueProvenance<number>;
    defaultPartitionRowsPerPass: PolicyValueProvenance<number>;
    occurrenceRowsPerPass: PolicyValueProvenance<number>;
    statisticsRowsPerPass: PolicyValueProvenance<number>;
  };
  updatedAt: Date;
}

export type RetentionPolicySetting = keyof RetentionPolicyDefinition;

export interface RetentionPolicyImpact {
  eligible: {
    terminalJobs: number;
    jobEvents: number;
    attemptHistory: number;
    scheduleOccurrences: number;
    statistics: number;
  };
  capped: {
    terminalJobs: boolean;
    jobEvents: boolean;
    attemptHistory: boolean;
    scheduleOccurrences: boolean;
    statistics: boolean;
  };
}

export interface MaintenancePolicyDefinition {
  timezone: string;
  partitionPreparationIntervalMs?: number;
  terminalCleanupIntervalMs?: number;
  /** Local wall-clock time in `HH:mm` form. The IANA timezone supplies daylight-saving rules. */
  historyRetentionLocalTime?: string;
}

export interface MaintenancePolicy extends Required<MaintenancePolicyDefinition> {
  provenance: {
    timezone: PolicyValueProvenance<string>;
    partitionPreparationIntervalMs: PolicyValueProvenance<number>;
    terminalCleanupIntervalMs: PolicyValueProvenance<number>;
    historyRetentionLocalTime: PolicyValueProvenance<string>;
  };
  updatedAt: Date;
}

export interface PolicyValueProvenance<T> {
  source: "application" | "operator";
  applicationDefault: T;
}

export type MaintenancePolicySetting = keyof MaintenancePolicyDefinition;

export interface RetentionCategoryValues<T> {
  jobIdentity: T;
  terminalOutcome: T;
  jobEvents: T;
  attemptHistory: T;
  scheduleOccurrences: T;
  statistics: T;
}

/**
 * Cap applied to health scans over unbounded history relations.
 *
 * Terminal state counts and the materialized-bucket count stop scanning here, so one snapshot
 * statement stays bounded no matter how much history is retained. Capped values are exact until
 * the cap and lower bounds beyond it, and each carries an explicit `capped` flag.
 */
export const HEALTH_HISTORY_SCAN_LIMIT = 100_000;

/** Stable machine-readable identifiers for queue health degradation. */
export type QueueHealthReasonCode =
  | "expired-leases"
  | "overdue-deadlines"
  | "overdue-execution-timeouts"
  | "overdue-external-waits"
  | "stalled-promotion"
  | "missing-history-partitions"
  | "rollup-stalled"
  | "retention-lag"
  | "eligible-history-partitions"
  | "default-history-rows"
  | "concurrency-blocked"
  | "rate-limit-throttled";

/**
 * One exceeded health budget.
 *
 * `observed` and `budget` share one unit per code: milliseconds for `stalled-promotion`,
 * `rollup-stalled`, and `retention-lag`; plain counts for every other code.
 */
export interface QueueHealthReason {
  code: QueueHealthReasonCode;
  /** Critical means work is stopping or being lost; degraded costs storage or throughput. */
  severity: "critical" | "degraded";
  observed: number;
  budget: number;
  /** Present on per-queue codes: `concurrency-blocked` and `rate-limit-throttled`. */
  queue?: string;
  /** Present on `retention-lag`, naming the late retention category. */
  category?: keyof RetentionCategoryValues<unknown>;
}

/** Overall level plus every exceeded budget, most severe reasons first. */
export interface QueueHealthStatus {
  level: "healthy" | "degraded" | "critical";
  reasons: QueueHealthReason[];
}

/**
 * Thresholds separating expected operational noise from degradation.
 *
 * Zero-tolerance conditions such as expired leases or overdue deadlines have no budget entry;
 * any occurrence is critical.
 */
export interface QueueHealthBudgets {
  /**
   * How long a due scheduled runtime may stay unpromoted before promotion counts as stalled.
   * Generous against the worker tick cadence: one slow tick is load, sustained lag is an outage.
   */
  promotionLagMs: number;
  /**
   * A rollup this far behind is treated as stalled. History retention refuses to delete past the
   * watermark, so a stalled rollup turns into unbounded history growth.
   */
  rollupStalledLagMs: number;
  /** Grace for row-deleted retention categories before cleanup lag counts as degradation. */
  rowRetentionLagMs: number;
  /** Grace for partition-dropped categories; covers cadence plus a partial boundary day. */
  partitionRetentionLagMs: number;
  /** Completed history days allowed to await deletion before retention counts as behind. */
  eligibleHistoryPartitions: number;
}

/**
 * PostgreSQL-side observations included with a health snapshot.
 *
 * These are estimates and instantaneous server state, not transactional facts: relation
 * statistics lag until the statistics collector flushes, and activity is read outside the
 * snapshot statement. Correctness-sensitive counts live on {@link QueueHealth} itself.
 */
export interface QueueHealthObservations {
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
    /** Daily partitions attached to this relation; zero for ordinary tables. */
    partitions: number;
  }>;
  oldestTransactionAgeMs: number | null;
  /** Sessions currently waiting on PostgreSQL locks, excluding the health query itself. */
  lockWaitCount: number;
  /** Fraction of PostgreSQL's global async notification queue currently occupied. */
  notificationQueueUsage: number;
}

export interface QueueHealth {
  /**
   * Transaction timestamp of the snapshot statement.
   *
   * Every correctness-sensitive value below was read in one PostgreSQL statement, so they all
   * describe the queue as of this instant. Only `observations` is read outside the snapshot.
   */
  capturedAt: Date;
  /** Canonical schema protocol version installed in this database. */
  schemaVersion: number | null;
  counts: Record<JobState, number>;
  /**
   * True when terminal counts hit the bounded history scan cap and are lower bounds.
   * Live-state counts are always exact; only succeeded, failed, and canceled can cap.
   */
  terminalCountsCapped: boolean;
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
  /** Dependency pressure and retained policy-selected failure outcomes. */
  dependencies: {
    blockedJobs: number;
    pendingEdges: number;
    failedResolutions: number;
    /** The last terminal prune deleted nothing while its candidate window contained dependency pins. */
    retentionPruneStarved: boolean;
    /** True when at least one value is a lower bound at the operations scan limit. */
    capped: boolean;
  };
  /** Parent-child orchestration pressure and retained policy-selected terminal evidence. */
  children: {
    waitingParents: number;
    pendingChildren: number;
    unjoinedResults: number;
    failedParents: number;
    canceledParents: number;
    /** True when at least one value is a lower bound at the operations scan limit. */
    capped: boolean;
  };
  /** Bounded signal and human-decision lifecycle diagnostics without job or wait-name labels. */
  externalWaits: {
    pendingSignals: number;
    pendingHumanDecisions: number;
    overdue: number;
    oldestPendingAgeMs: number | null;
    /** Rejected signal deliveries and human decisions in the trailing 24 hours. */
    rejectedDeliveries: number;
    /** True when any pending or recent-rejection sample reached the operations scan limit. */
    capped: boolean;
  };
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
  /** Scheduled runtimes, durable waits included, whose run-at target has passed unpromoted. */
  overdueScheduled: number;
  /** Age of the longest-unpromoted due scheduled runtime, or null when none is due. */
  oldestOverdueScheduledAgeMs: number | null;
  /** Bounded queue concurrency utilization without raw concurrency-key labels. */
  concurrencyPolicies: {
    policies: Array<{
      namespace: string;
      queue: string;
      maxActive: number;
      active: number;
      available: number;
      blockedReady: number;
      maxActivePerKey: number | null;
      saturatedKeys: number;
      highestKeyActive: number;
    }>;
    capped: boolean;
  };
  /** Bounded token-bucket pressure. Ready counts are lower bounds when `capped` is true. */
  rateLimitPolicies: {
    policies: RateLimitStatus[];
    capped: boolean;
  };
  /**
   * Rolling-statistics rollup progress.
   *
   * `lagMs` is how far the watermark trails now. Raw history retention refuses to delete past the
   * watermark, so a stalled rollup shows up here and as growing retention lag rather than as
   * silently incomplete operator windows.
   */
  statistics: {
    rolledUpThrough: Date;
    lagMs: number;
    lastRunAt: Date | null;
    /** Materialized minute buckets, and the span they currently cover. */
    buckets: number;
    /** True when the bucket count hit the bounded history scan cap and is a lower bound. */
    bucketsCapped: boolean;
    oldestBucketAt: Date | null;
    newestBucketAt: Date | null;
  };
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
  /**
   * Existence of the UTC-daily history partitions for today plus the next three days.
   * A missing day means partition preparation is not keeping ahead of writes.
   */
  historyPartitionDays: Array<{
    /** UTC day in `YYYYMMDD` form, matching the partition name suffix. */
    day: string;
    startsAt: Date;
    hasJobEvents: boolean;
    hasAttemptHistory: boolean;
  }>;
  /** Budget evaluation of this snapshot. Budgets are caller-overridable per call. */
  status: QueueHealthStatus;
  /** Lagging PostgreSQL statistics and server state, separated from the transactional facts. */
  observations: QueueHealthObservations;
}

/** One worker's self-reported runtime state, pushed on its registration cadence. */
export interface WorkerRegistration {
  workerId: string;
  /**
   * Identifies this process incarnation of `workerId`.
   *
   * A refresh from the same instance preserves an operator pause; a new instance clears it, so a
   * restarted worker always comes back running.
   */
  instanceId: string;
  /** Host this worker runs on, recorded independently of what the worker is called. */
  hostname: string;
  /** Operating-system process id of this worker. */
  pid: number;
  /** Queue this worker claims from. Defaults to the queue's own default. */
  queue?: string;
  concurrency: number;
  leaseMs?: number;
  heartbeatMs?: number;
  pollMs?: number;
  maintenanceIntervalMs?: number;
  maintenanceTaskPollMs?: number;
  registryIntervalMs?: number;
  activeSlots: number;
  draining: boolean;
}

/** Result of an operator pause request against one registered worker. */
export interface WorkerPauseResult {
  workerId: string;
  paused: boolean;
  /** Bounded audit attribution, never authorization. */
  pausedBy: string | null;
  reason: string | null;
  pausedAt: Date | null;
  lastHeartbeatAt: Date;
}

/** One row of the durable worker fleet registration. */
export interface WorkerRegistryEntry extends WorkerPauseResult {
  /** The process incarnation currently holding this worker id. */
  instanceId: string;
  hostname: string;
  pid: number;
  queue: string;
  concurrency: number;
  activeSlots: number;
  draining: boolean;
  startedAt: Date;
}
