import type { MaintenancePolicy, Queue, RetentionPolicy, RetryPolicy } from "@workhorse/core";

export type DashboardMaintenancePolicy = Omit<MaintenancePolicy, "updatedAt"> & {
  updatedAt: string;
};

export type DashboardRetentionPolicy = Omit<RetentionPolicy, "updatedAt"> & {
  updatedAt: string;
};

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
      summary:
        "PostgreSQL delays retries after handler failures but retries expired leases immediately",
      exact: "No persisted retry policy",
    };
  if (policy.type === "fixed")
    return {
      label: "Fixed",
      summary: `PostgreSQL adds a ${formatRetryDelay(policy.delayMs)} delay before every retry`,
      exact: `Fixed delay ${policy.delayMs} ms`,
    };
  if (policy.type === "exponential")
    return {
      label: "Exponential",
      // A cap at or below the initial delay removes all growth, so say so rather than implying it.
      summary:
        policy.initialDelayMs >= policy.maxDelayMs
          ? `Every retry has the maximum ${formatRetryDelay(policy.maxDelayMs)} delay`
          : `${formatRetryDelay(policy.initialDelayMs)} × ${policy.multiplier}, capped at ${formatRetryDelay(policy.maxDelayMs)}`,
      exact: `Initial delay ${policy.initialDelayMs} ms; multiplier ${policy.multiplier}; maximum ${policy.maxDelayMs} ms`,
    };
  return {
    label: "Decorrelated jitter",
    // A cap equal to the base leaves no range to randomize, which is a deliberate demo choice.
    summary:
      policy.baseDelayMs >= policy.maxDelayMs
        ? `Every retry has the maximum ${formatRetryDelay(policy.maxDelayMs)} delay`
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
      summary: "This retry uses a chosen delay instead of the saved policy",
      exact: "Manual retry delay override",
    };
  if (source === "legacy-handler") return describeRetryPolicy(null);
  if (source === "lease-recovery-immediate")
    return {
      label: "Immediate recovery",
      summary: "Because Workhorse saved no policy, PostgreSQL requeued the task immediately",
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
    summary: `If you repeat this request in ${evidence.scope} within ${window}, Workhorse returns this task again`,
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
      summary: "Workhorse canceled this task before it started, so no handler ran",
      exact:
        "PostgreSQL removed the task from dispatch and recorded an immutable canceled outcome. " +
        "No handler ran for it, so there is no external effect to reconcile.",
    };
  }
  if (status === "cancel_requested") {
    return {
      label: "Cancellation requested",
      summary: "Workhorse asked the running handler to stop when it next checks the signal",
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
    summary: "Workhorse could not find this task, so it canceled nothing",
    exact: "No task matched this ID. Retention may have deleted it after it finished.",
  };
}

/**
 * How one operator result reads.
 *
 * The distinction that matters is between a request that failed and a request the server answered
 * with a deliberate refusal. A task already finished, already queued, or parked at a durable wait
 * was left alone on purpose and by design; colouring that as an error would send an operator
 * looking for a fault that does not exist. Only `failure` means no decision was reached at all.
 */
export type DashboardResultTone = "neutral" | "success" | "failure";

/** A cancellation changed durable state only when PostgreSQL applied or recorded one. */
export function cancelOutcomeTone(status: DashboardCancelStatus): DashboardResultTone {
  return status === "canceled" || status === "cancel_requested" ? "success" : "neutral";
}

