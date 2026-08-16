import type {
  MaintenancePolicy,
  Queue,
  QueueHealth,
  RetentionPolicy,
  RetryPolicy,
} from "@workhorse/core";

export type DashboardMaintenancePolicy = Omit<MaintenancePolicy, "updatedAt"> & {
  updatedAt: string;
};

export type DashboardRetentionPolicy = Omit<RetentionPolicy, "updatedAt"> & {
  updatedAt: string;
};

export type DashboardDependencyHealth = QueueHealth["dependencies"];
export type DashboardChildHealth = QueueHealth["children"];
export type DashboardExternalWaitHealth = QueueHealth["externalWaits"];

export interface DashboardSettingsPage {
  capturedAt: string;
  editable: boolean;
  maintenance: DashboardMaintenancePolicy;
  retention: DashboardRetentionPolicy;
  workers: Array<{
    id: string;
    queue: string;
    concurrency: number;
    leaseMs: number | null;
    heartbeatMs: number | null;
    pollMs: number | null;
    maintenanceIntervalMs: number | null;
    maintenanceTaskPollMs: number | null;
    registryIntervalMs: number | null;
    lastSeenAt: string;
  }>;
}

export interface DashboardDurabilityPlan {
  source: string;
  scenario: string;
  label: string;
  description: string;
  steps: Array<{ name: string; label: string; description: string }>;
  persistentFailure: {
    afterStepIndex: number;
    afterStepName: string;
    beforeStepName: string;
    reason: string;
  } | null;
}

/**
 * Safe deduplication evidence recorded by PostgreSQL on the single initial `enqueued` event.
 *
 * The raw idempotency key is never stored on the event and therefore never reaches the dashboard.
 * Only a digest, the key length, the retained scope, and the retention window are available, which
 * is enough to explain why a repeated submission reused this identity without publishing a caller
 * secret to every dashboard reader. The event's own `key_preview` is deliberately not read: for a
 * short key that preview is the entire key, so surfacing it would leak the secret it truncates.
 */
export interface IdempotencyEvidence {
  scope: string;
  keyDigest: string;
  keyLength: number;
  ttlMs: number;
  expiresAt: string | null;
  requestDigest: string;
}

/**
 * Detail keys this dashboard reads from `enqueued` `details.idempotency`. A raw key is deliberately
 * absent, and so is `key_preview`, which is only a prefix and therefore reproduces short keys whole.
 */
const idempotencyDetailKeys = [
  "scope",
  "key_digest",
  "key_length",
  "ttl_ms",
  "expires_at",
  "request_digest",
] as const;

