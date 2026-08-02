import type { Queue, RetryPolicy } from "@workhorse/core";

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

export interface RetryPolicyDescription {
  label: string;
  summary: string;
  exact: string;
}

export function formatRetryDelay(delayMs: number): string {
  if (delayMs >= 60_000 && delayMs % 60_000 === 0) return `${delayMs / 60_000}m`;
  if (delayMs >= 1_000 && delayMs % 1_000 === 0) return `${delayMs / 1_000}s`;
  return `${delayMs}ms`;
}

export function describeRetryPolicy(policy: RetryPolicy | null): RetryPolicyDescription {
  if (policy === null)
    return {
      label: "Default backoff",
      summary: "Handler failures use legacy SQL backoff; lease recovery is immediate",
      exact: "No persisted retry policy",
    };
  if (policy.type === "fixed")
    return {
      label: "Fixed",
      summary: `Wait ${formatRetryDelay(policy.delayMs)} before every retry`,
      exact: `Fixed delay ${policy.delayMs} ms`,
    };
  if (policy.type === "exponential")
    return {
      label: "Exponential",
      // A cap at or below the initial delay removes all growth, so say so rather than implying it.
      summary:
        policy.initialDelayMs >= policy.maxDelayMs
          ? `Held at the ${formatRetryDelay(policy.maxDelayMs)} cap from the first retry`
          : `${formatRetryDelay(policy.initialDelayMs)} × ${policy.multiplier}, capped at ${formatRetryDelay(policy.maxDelayMs)}`,
      exact: `Initial delay ${policy.initialDelayMs} ms; multiplier ${policy.multiplier}; maximum ${policy.maxDelayMs} ms`,
    };
  return {
    label: "Decorrelated jitter",
    // A cap equal to the base leaves no range to randomize, which is a deliberate demo choice.
    summary:
      policy.baseDelayMs >= policy.maxDelayMs
        ? `Held at the ${formatRetryDelay(policy.maxDelayMs)} cap, so every retry waits the same`
        : `${formatRetryDelay(policy.baseDelayMs)} base, capped at ${formatRetryDelay(policy.maxDelayMs)}`,
    exact: `Base delay ${policy.baseDelayMs} ms; maximum ${policy.maxDelayMs} ms`,
  };
}

