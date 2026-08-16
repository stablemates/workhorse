import type { Json, RetryPolicy } from "@workhorse/core";
import type {
  DashboardCancellationRequest,
  DashboardCancelStatus,
  DashboardDemoJobKind,
  DashboardDemoScenario,
  DashboardJobRow,
  DashboardHumanWaitRow,
  DashboardRunNowStatus,
  CompleteDashboardOptions,
  IdempotencyEvidence,
} from "@workhorse/dashboard-server/wire";
import {
  dashboardAttemptOutcomes as wireAttemptOutcomes,
  dashboardJobEventTypes as wireJobEventTypes,
} from "@workhorse/dashboard-server/wire";

export const dashboardJobEventTypes = wireJobEventTypes;
export const dashboardAttemptOutcomes = wireAttemptOutcomes;

export function isHumanWaitOverdue(wait: DashboardHumanWaitRow, nowMs: number): boolean {
  return Date.parse(wait.deadlineAt) <= nowMs;
}

/** Overdue decisions come first, then every group is ordered by its nearest deadline. */
export function orderHumanWaits(
  waits: readonly DashboardHumanWaitRow[],
  nowMs: number,
): DashboardHumanWaitRow[] {
  // The dashboard's browser target does not include ES2023 Array.prototype.toSorted yet.
  // oxlint-disable-next-line unicorn/no-array-sort
  return [...waits].sort((left, right) => {
    const leftOverdue = isHumanWaitOverdue(left, nowMs);
    const rightOverdue = isHumanWaitOverdue(right, nowMs);
    if (leftOverdue !== rightOverdue) return leftOverdue ? -1 : 1;
    return Date.parse(left.deadlineAt) - Date.parse(right.deadlineAt);
  });
}

export function filterHumanWaits(
  waits: readonly DashboardHumanWaitRow[],
  options: { search: string; overdueOnly: boolean; nowMs: number },
): DashboardHumanWaitRow[] {
  const query = options.search.trim().toLowerCase();
  return waits.filter((wait) => {
    if (options.overdueOnly && !isHumanWaitOverdue(wait, options.nowMs)) return false;
    if (!query) return true;
    return [wait.name, wait.jobId, wait.jobType, wait.queue].some((value) =>
      value.toLowerCase().includes(query),
    );
  });
}

export interface ParsedHumanWaitResult {
  value: Json;
  formatted: string;
}

/** One parser owns both the value sent to the handler and the formatted review copy. */
export function parseHumanWaitResult(source: string): ParsedHumanWaitResult | null {
  try {
    const value = JSON.parse(source) as Json;
    return { value, formatted: JSON.stringify(value, null, 2) };
  } catch {
    return null;
  }
}

export function humanWaitResultsDirty(results: Readonly<Record<string, string>>): boolean {
  return Object.values(results).some((result) => result.trim().length > 0);
}

const demoJobKinds = [
  "success",
  "retry",
  "durable",
  "timer",
  "failure",
  "idempotent",
  "long-running",
] as const;
export const dashboardDemoJobKinds: CompleteDashboardOptions<
  DashboardDemoJobKind,
  typeof demoJobKinds
> = demoJobKinds;

const demoScenarios = ["order-fulfillment", "customer-onboarding", "report-publication"] as const;
export const dashboardDemoScenarios: CompleteDashboardOptions<
  DashboardDemoScenario,
  typeof demoScenarios
> = demoScenarios;

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
const terminalStates = new Set<string>(["succeeded", "failed", "canceled"]);

/** True for a state that can no longer change, so no operator action may be offered for it. */
export function isTerminalTaskState(state: string): boolean {
  return terminalStates.has(state);
}
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