function stringDetail(details: Record<string, unknown>, key: string): string | null {
  const value = details[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function numberDetail(details: Record<string, unknown>, key: string): number | null {
  const value = details[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Read the safe deduplication evidence from one recorded job event.
 *
 * Returns null for every event that is not the initial `enqueued` event and for every `enqueued`
 * event that carries no idempotency metadata, so an unkeyed job produces no idempotency surface at
 * all. A structurally incomplete record is also treated as absent rather than partially rendered,
 * because a half-populated claim about deduplication would be worse than saying nothing.
 */
export function readIdempotencyEvidence(event: {
  type: string;
  details: unknown;
}): IdempotencyEvidence | null {
  if (event.type !== "enqueued") return null;
  const details = event.details;
  if (!details || typeof details !== "object") return null;
  const raw = (details as Record<string, unknown>).idempotency;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const scope = stringDetail(record, "scope");
  const keyDigest = stringDetail(record, "key_digest");
  const requestDigest = stringDetail(record, "request_digest");
  const keyLength = numberDetail(record, "key_length");
  const ttlMs = numberDetail(record, "ttl_ms");
  if (
    scope === null ||
    keyDigest === null ||
    requestDigest === null ||
    keyLength === null ||
    ttlMs === null
  ) {
    return null;
  }
  return {
    scope,
    keyDigest,
    keyLength,
    ttlMs,
    expiresAt: stringDetail(record, "expires_at"),
    requestDigest,
  };
}

/** True when any of a task's recorded events carries safe deduplication evidence. */
export function hasIdempotencyEvidence(
  events: ReadonlyArray<{ type: string; details: unknown }>,
): boolean {
  return events.some((event) => readIdempotencyEvidence(event) !== null);
}

/** Detail keys the dashboard is allowed to read. Exported so tests can pin the safe surface. */
export const idempotencyEventDetailKeys: readonly string[] = idempotencyDetailKeys;

/**
 * Cooperative cancellation recorded against one live task.
 *
 * A request is only ever a request. PostgreSQL removes a scheduled or ready task from dispatch
 * immediately, so that cancellation is already final when the call returns. An active task keeps
 * running until its handler observes the abort signal, so the request is stored beside the live
 * runtime row and the task stays active until the handler stops.
 */
export interface DashboardCancellationRequest {
  requestedAt: string;
  requestedBy: string | null;
  reason: string | null;
}

/** Terminal states a task can hold. Cancellation is never folded into failure. */
export type DashboardTerminalState = "succeeded" | "failed" | "canceled";

/** Every lifecycle state the demo read model can project for one task. */
export type DashboardLifecycleState =
  | "scheduled"
  | "ready"
  | "active"
  | DashboardTerminalState
  | "unknown";

/** Statuses `Queue.cancel` can report, mirrored so the demo never invents its own vocabulary. */
export type DashboardCancelStatus =
  | "canceled"
  | "cancel_requested"
  | "already_terminal"
  | "not_found";

/**
 * Statuses the run-now mutation can report. Mirrors the server contract rather than inventing a
 * dashboard-only vocabulary, exactly as `DashboardCancelStatus` mirrors `Queue.cancel`.
 */
export type DashboardRunNowStatus =
  | "released"
  | "already_ready"
  | "not_scheduled"
  | "waiting"
  | "not_found";

export interface DashboardQueueRow {
  queue: string;
  state: string;
  count: number;
  oldestMs: number | null;
}

/** Bounded queue admission facts from `Queue.health()`. Raw concurrency keys are never included. */
export interface DashboardConcurrencyPolicySummary {
  namespace: string;
  maxActive: number;
  /**
   * Whether the counts below were measured, or are placeholders no view may render.
   *
   * Queue and system rows are built from `Queue.health()` and are always measured. Task detail
   * reads its own queue's ceiling exactly and can still lack utilization for it: `health()` samples
   * a bounded number of policies, and a settled task is not measured at all. An unmeasured queue is
   * not an idle one, so when this is false `active`, `available`, `blockedReady`, `saturatedKeys`,
   * and `highestKeyActive` carry no meaning.
   */
  utilizationKnown: boolean;
  active: number;
  available: number;
  blockedReady: number;
  maxActivePerKey: number | null;
  saturatedKeys: number;
  highestKeyActive: number;
}

type QueueConcurrencyPolicy = Awaited<
  ReturnType<Queue["health"]>
>["concurrencyPolicies"]["policies"][number];

/** Remove the queue join key while retaining only bounded aggregate policy facts for one row. */
export function dashboardConcurrencyPolicySummary(
  policy: QueueConcurrencyPolicy,
): DashboardConcurrencyPolicySummary {
  return {
    namespace: policy.namespace,
    maxActive: Number(policy.maxActive),
    utilizationKnown: true,
    active: Number(policy.active),
    available: Number(policy.available),
    blockedReady: Number(policy.blockedReady),
    maxActivePerKey: policy.maxActivePerKey === null ? null : Number(policy.maxActivePerKey),
    saturatedKeys: Number(policy.saturatedKeys),
    highestKeyActive: Number(policy.highestKeyActive),
  };
}

/** Bounded queue rate-limit facts from `Queue.health()`. Raw concurrency keys are never included. */
export interface DashboardRateLimitPolicySummary {
  namespace: string;
  rate: { limit: number; intervalMs: number; burst: number };
  perKey: { limit: number; intervalMs: number; burst: number } | null;
  availableTokens: number;
  throttledReady: number;
  throttledKeys: number;
  nextEligibleAt: string | null;
}

type QueueRateLimitPolicy = Awaited<
  ReturnType<Queue["health"]>
>["rateLimitPolicies"]["policies"][number];

export function dashboardRateLimitPolicySummary(
  policy: QueueRateLimitPolicy,
): DashboardRateLimitPolicySummary {
  return {
    namespace: policy.namespace,
    rate: { ...policy.rate },
    perKey: policy.perKey === null ? null : { ...policy.perKey },
    availableTokens: Number(policy.availableTokens),
    throttledReady: Number(policy.throttledReady),
    throttledKeys: Number(policy.throttledKeys),
    nextEligibleAt: policy.nextEligibleAt?.toISOString() ?? null,
  };
}

export interface DashboardManagedQueueRow {
  queue: string;
  paused: boolean;
  scheduled: number;
  ready: number;
  active: number;
  succeeded: number;
  failed: number;
  /** Operator-canceled tasks. Kept separate from `failed` so a cancellation never reads as a bug. */
  canceled: number;
  terminalCountsApproximate: boolean;
  concurrencyPolicy: DashboardConcurrencyPolicySummary | null;
  rateLimitPolicy: DashboardRateLimitPolicySummary | null;
}

export interface DashboardJobRow extends Record<string, unknown> {
  id: string;
  queue: string;
  type: string;
  priority: number;
  state: string;
  /** Why this live task cannot enter dispatch. Null for every non-blocked task. */
  blockedReason: "prerequisite_pending" | null;
  /** Unresolved prerequisite identities which currently keep this task blocked. */
  prerequisiteJobIds: string[];
  attempt: number;
  maxAttempts: number;
  /** Retry scheduling persisted with the job identity. Null means the default SQL-owned backoff. */
  retryPolicy: RetryPolicy | null;
  deadlineAt?: string | null;
  executionTimeoutMs?: number | null;
  payload: unknown;
  tags: string[];
  /**
   * True when the accepted enqueue recorded deduplication evidence. Derived only from the safe
   * metadata on the initial `enqueued` event, so an unkeyed task stays exactly as it was.
   */
  keyed: boolean;
  /**
   * Cooperative cancellation recorded against this live task, or null when none was requested.
   * A canceled task carries its request on the terminal outcome instead and reports null here.
   */
  cancellation: DashboardCancellationRequest | null;
  runAt: string | null;
  workerId: string | null;
  lastWorkerId: string | null;
  finishedAt: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
  durability: { completedSteps: number; totalSteps: number } | null;
  waitName: string | null;
  wakeAt: string | null;
  wait: { name: string; wakeAt: string; mode: "relative" | "absolute" } | null;
  signalWait: DashboardSignalWaitSummary | null;
}

export interface DashboardScheduleRow {
  kind: "user" | "system";
  identity: {
    kind: "user" | "system";
    namespace: string;
    name: string;
  };
  namespace: string;
  name: string;
  description: string | null;
  cron: string;
  queue: string | null;
  type: string;
  /** User-task dispatch priority. System maintenance rows have no queue priority. */
  priority: number | null;
  enabled: boolean;
  active: boolean;
  revision: string;
  updatedAt: string;
  /** Completed user-schedule occurrences; unavailable for internal maintenance loops. */
  occurrenceCount: number | null;
  lastFiredAt: string | null;
  lastRun?: {
    status: string;
    startedAt: string | null;
    endedAt: string | null;
    message: string | null;
  } | null;
  maintenance?: {
    intervalMs: number;
    phases: string[];
    status: "scheduled" | "due" | "incomplete";
    lastStartedAt: string | null;
    lastCompletedAt: string | null;
  } | null;
}

export interface MaintenanceLoopCadences {
  tickIntervalMs: number;
}

export interface DashboardWorkerRow {
  id: string;
  /**
   * Where the worker runs, reported independently of its name.
   *
   * A deployment that configures a stable `workerId` still needs to answer "which host is that",
   * so placement is not inferred from the identity string. Null when the worker has never
   * registered.
   */
  hostname: string | null;
  pid: number | null;
  /**
   * Jobs PostgreSQL currently reports as active for this worker. It is observed durable state and
   * can briefly differ from `activeSlots`, which is the in-process handler count.
   */
  activeJobs: number;
  /** Declared execution slots, or null when the worker has no durable registration. */
  concurrency: number | null;
  /** Handlers the worker reported executing at its last registration refresh. */
  activeSlots: number | null;
  /** Stopping while in-flight handlers finish. New claims have already ceased. */
  draining: boolean;
  completedAttempts: number;
  failedAttempts: number;
  averageExecutionMs: number | null;
  lastSeenAt: string | null;
  /** When the worker process announced itself, or null when it has no durable registration. */
  startedAt: string | null;
  /** True when the worker has a row in the durable registry, whether or not it is still live. */
  registered: boolean;
  paused: boolean;
  status: "active" | "idle" | "recent" | "offline";
}

export interface DashboardFailureRow {
  id: string;
  queue: string;
  type: string;
  attempt: number;
  finishedAt: string;
  error: unknown;
}

export const dashboardTaskFilters = [
  "all",
  "blocked",
  "scheduled",
  "retried",
  "queued",
  "running",
  "completed",
  "discarded",
  "canceled",
] as const;

export type DashboardTaskFilter = (typeof dashboardTaskFilters)[number];

export const dashboardTaskSorts = ["updated", "priority"] as const;

export type DashboardTaskSort = (typeof dashboardTaskSorts)[number];

/** Highest priority accepted by dashboard filters and operator enqueue controls. */
export const dashboardTaskPriorityMax = 100;

export type DashboardTaskCounts = Record<DashboardTaskFilter, number>;

export type DashboardActivityPeriod = "15m" | "1h" | "6h" | "24h" | "7d";

export type DashboardActivityGroupBy = "queue" | "worker" | "task" | "status";

export interface DashboardActivityBucket {
  bucketStart: string;
  counts: Record<string, number>;
}

export interface DashboardActivityPage {
  capturedAt: string;
  filter: DashboardTaskFilter;
  period: DashboardActivityPeriod;
  groupBy: DashboardActivityGroupBy;
  bucketSeconds: number;
  groups: string[];
  buckets: DashboardActivityBucket[];
}

export interface DashboardTasksPage {
  capturedAt: string;
  filter: DashboardTaskFilter;
  queue: string | null;
  worker: string | null;
  jobType: string | null;
  priority: number | null;
  sort: DashboardTaskSort;
  tags: string[];
  search: string | null;
  page: number;
  pageSize: number;
  total: number;
  counts: DashboardTaskCounts;
  jobs: DashboardJobRow[];
}

export interface DashboardTaskFacets {
  queues: string[];
  workers: string[];
  jobTypes: string[];
  tags: string[];
}

export interface DashboardCronPage {
  capturedAt: string;
  schedules: DashboardScheduleRow[];
}

export interface DashboardQueuesPage {
  capturedAt: string;
  queues: DashboardManagedQueueRow[];
  /** True when `Queue.health()` capped its policy or blocked-ready scan. */
  concurrencyPoliciesCapped: boolean;
  /** True when `Queue.health()` capped its rate policy or throttled-ready scan. */
  rateLimitPoliciesCapped: boolean;
}

export type DashboardSystemWindow = "15m" | "1h" | "24h";

export interface DashboardSystemOutcomeBucket {
  bucketStart: string;
  enqueued: number;
  succeeded: number;
  failed: number;
  retry: number;
  leaseExpired: number;
  /** Operator-canceled attempts. Reported separately so cancellation never inflates failures. */
  canceled: number;
}

export interface DashboardSystemRetryBucket {
  label: "1m" | "5m" | "15m" | "1h" | "later";
  count: number;
}

export interface DashboardSystemQueueRow {
  queue: string;
  paused: boolean;
  ready: number;
  oldestReadyMs: number | null;
  priorityBacklog: Array<{ priority: number; ready: number; oldestReadyMs: number }>;
  dueSoon: number;
  active: number;
  retrying: number;
  enqueuedPerMinute: number;
  completedPerMinute: number;
  concurrencyPolicy: DashboardConcurrencyPolicySummary | null;
  rateLimitPolicy: DashboardRateLimitPolicySummary | null;
}

export interface DashboardSystemFailingType {
  queue: string;
  type: string;
  attempts: number;
  errorRate: number;
  terminalFailures: number;
  lastError: string | null;
  lastSeenAt: string;
}

/** Retention categories exposed by `Queue.health()`, ordered from identity outward. */
export type DashboardRetentionCategory =
  | "jobIdentity"
  | "terminalOutcome"
  | "jobEvents"
  | "attemptHistory"
  | "scheduleOccurrences"
  | "statistics";

export interface DashboardRetentionCategoryRow {
  category: DashboardRetentionCategory;
  /** Operator-facing name; avoids table and partition jargon. */
  label: string;
  /** Configured minimum window in days, or null when the category is never pruned. */
  retentionDays: number | null;
  /** How far past the policy cutoff the oldest retained row still is. */
  lagMs: number | null;
  oldestRetainedAt: string | null;
  /** Partitioned categories are pruned a whole UTC day at a time, so bounded lag is expected. */
  prunedByPartition: boolean;
}

export interface DashboardSystemRetention {
  policyUpdatedAt: string;
  categories: DashboardRetentionCategoryRow[];
  /** Largest lag across categories with retention enabled, or null when all are disabled. */
  maxLagMs: number | null;
  maxLagCategory: DashboardRetentionCategory | null;
  /** Oldest retained timestamp across every category that still holds data. */
  oldestRetainedAt: string | null;
  oldestRetainedCategory: DashboardRetentionCategory | null;
  /** Daily history partitions already past their cutoff but not yet dropped. */
  eligibleHistoryPartitions: { jobEvents: number; attemptHistory: number };
  /** Cumulative rows that landed in the catch-all partitions; never window-scoped. */
  defaultHistoryRows: { jobEvents: number; attemptHistory: number };
  defaultHistoryRowsCapped: { jobEvents: boolean; attemptHistory: boolean };
}

/** One relation an operator can reason about, with partitioned children already folded in. */
export interface DashboardStorageRelation {
  relation: string;
  /** Operator-facing name; avoids table and partition jargon. */
  label: string;
  group: "tasks" | "history" | "statistics";
  totalBytes: number;
  tableBytes: number;
  indexBytes: number;
  rows: number;
  deadRows: number;
  /** Daily partitions attached to this relation; zero for ordinary tables. */
  partitions: number;
  lastVacuumAt: string | null;
}

/**
 * What the derived-statistics and history tables are actually doing.
 *
 * Operators ask two questions when storage grows: what is big, and is the thing that reclaims it
 * still running. This answers both in one place rather than making them infer it from lag numbers.
 */
export interface DashboardSystemStorage {
  rollup: {
    /** Every closed minute below this is materialized; above it, windows derive from raw history. */
    rolledUpThrough: string;
    lagMs: number;
    lastRunAt: string | null;
    buckets: number;
    oldestBucketAt: string | null;
    newestBucketAt: string | null;
    /** True once the watermark has fallen far enough behind to hold history retention. */
    stalled: boolean;
  };
  relations: DashboardStorageRelation[];
  totalBytes: number;
}

export interface DashboardSystemPage {
  capturedAt: string;
  window: DashboardSystemWindow;
  windowSeconds: number;
  status: {
    level: "healthy" | "degraded" | "critical";
    checks: string[];
    /** Checks that forced `critical`; empty when the page is healthy or only degraded. */
    criticalChecks: string[];
    /** Checks that only warrant `degraded`; reported even while `critical` is active. */
    degradedChecks: string[];
  };
  pausedQueues: string[];
  kpis: {
    drain: {
      enqueuedPerMinute: number;
      completedPerMinute: number;
      netPerMinute: number;
    };
    backlog: { ready: number; oldestReadyMs: number | null };
    errorRate: { current: number; previous: number; delta: number };
    queueWait: { p50Ms: number | null; p95Ms: number | null; p99Ms: number | null };
    retry: { backoff: number; dueSoon: number; buckets: DashboardSystemRetryBucket[] };
    lease: { active: number; expired: number; expiringSoon: number; recovered: number };
    dependencies: DashboardDependencyHealth;
    children: DashboardChildHealth;
    externalWaits: DashboardExternalWaitHealth;
    deadline?: {
      pending: number;
      overdue: number;
      dueWithinMinute: number;
      earliestAt: string | null;
      activeTimeouts: number;
      overdueTimeouts: number;
    };
  };
  outcomes: DashboardSystemOutcomeBucket[];
  queues: DashboardSystemQueueRow[];
  /** True when `Queue.health()` capped its policy or blocked-ready scan. */
  concurrencyPoliciesCapped: boolean;
  rateLimitPoliciesCapped: boolean;
  retryStorm: {
    buckets: DashboardSystemRetryBucket[];
    topTypes: Array<{ queue: string; type: string; count: number }>;
  };
  failingTypes: DashboardSystemFailingType[];
  integrity: {
    dueButUnpromoted: number;
    partitions: Array<{
      day: string;
      startsAt: string;
      eventExists: boolean;
      attemptExists: boolean;
    }>;
    /** Cumulative catch-all partition rows, mirrored from `retention.defaultHistoryRows`. */
    defaultEventRows: number;
    defaultAttemptRows: number;
    retention: DashboardSystemRetention;
    storage: DashboardSystemStorage;
  };
}

export interface DashboardWorkersPage {
  capturedAt: string;
  canManageWorkers: boolean;
  workers: DashboardWorkerRow[];
}

/**
 * Lifecycle event names `workhorse.job_event` records.
 *
 * Declared here rather than discovered with a `DISTINCT` scan: the set is fixed by the SQL that
 * writes it, and a filter list built from observed rows would silently lose an option whenever the
 * chosen window happens to contain none of that kind.
 */
export const dashboardJobEventTypes = [
  "enqueued",
  "debounced",
  "debounce_rejected",
  "throttled",
  "claimed",
  "succeeded",
  "failed",
  "retry_scheduled",
  "canceled",
  "cancel_requested",
  "promoted",
  "lease_expired",
  "deadline_exceeded",
  "execution_timed_out",
  "redriven",
  "redrive_created",
  "checkpoint_saved",
  "progress_updated",
  "wait_scheduled",
  "wait_elapsed",
  "wait_replayed",
  "signal_waiting",
  "signal_received",
  "signal_replayed",
  "signal_rejected",
  "dependency_blocked",
  "dependency_released",
  "dependency_failed",
  "dependency_canceled",
  "child_created",
  "child_joined",
  "children_created",
  "children_joined",
  "parent_linked",
  "human_wait_created",
  "human_wait_completed",
  "human_wait_replayed",
  "human_wait_rejected",
] as const;
export type DashboardJobEventType = (typeof dashboardJobEventTypes)[number];

/** Terminal outcomes `workhorse.attempt_history` records, constrained by a CHECK in the schema. */
export const dashboardAttemptOutcomes = [
  "succeeded",
  "failed",
  "retry",
  "lease_expired",
  "canceled",
  "deadline_exceeded",
  "timeout",
] as const;
export type DashboardAttemptOutcome = (typeof dashboardAttemptOutcomes)[number];

/**
 * One value the events feed can be filtered by: an event type or an attempt outcome.
 *
 * The feed merges the two append-only history tables, so a filter names a value from either
 * vocabulary. Naming the union once keeps a filter that survived parsing from having to be
 * re-checked before it is sent.
 */
export type DashboardEventTypeFilter = DashboardJobEventType | DashboardAttemptOutcome;

/** Proves a runtime option list contains every member of its wire union. */
export type CompleteDashboardOptions<Union, Options extends readonly Union[]> =
  Exclude<Union, Options[number]> extends never ? Options : never;

/** The demonstration jobs a demo host can enqueue from the dashboard. */
export type DashboardDemoJobKind =
  | "success"
  | "retry"
  | "durable"
  | "timer"
  | "failure"
  | "idempotent"
  | "long-running"
  | "redrive";

/** The multi-step demo scenarios, each of which enqueues its own shape of work. */
export type DashboardDemoScenario =
  | "order-fulfillment"
  | "customer-onboarding"
  | "report-publication";

/** Which of the two append-only history tables a feed row came from. */
export type DashboardEventKind = "event" | "attempt";

export type DashboardEventsWindow = "15m" | "1h" | "6h" | "24h";

export interface DashboardEventRow {
  /**
   * Stable render identity, `kind:recordId`.
   *
   * The two source tables have independent identity sequences, so neither `recordId` alone is
   * unique across a merged feed.
   */
  id: string;
  kind: DashboardEventKind;
  recordId: string;
  jobId: string;
  /**
   * Queue and type of the job this row belongs to, or null once that job has been retained away.
   *
   * History outlives the `job` row it describes, so the feed reports the orphan rather than
   * dropping it: a deleted job is exactly the case an operator is trying to see.
   */
  queue: string | null;
  jobType: string | null;
  occurredAt: string;
  attempt: number | null;
  /** Lifecycle event name for `event` rows; the attempt outcome for `attempt` rows. */
  type: string;
  /** Event payload for `event` rows. Always null for `attempt` rows. */
  details: unknown;
  workerId: string | null;
  fenceToken: string | null;
  /** Wall-clock the attempt occupied, for the `attempt` rows that closed one. */
  durationMs: number | null;
  errorMessage: string | null;
}

/** Complete evidence for one event drawer, loaded independently of the paginated feed. */
export interface DashboardEventDetail extends DashboardEventRow {
  /** Attempt timing evidence. Always null for lifecycle event rows. */
  startedAt: string | null;
  claimedAt: string | null;
  finishedAt: string | null;
  /** Complete structured attempt error. Always null for lifecycle event rows. */
  error: unknown;
}

/**
 * A page of the durable event history inside a time window, newest first.
 *
 * Paged by offset and total, the same way the task listing is, so an operator moves through a busy
 * window with the control they already know rather than reading a warning that the feed was cut
 * short. It is not keyset-paginated: each polling refresh can move the window head, and a cursor
 * walking backwards through that moving list is a contradiction an operator has to reason about.
 * Deep history for a single task belongs to that task's timeline, which *is* keyset paginated in
 * the drawer; this page answers "what is happening across the fleet".
 */
export interface DashboardEventsPage {
  capturedAt: string;
  window: DashboardEventsWindow;
  windowSeconds: number;
  events: DashboardEventRow[];
  /** 1-based page index, matching the task listing. */
  page: number;
  pageSize: number;
  /** Rows matching the window and filters, across both source tables. */
  total: number;
  /**
   * Retention days for the two source tables, or null when retention is disabled for one.
   *
   * The feed can only reach as far back as the partitions retention still keeps, so the depth is
   * shown rather than left for an operator to infer from a feed that simply stops.
   */
  retention: { jobEventDays: number | null; attemptHistoryDays: number | null };
}

export interface DashboardMetricBucket {
  bucketStart: string;
  enqueued: number;
  succeeded: number;
  failed: number;
  retried: number;
  active: number;
  averageDurationMs: number | null;
}

export interface DashboardJobDetail {
  identity: {
    id: string;
    queue: string;
    type: string;
    priority: number;
    state: string;
    createdAt: string;
    /** Retry scheduling persisted with the job identity. Null means the default SQL-owned backoff. */
    retryPolicy: RetryPolicy | null;
    maxAttempts: number;
    deadlineAt?: string | null;
    executionTimeoutMs?: number | null;
    /**
     * Raw admission key this task was enqueued with. Immutable, so it stays true after the task
     * finishes. Deliberately available only in task detail identity.
     */
    concurrencyKey: string | null;
    /** Stable prerequisite identity, or null when this task has no dependency. */
    prerequisiteJobId: string | null;
    /** Stable prerequisite identities in deterministic order. */
    prerequisiteJobIds: string[];
    /** Terminal outcome policy shared by every prerequisite edge. */
    dependencyPolicy: {
      onSuccess: "release" | "cancel" | "fail";
      onFailure: "release" | "cancel" | "fail";
      onCancellation: "release" | "cancel" | "fail";
    } | null;
    /** When PostgreSQL satisfied the final dependency edge. */
    dependencyReleasedAt: string | null;
    /** Why this task remains blocked. Null after release and for independent tasks. */
    blockedReason: "prerequisite_pending" | null;
  };
  dependencyLineage: {
    records: Array<{
      dependentJobId: string;
      prerequisiteJobId: string;
      onSuccess: "release" | "cancel" | "fail";
      onFailure: "release" | "cancel" | "fail";
      onCancellation: "release" | "cancel" | "fail";
      createdAt: string;
      releasedAt: string | null;
      resolution: "release" | "cancel" | "fail" | null;
    }>;
    truncated: boolean;
  };
  childLineage: {
    records: Array<{
      parentJobId: string;
      childJobId: string;
      name: string;
      type: string;
      createdAt: string;
      joinedAt: string | null;
      outcomeState: "succeeded" | "failed" | "canceled" | null;
      error: unknown;
    }>;
    truncated: boolean;
  };
  redriveLineage: {
    records: Array<{
      sourceJobId: string;
      targetJobId: string;
      requestedBy: string;
      reason: string;
      requestIdPreview: string;
      requestIdDigest: string;
      requestIdLength: number;
      sourceState: "failed";
      targetInitialState: "ready";
      requestedAt: string;
    }>;
    truncated: boolean;
  };
  /**
   * The queue's admission budget as it stands now, not a snapshot of the policy this task ran
   * under. Workhorse stores no per-task snapshot, so a finished task's line must be read as
   * current queue context. Null when the queue has no policy.
   */
  concurrencyPolicy: DashboardConcurrencyPolicySummary | null;
  /** The actionable signal boundary which currently owns this task's suspension. */
  signalWait: DashboardSignalWaitSummary | null;
  canSignal: boolean;
  payload: unknown;
  progress: {
    value: unknown;
    revision: string;
    attempt: number;
    fenceToken: string;
    workerId: string;
    createdAt: string;
    updatedAt: string;
  } | null;
  durability: DashboardDurabilityPlan | null;
  current: {
    runtime: {
      state: string;
      attempt: number;
      runAt: string;
      readyAt: string | null;
      workerId: string | null;
      fenceToken: string;
      acquiredAt: string | null;
      heartbeatAt: string | null;
      expiresAt: string | null;
      waitName: string | null;
      attemptStartedAt: string | null;
      attemptTimeoutAt?: string | null;
      /** Cooperative cancellation requested against this live runtime, if any. */
      cancellation: DashboardCancellationRequest | null;
      error: unknown;
    } | null;
    outcome: {
      state: string;
      attempt: number;
      finishedAt: string;
      result: unknown;
      error: unknown;
    } | null;
    result: unknown;
    error: unknown;
  };
  attempts: Array<{
    attempt: number;
    workerId: string;
    outcome: string;
    startedAt: string;
    claimedAt: string;
    finishedAt: string;
    durationMs: number;
    executionMs: number;
    elapsedMs: number;
    error: unknown;
  }>;
  checkpoints: Array<{
    name: string;
    value: unknown;
    attempt: number;
    fenceToken: string;
    workerId: string;
    createdAt: string;
  }>;
  waits: Array<{
    name: string;
    mode: "relative" | "absolute";
    durationMs: number | null;
    requestedWakeAt: string | null;
    wakeAt: string;
    attempt: number;
    fenceToken: string;
    workerId: string;
    createdAt: string;
  }>;
  events: Array<{
    id: string;
    attempt: number | null;
    type: string;
    details: unknown;
    occurredAt: string;
  }>;
}

export interface DashboardSnapshot {
  capturedAt: string;
  operatorPolicy: {
    mode: "read-only" | "writable";
    supportedMutations: Array<
      | "enqueueTest"
      | "setScheduleEnabled"
      | "setQueuePaused"
      | "purgeQueue"
      | "setWorkerPaused"
      | "cancelTask"
      | "signalTask"
      | "completeHumanWait"
      | "overrideMaintenancePolicy"
      | "revertMaintenancePolicy"
      | "overrideRetentionPolicy"
      | "revertRetentionPolicy"
    >;
    requiredAuditContext: readonly ["actor", "reason", "requestId", "occurredAt"];
  };
  queues: DashboardQueueRow[];
  jobs: DashboardJobRow[];
  schedules: DashboardScheduleRow[];
  workers: DashboardWorkerRow[];
  failures: DashboardFailureRow[];
  metrics: {
    windowSeconds: 7200;
    bucketSeconds: 30;
    buckets: DashboardMetricBucket[];
  };
  health: Awaited<ReturnType<Queue["health"]>>;
}

export interface DashboardHumanWaitRow {
  jobId: string;
  queue: string;
  jobType: string;
  name: string;
  context: unknown;
  attempt: number;
  createdAt: string;
  /** Effective PostgreSQL-owned absolute timeout for this decision. */
  deadlineAt: string;
}

export interface DashboardSignalWaitRow {
  jobId: string;
  queue: string;
  jobType: string;
  name: string;
  attempt: number;
  createdAt: string;
  /** Effective PostgreSQL-owned absolute timeout for this signal. */
  deadlineAt: string;
}

export interface DashboardSignalWaitSummary {
  name: string;
  deadlineAt: string;
}

export interface DashboardHumanWaitPage {
  capturedAt: string;
  canComplete: boolean;
  canSignal: boolean;
  diagnostics: Awaited<ReturnType<Queue["health"]>>["externalWaits"];
  waits: DashboardHumanWaitRow[];
  signalWaits: DashboardSignalWaitRow[];
}