export function describeRetryEventSource(
  source: string | null,
  policy: RetryPolicy | null,
): RetryPolicyDescription {
  if (source === "override")
    return {
      label: "Manual override",
      summary: "This selected delay took precedence over the persisted policy",
      exact: "Manual retry delay override",
    };
  if (source === "legacy-handler") return describeRetryPolicy(null);
  if (source === "lease-recovery-immediate")
    return {
      label: "Immediate recovery",
      summary: "No policy was persisted, so the expired lease requeued immediately",
      exact: "Immediate lease-recovery compatibility default",
    };
  return describeRetryPolicy(policy);
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

/** Whole days, whole hours, then minutes. A retention window is never shown as false precision. */
export function formatIdempotencyWindow(ttlMs: number): string {
  const day = 86_400_000;
  const hour = 3_600_000;
  const minute = 60_000;
  if (ttlMs >= day && ttlMs % day === 0) {
    const days = ttlMs / day;
    return days === 1 ? "24 hours" : `${days} days`;
  }
  if (ttlMs >= hour && ttlMs % hour === 0) {
    const hours = ttlMs / hour;
    return hours === 1 ? "1 hour" : `${hours} hours`;
  }
  if (ttlMs >= minute && ttlMs % minute === 0) {
    const minutes = ttlMs / minute;
    return minutes === 1 ? "1 minute" : `${minutes} minutes`;
  }
  return `${ttlMs} ms`;
}

/** Short digests keep the drawer readable; the full value stays available in the exact wording. */
function shortDigest(digest: string): string {
  return digest.length > 12 ? digest.slice(0, 12) : digest;
}

export interface IdempotencyDescription {
  label: string;
  summary: string;
  exact: string;
}

/**
 * State the deduplication contract in words rather than as stored field names.
 *
 * Wording is deliberately precise about what PostgreSQL actually guarantees: an identical repeat
 * submission within the retained window returns this same task identity instead of creating a new
 * one, and a changed request under the same key is refused rather than silently accepted.
 */
export function describeIdempotency(evidence: IdempotencyEvidence): IdempotencyDescription {
  const window = formatIdempotencyWindow(evidence.ttlMs);
  return {
    label: "Keyed",
    summary: `Repeating this exact request in scope ${evidence.scope} returns this same task for ${window}`,
    exact:
      `Scope ${evidence.scope}; key digest ${evidence.keyDigest}; ` +
      `key length ${evidence.keyLength} bytes; ` +
      `request digest ${evidence.requestDigest}; retained for ${evidence.ttlMs} ms` +
      (evidence.expiresAt === null ? "" : `; retained until ${evidence.expiresAt}`) +
      ". The raw key is never stored on the event and is never shown here.",
  };
}

/** Compact one-line evidence used beside the drawer heading. */
export function idempotencyEvidenceLine(evidence: IdempotencyEvidence): string {
  const parts = [
    `scope ${evidence.scope}`,
    `key length ${evidence.keyLength}`,
    `digest ${shortDigest(evidence.keyDigest)}`,
    `request ${shortDigest(evidence.requestDigest)}`,
  ];
  return parts.join(" · ");
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

const terminalStates = new Set<string>(["succeeded", "failed", "canceled"]);

/** True for a state that can no longer change, so no operator action may be offered for it. */
export function isTerminalTaskState(state: string): boolean {
  return terminalStates.has(state);
}

/** Statuses `Queue.cancel` can report, mirrored so the demo never invents its own vocabulary. */
export type DashboardCancelStatus =
  | "canceled"
  | "cancel_requested"
  | "already_terminal"
  | "not_found";

export interface CancelOutcomeDescription {
  /** Short badge text. Never the raw status string. */
  label: string;
  /** One sentence an operator can act on. Complete on its own without colour or icon. */
  summary: string;
  /** Precise wording, including the external-effect caveat where it applies. */
  exact: string;
}

/**
 * Cancellation wording that matches what PostgreSQL actually did.
 *
 * The active case deliberately does not promise force, immediacy, or exactly-once cleanup: the
 * handler owns when it observes the signal, and external effects it already started can continue
 * until then. Saying otherwise here would be a stronger claim than the product makes.
 */
export function describeCancelOutcome(
  status: DashboardCancelStatus,
  context: { state?: string | null } = {},
): CancelOutcomeDescription {
  if (status === "canceled") {
    return {
      label: "Canceled",
      summary: "This task was canceled before it started, so no handler ran",
      exact:
        "PostgreSQL removed the task from dispatch and recorded an immutable canceled outcome. " +
        "No handler ran for it, so there is no external effect to reconcile.",
    };
  }
  if (status === "cancel_requested") {
    return {
      label: "Cancellation requested",
      summary:
        "Cooperative cancellation was requested; the running handler stops when it observes the signal",
      exact:
        "The task is still active. Cancellation is cooperative: the handler is signaled and stops " +
        "at its next check, so external effects it already started can continue until it observes " +
        "the signal. The task becomes canceled only once the handler stops.",
    };
  }
  if (status === "already_terminal") {
    return {
      label: "Already finished",
      summary: `This task had already finished${
        context.state ? ` as ${context.state}` : ""
      }, so nothing was canceled`,
      exact:
        "A terminal outcome is immutable. The recorded outcome was left exactly as it was and no " +
        "cancellation was applied.",
    };
  }
  return {
    label: "Task not found",
    summary: "This task no longer exists, so nothing was canceled",
    exact:
      "No job identity matched this id. It may have been removed by retention after it finished.",
  };
}

/**
 * How a live task's pending cancellation reads in a list row or drawer.
 *
 * Returns null when nothing was requested, so an untouched task keeps exactly the surface it had.
 */
export function describeCancellationRequest(
  request: DashboardCancellationRequest | null,
): CancelOutcomeDescription | null {
  if (request === null) return null;
  const described = describeCancelOutcome("cancel_requested");
  const attribution = [
    request.requestedBy === null ? null : `requested by ${request.requestedBy}`,
    request.reason === null ? null : `reason: ${request.reason}`,
  ].filter((part): part is string => part !== null);
  return {
    label: described.label,
    summary: described.summary,
    exact: `Requested at ${request.requestedAt}${
      attribution.length > 0 ? `; ${attribution.join("; ")}` : ""
    }. ${described.exact}`,
  };
}

export interface DashboardQueueRow {
  queue: string;
  state: string;
  count: number;
  oldestMs: number | null;
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
}

export interface DashboardJobRow extends Record<string, unknown> {
  id: string;
  queue: string;
  type: string;
  state: string;
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
   * Jobs PostgreSQL currently reports as active for this worker. It is observed durable state and
   * can briefly differ from `activeSlots`, which is the in-process handler count.
   */
  activeJobs: number;
  /** Declared execution slots configured for this worker, or null when it is not local. */
  concurrency: number | null;
  /** Handlers executing inside this process right now, or null when the worker is not local. */
  activeSlots: number | null;
  /** Stopping while in-flight handlers finish. New claims have already ceased. */
  draining: boolean;
  completedAttempts: number;
  failedAttempts: number;
  averageExecutionMs: number | null;
  lastSeenAt: string | null;
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

export type DashboardTaskFilter =
  | "all"
  | "scheduled"
  | "retried"
  | "queued"
  | "running"
  | "completed"
  | "discarded"
  | "canceled";

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
  dueSoon: number;
  active: number;
  retrying: number;
  enqueuedPerMinute: number;
  completedPerMinute: number;
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
  | "scheduleOccurrences";

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
  };
}

export interface DashboardWorkersPage {
  capturedAt: string;
  canManageWorkers: boolean;
  workers: DashboardWorkerRow[];
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
    state: string;
    createdAt: string;
    /** Retry scheduling persisted with the job identity. Null means the default SQL-owned backoff. */
    retryPolicy: RetryPolicy | null;
    maxAttempts: number;
    deadlineAt?: string | null;
    executionTimeoutMs?: number | null;
  };
  payload: unknown;
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
    mode: "read-only" | "local";
    supportedMutations: Array<
      | "enqueueTest"
      | "setScheduleEnabled"
      | "setQueuePaused"
      | "purgeQueue"
      | "setWorkerPaused"
      | "cancelTask"
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

export type DurableBoundaryState = "saved" | "blocked" | "not-reached" | "pending";

export interface DurableBoundaryDescription {
  state: DurableBoundaryState;
  /** Short text badge. Carries the state on its own, so colour stays decoration. */
  label: string;
  /** One sentence that is true without reading any other part of the drawer. */
  summary: string;
}

/**
 * State of one declared stage.
 *
 * A stage after a persistent blocking boundary is reported as never reached rather than as
 * waiting to run, because no future attempt can get there.
 */
export function describeDurableBoundary(input: {
  stepIndex: number;
  hasCheckpoint: boolean;
  persistentFailureAfterStepIndex: number | null;
}): DurableBoundaryDescription {
  const blockedAfter = input.persistentFailureAfterStepIndex;
  if (input.hasCheckpoint) {
    if (blockedAfter !== null && input.stepIndex === blockedAfter) {
      return {
        state: "blocked",
        label: "Intentionally blocked between stages",
        summary:
          "This checkpoint output is durable, but the seeded failure stops the task immediately after this stage, so nothing past it can run.",
      };
    }
    return {
      state: "saved",
      label: "Checkpoint saved",
      summary:
        "The checkpoint output for this stage is stored and is reused by every later attempt.",
    };
  }
  if (blockedAfter !== null && input.stepIndex > blockedAfter) {
    return {
      state: "not-reached",
      label: "Not reached",
      summary:
        "This stage was never reached and no future attempt can reach it, because the task is blocked at an earlier stage.",
    };
  }
  return {
    state: "pending",
    label: "No checkpoint yet",
    summary: "No checkpoint output has been stored for this stage yet.",
  };
}

export type TaskResultState = "succeeded" | "failed" | "canceled" | "pending";

export interface TaskResultDescription {
  state: TaskResultState;
  /** Badge text. Never the raw stored state and never colour-dependent. */
  label: string;
  /** One sentence stating what the stored evidence does and does not prove. */
  summary: string;
  /** Heading for the stored JSON value, or null when there is no final value to show. */
  valueLabel: string | null;
  /** Shown instead of a value, so an empty state never renders an invented value. */
  emptyLabel: string | null;
}

export interface TaskResultEvidence {
  description: TaskResultDescription;
  value: unknown;
}

/**
 * Final outcome of one task, described from the stored terminal row only.
 *
 * A live or scheduled task has no final outcome, and that is stated plainly rather than shown as
 * an empty result. A scheduled retry may still carry the error from its latest finished attempt,
 * which is labelled as an attempt error, never as a terminal one.
 */
export function describeTaskResult(input: {
  state: string;
  hasOutcome: boolean;
  outcomeState: string | null;
  hasResultValue: boolean;
  hasErrorValue: boolean;
  blockedByPersistentFailure: boolean;
}): TaskResultDescription {
  const terminal = input.hasOutcome ? (input.outcomeState ?? input.state) : null;
  if (terminal === "succeeded") {
    return {
      state: "succeeded",
      label: "Succeeded",
      summary: "The task finished successfully and this is the stored final result.",
      valueLabel: input.hasResultValue ? "Final result" : null,
      emptyLabel: input.hasResultValue
        ? null
        : "This task returned no value, so no final result was stored.",
    };
  }
  if (terminal === "failed" || terminal === "canceled") {
    const failed = terminal === "failed";
    return {
      state: failed ? "failed" : "canceled",
      label: failed ? "Failed" : "Canceled",
      summary: failed
        ? "The task exhausted its attempts and ended as failed, so no result was produced."
        : "The task was canceled before it could produce a result, so nothing here reports success.",
      valueLabel: input.hasErrorValue ? "Terminal error" : null,
      emptyLabel: input.hasErrorValue
        ? null
        : failed
          ? "No error value was stored with the terminal failure."
          : "No error value was stored with the cancellation.",
    };
  }
  return {
    state: "pending",
    label: "No final outcome yet",
    summary: input.blockedByPersistentFailure
      ? "This task is seeded to fail on every attempt. It has no final outcome while retries remain; exhausting its attempt budget records a terminal failure."
      : "This task has not finished, so no final result or terminal error exists yet.",
    valueLabel: input.hasErrorValue ? "Latest attempt error" : null,
    emptyLabel: input.hasErrorValue
      ? null
      : "No attempt has failed yet, so there is nothing to show.",
  };
}

/** Derive drawer evidence from the real nullable PostgreSQL projection. */
export function readTaskResultEvidence(input: {
  state: string;
  outcome: { state: string; result: unknown; error: unknown } | null;
  runtimeError: unknown;
  currentError: unknown;
  blockedByPersistentFailure: boolean;
}): TaskResultEvidence {
  const terminalValue =
    input.outcome?.state === "succeeded" ? input.outcome.result : input.outcome?.error;
  const pendingValue = input.runtimeError ?? input.currentError;
  const value = input.outcome !== null ? terminalValue : pendingValue;
  const hasValue = value !== null && value !== undefined;
  const description = describeTaskResult({
    state: input.state,
    hasOutcome: input.outcome !== null,
    outcomeState: input.outcome?.state ?? null,
    hasResultValue: input.outcome?.state === "succeeded" && hasValue,
    hasErrorValue: input.outcome?.state !== "succeeded" && hasValue,
    blockedByPersistentFailure: input.blockedByPersistentFailure,
  });
  return {
    description,
    value: description.valueLabel === null ? undefined : value,
  };
}