/** Only a release moved a task's start time; every other status left the task exactly as it was. */
export function runNowOutcomeTone(status: DashboardRunNowStatus): DashboardResultTone {
  return status === "released" ? "success" : "neutral";
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

export interface RunNowOutcomeDescription {
  /** Short badge text. Never the raw status string. */
  label: string;
  /** One sentence an operator can act on, complete without colour or icon. */
  summary: string;
  /** Precise wording, including what running now does and does not change. */
  exact: string;
}

/**
 * Run-now wording that matches what the server actually did.
 *
 * Running a scheduled task now only moves *that* task's own start time forward. It does not run the
 * handler here and now, it does not skip a retry budget, and for a task a recurring schedule
 * created it does not touch the schedule's next occurrence. Each sentence below is deliberately
 * limited to those claims, because an operator who believes more happened than did will reconcile
 * the wrong thing.
 */
export function describeRunNowOutcome(
  status: DashboardRunNowStatus,
  context: { state?: string | null } = {},
): RunNowOutcomeDescription {
  if (status === "released") {
    return {
      label: "Released to the queue",
      summary: "Workhorse moved the start time to now, so the task is ready for a worker",
      exact:
        "The scheduled start time was moved forward to now and the task is queued. Work begins " +
        "after the next claim, so this releases the task rather than running the handler here. " +
        "Nothing else about the task changed, and a recurring schedule that created it keeps its " +
        "own next occurrence.",
    };
  }
  if (status === "already_ready") {
    return {
      label: "Already queued",
      summary: "This task was already ready for a worker, so Workhorse changed nothing",
      exact:
        "The task was no longer holding a future start time when the request arrived, so it was " +
        "left exactly as it was. It is already queued or already running.",
    };
  }
  if (status === "waiting") {
    return {
      label: "Suspended at a wait",
      summary: "This task is at a durable wait, so Workhorse kept its requested wake time",
      exact:
        "The task is parked at a durable wait boundary its handler asked for. Moving that boundary " +
        "would resume the handler earlier than the code it is running asked to be resumed, so the " +
        "wait was left exactly as it was.",
    };
  }
  if (status === "not_scheduled") {
    return {
      label: "Not scheduled",
      summary: `This task has no future start time${
        context.state ? ` because it is ${context.state}` : ""
      }, so nothing was released`,
      exact:
        "Only a task holding a future start time can be released early. This one holds no such " +
        "time, so it was left exactly as it was.",
    };
  }
  return {
    label: "Task not found",
    summary: "Workhorse could not find this task, so it released nothing",
    exact: "No task matched this ID. Retention may have deleted it after it finished.",
  };
}

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
  /** Whether this projection includes live utilization from the bounded health summary. */
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

/** Every action a task row can offer. Ids are stable so the menu and its tests never drift. */
export type TaskRowActionId =
  | "inspect"
  | "copy-id"
  | "copy-args"
  | "filter-type"
  | "filter-queue"
  | "filter-worker"
  | "run-now"
  | "cancel";

export interface TaskRowAction {
  id: TaskRowActionId;
  /** What the item reads as for this row's state. Never a raw state string. */
  label: string;
  /**
   * Why this action cannot be taken for this row right now, or null when it can. A complete
   * sentence, because it is shown as the reason rather than leaving a dimmed item unexplained.
   */
  unavailable: string | null;
  /** True for an irreversible action, so the menu can mark it and confirm before applying it. */
  destructive: boolean;
}

export interface TaskRowActionGroup {
  label: string;
  actions: TaskRowAction[];
}

/**
 * Cancel wording for one list row, derived from the same facts the drawer uses.
 *
 * A terminal outcome is immutable, an already-requested cancellation is not repeated, and an active
 * task is described as cooperative rather than forced. The row never promises more than
 * `Queue.cancel` delivers, and it never offers a one-click cancel: the item opens the task drawer
 * where the irreversibility is stated and an optional reason is recorded.
 */
function cancelRowAction(job: DashboardJobRow): TaskRowAction {
  const destructive = true;
  if (isTerminalTaskState(job.state)) {
    return {
      id: "cancel",
      label: "Cancel task",
      unavailable: `Because this task finished as ${job.state}, Workhorse cannot change its outcome.`,
      destructive,
    };
  }
  if (job.cancellation !== null) {
    return {
      id: "cancel",
      label: "Cancellation requested",
      unavailable:
        "Workhorse already asked the running handler to stop, so another request would change nothing.",
      destructive,
    };
  }
  if (job.state === "active") {
    return { id: "cancel", label: "Request cancellation…", unavailable: null, destructive };
  }
  if (job.state === "scheduled") {
    return {
      id: "cancel",
      label: job.waitName === null ? "Cancel scheduled task…" : "Cancel task at wait…",
      unavailable: null,
      destructive,
    };
  }
  if (job.state === "ready") {
    return { id: "cancel", label: "Cancel queued task…", unavailable: null, destructive };
  }
  return {
    id: "cancel",
    label: "Cancel task",
    unavailable: "This task has no live runtime, so there is nothing to cancel.",
    destructive,
  };
}

/**
 * Run-now wording for one list row, resolved against that row's own state.
 *
 * The action releases a task that is holding a future start time, and nothing else. It is offered
 * only for `scheduled`, because that is the only state where a start time is actually being waited
 * on, and it is refused for a scheduled task suspended at a durable wait: that boundary belongs to
 * the handler's own code, and pulling it forward would resume a handler earlier than it asked to be
 * resumed. Every refusal names its reason so the operator learns it here rather than from a menu
 * item that is simply dim.
 */
function runNowRowAction(job: DashboardJobRow, supported: boolean): TaskRowAction {
  const destructive = false;
  if (!supported) {
    return {
      id: "run-now",
      label: "Run now",
      unavailable: "This host does not allow the dashboard to change a task's start time.",
      destructive,
    };
  }
  if (isTerminalTaskState(job.state)) {
    return {
      id: "run-now",
      label: "Run now",
      unavailable: `Because this task finished as ${job.state}, it has no start time to move.`,
      destructive,
    };
  }
  if (job.cancellation !== null) {
    return {
      id: "run-now",
      label: "Run now",
      unavailable:
        "Because Workhorse received a cancellation request, it will not release this task early.",
      destructive,
    };
  }
  if (job.state === "active") {
    return {
      id: "run-now",
      label: "Run now",
      unavailable: "Because this task is running, it has no future start time to move.",
      destructive,
    };
  }
  if (job.state === "ready") {
    return {
      id: "run-now",
      label: "Run now",
      unavailable: "This task is ready for a worker, so it cannot start any sooner.",
      destructive,
    };
  }
  if (job.state === "scheduled") {
    if (job.waitName !== null || job.wait !== null) {
      return {
        id: "run-now",
        label: "Run now",
        unavailable: `The handler requested the durable wait ${job.waitName ?? job.wait!.name}, so the dashboard cannot shorten it.`,
        destructive,
      };
    }
    return { id: "run-now", label: "Run now", unavailable: null, destructive };
  }
  return {
    id: "run-now",
    label: "Run now",
    unavailable: "This task holds no start time, so there is nothing to bring forward.",
    destructive,
  };
}

/**
 * What the connected host is able to do, so the menu can state a capability limit as a reason
 * rather than by quietly dropping an item.
 */
export interface TaskRowActionCapabilities {
  /** True when the host exposes `runTaskNow`. */
  runNow: boolean;
}

/**
 * The action menu offered for one task row, grouped and already resolved against its state.
 *
 * Everything is kept in the menu whether or not it applies, and an inapplicable action carries the
 * reason it cannot be taken. An operator learns why a task cannot be canceled from the same place
 * they would have canceled it, rather than from a menu that silently changes shape row by row. A
 * capability the host does not offer is treated the same way, so a read-only host reads as a stated
 * limit rather than as a missing feature.
 */
export function taskRowActionGroups(
  job: DashboardJobRow,
  capabilities: TaskRowActionCapabilities = { runNow: true },
): TaskRowActionGroup[] {
  const worker = job.workerId ?? job.lastWorkerId;
  return [
    {
      label: "Task",
      actions: [
        { id: "inspect", label: "Open details", unavailable: null, destructive: false },
        { id: "copy-id", label: "Copy task id", unavailable: null, destructive: false },
        {
          id: "copy-args",
          label: "Copy input",
          unavailable:
            job.payload === undefined || job.payload === null
              ? "This task stored no input, so there is nothing to copy."
              : null,
          destructive: false,
        },
      ],
    },
    {
      label: "Filter tasks",
      actions: [
        { id: "filter-type", label: `Only ${job.type}`, unavailable: null, destructive: false },
        {
          id: "filter-queue",
          label: `Only queue ${job.queue}`,
          unavailable: null,
          destructive: false,
        },
        {
          id: "filter-worker",
          label: worker === null ? "Only this worker" : `Only worker ${worker}`,
          unavailable:
            worker === null
              ? "This task has no claim record, so there is no worker to filter by."
              : null,
          destructive: false,
        },
      ],
    },
    {
      label: "Change task",
      actions: [runNowRowAction(job, capabilities.runNow), cancelRowAction(job)],
    },
  ];
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
  /** True when `Queue.health()` capped its policy or blocked-ready scan. */
  concurrencyPoliciesCapped: boolean;
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
  concurrencyPolicy: DashboardConcurrencyPolicySummary | null;
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
  "claimed",
  "succeeded",
  "failed",
  "retry_scheduled",
  "canceled",
  "promoted",
  "lease_expired",
  "execution_timed_out",
  "redriven",
  "redrive_created",
  "wait_elapsed",
] as const;

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
  };
  /**
   * The queue's admission budget as it stands now, not a snapshot of the policy this task ran
   * under. Workhorse stores no per-task snapshot, so a finished task's line must be read as
   * current queue context. Null when the queue has no policy.
   */
  concurrencyPolicy: DashboardConcurrencyPolicySummary | null;
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
    mode: "read-only" | "local";
    supportedMutations: Array<
      | "enqueueTest"
      | "setScheduleEnabled"
      | "setQueuePaused"
      | "purgeQueue"
      | "setWorkerPaused"
      | "cancelTask"
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
        summary: "Workhorse saved the checkpoint, but the seeded failure stops every later stage.",
      };
    }
    return {
      state: "saved",
      label: "Checkpoint saved",
      summary: "Workhorse saved this output and reuses it in every later attempt.",
    };
  }
  if (blockedAfter !== null && input.stepIndex > blockedAfter) {
    return {
      state: "not-reached",
      label: "Not reached",
      summary: "Because an earlier stage blocks the task, no attempt can reach this stage.",
    };
  }
  return {
    state: "pending",
    label: "No checkpoint yet",
    summary: "Workhorse has not saved an output for this stage yet.",
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
      summary: "The task succeeded, and Workhorse saved this final result.",
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
        ? "The task used every attempt and failed, so it produced no result."
        : "The task was canceled before it produced a result.",
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
      ? "This demo fails every attempt. Workhorse records a final failure after the task uses its retry budget."
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
