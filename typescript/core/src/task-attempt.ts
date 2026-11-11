import {
  CancellationRequestedError,
  DeadlineExceededError,
  ExecutionTimeoutError,
} from "./errors.js";
import type { FailureStatus } from "./queue/claim-lease-fence.js";
import {
  logInfo,
  logWarn,
  recordHandlerExecution,
  taskSpanAttributes,
  type TaskExecutionOutcome,
} from "./telemetry.js";
import { monotonicNow, setUnrefTimeoutAt } from "./timers.js";
import type {
  ClaimedTask,
  ExpireOwnedStatus,
  HeartbeatBatchStatus,
  ReleaseOwnedStatus,
} from "./types.js";

const DURABLE_WAIT_SUSPENSION = Symbol("workhorse.durableWaitSuspension");
const CHILD_TASK_SUSPENSION = Symbol("workhorse.childTaskSuspension");
// Bounds on the wait before asking PostgreSQL again whether a local expiry has arrived.
const EXPIRATION_RETRY_MIN_MS = 5;
const EXPIRATION_RETRY_MAX_MS = 1_000;
// How long a final settlement waits for an expiration request already in flight, as Go and Rust
// bound their retries of a not_due answer.
const SHARED_EXPIRATION_BUDGET_MS = 1_000;

/**
 * AbortSignal reason when the worker process reaches the end of its shutdown grace.
 *
 * The worker still owns the task, so the heartbeat keeps the lease alive while the handler unwinds.
 * A value that the handler returns then completes the task, and an error releases it without an
 * attempt (SM-1919).
 */
class WorkerShutdownError extends Error {
  constructor(readonly taskId: string) {
    super(`The worker is shutting down and stopped the handler of task ${taskId}`);
    this.name = "WorkerShutdownError";
  }
}

type AttemptOutcome =
  | "completed"
  | "failed"
  | "cancelled"
  | "deadline_exceeded"
  | "attempt_timeout"
  | "lease_expired"
  | "released"
  | "suspended_for_wait"
  | "suspended_for_child";

class AttemptOutcomeArbiter {
  private accepted: AttemptOutcome | undefined;

  get outcome(): AttemptOutcome | undefined {
    return this.accepted;
  }

  submit(outcome: AttemptOutcome): boolean {
    if (this.accepted !== undefined) return false;
    this.accepted = outcome;
    return true;
  }

  is(outcome: AttemptOutcome): boolean {
    return this.accepted === outcome;
  }

  isSuspended(): boolean {
    return this.is("suspended_for_wait") || this.is("suspended_for_child");
  }
}

/** The worker services one attempt needs to hold and give up its task's ownership. */
export interface TaskAttemptServices {
  workerId: string;
  /** The lease duration each claim and accepted heartbeat grants. */
  leaseMs: number;
  acknowledgeCancel(task: ClaimedTask, workerId: string): Promise<boolean>;
  expireOwned(task: ClaimedTask, workerId: string): Promise<ExpireOwnedStatus>;
  /**
   * Registers the task for heartbeats. `sentAt` is when the reporting round's request left, read
   * from `monotonicNow()`. `leaseEndsAt` gives the end of the local lease window on the same clock,
   * or undefined once the window is closed. A busy retry never runs past it.
   */
  addHeartbeatLease(
    task: ClaimedTask,
    status: (status: HeartbeatBatchStatus, sentAt: number) => void,
    leaseEndsAt: () => number | undefined,
  ): () => void;
}

/**
 * One claimed task's ownership for the duration of a handler activation.
 *
 * The attempt owns the abort signal the handler sees, and the arbiter that decides which outcome
 * wins when cancellation, expiry, lease loss, suspension, and completion race. It keeps the lease
 * alive through the worker's heartbeat batch and asks PostgreSQL to expire it when the deadline or
 * attempt timeout arrives. The handler is aborted only once PostgreSQL confirms that expiry.
 *
 * A lease watchdog aborts the attempt once its last accepted renewal is a full lease old. By then
 * another worker may own the task, and fencing only protects the database, not external effects.
 * Both timers run on the monotonic clock, so a worker wall clock that is wrong or that jumps moves
 * neither of them. Construction starts the heartbeat, the expiration timer, and the watchdog;
 * `stop()` ends them.
 */
export class TaskAttempt {
  readonly arbiter = new AttemptOutcomeArbiter();
  private readonly controller = new AbortController();
  private cancelExpirationTimer: (() => void) | undefined;
  private cancelLeaseWatchdog: (() => void) | undefined;
  // When the local lease window ends, on the monotonic clock.
  private leaseWindowEndsAt: number | undefined;
  // When the earlier of the deadline and the attempt timeout arrives, on the monotonic clock.
  private expirationDueAt: number | undefined;
  private expirationPromise: Promise<ExpireOwnedStatus> | undefined;
  private heartbeatStopped = false;
  // Set once a heartbeat answer reports the deadline or attempt timeout. That is PostgreSQL's
  // verdict, so asking it to expire ownership continues after the attempt stops.
  private expiryReported = false;
  // Set when the worker settles the attempt after its handler ended. Then an expiry request that
  // PostgreSQL answers not_due does not ask again.
  private settling = false;
  // Ends the wait between two expiry requests, so settlement does not wait for the next request.
  private wakeExpirationRetry: (() => void) | undefined;
  private removeHeartbeatLease: (() => void) | undefined;
  // Set when the shutdown abort ended the handler signal before any other outcome.
  private shutdownRequested = false;
  // Whether the shutdown abort came before the handler returned, or undefined before it returns.
  private shutdownAtReturn: boolean | undefined;

  constructor(
    readonly task: ClaimedTask,
    private readonly services: TaskAttemptServices,
    private readonly activation: { outcome: TaskExecutionOutcome },
    /** When the claim request left, read from `monotonicNow()`. */
    claimSentAt: number,
  ) {
    const expirationAt = [task.deadlineAt, task.attemptTimeoutAt].reduce<Date | null>(
      (earliest, candidate) =>
        candidate !== null && (earliest === null || candidate < earliest) ? candidate : earliest,
      null,
    );
    if (expirationAt) {
      // PostgreSQL computed the lease and the expiry from one reading of its clock, and that
      // reading is leaseExpiresAt minus the lease. The time left from that reading to the expiry
      // is counted on the monotonic clock from now, so the worker's wall clock never enters it.
      // The answer arrived after the reading, so the timer can fire late but never early. The extra
      // millisecond covers both timestamps being truncated to milliseconds on the way here.
      const databaseClaimedAt = task.leaseExpiresAt.getTime() - services.leaseMs;
      this.expirationDueAt = monotonicNow() + expirationAt.getTime() - databaseClaimedAt + 1;
      this.armExpirationTimer(this.expirationDueAt, EXPIRATION_RETRY_MIN_MS);
    }
    this.removeHeartbeatLease = services.addHeartbeatLease(
      task,
      (status, sentAt) => this.refreshOwnership(status, sentAt),
      () => this.leaseWindowEndsAt,
    );
    this.renewLease(claimSentAt);
  }

  /** The signal handed to the handler; it aborts when this attempt loses its task. */
  get signal(): AbortSignal {
    return this.controller.signal;
  }

  /**
   * Every durable side effect first confirms that this attempt still owns the task.
   *
   * A lease window that has run out ends here, even if its watchdog timer has not fired yet. A
   * late claim answer or a blocked event loop can leave the window spent with that timer still due.
   */
  requireLease(): void {
    if (this.leaseWindowEndsAt !== undefined && monotonicNow() >= this.leaseWindowEndsAt) {
      this.endLeaseWindow();
    }
    if (this.controller.signal.aborted)
      throw this.controller.signal.reason ?? new Error("Task lease was lost");
  }

  /**
   * The check before the worker writes the final transition of the attempt. The shutdown abort does
   * not end the ownership, so the worker can still complete or release the task after it.
   */
  requireSettlementLease(): void {
    if (this.leaseWindowEndsAt !== undefined && monotonicNow() >= this.leaseWindowEndsAt) {
      this.endLeaseWindow();
    }
    if (this.controller.signal.aborted && !this.stoppedForShutdown)
      throw this.controller.signal.reason ?? new Error("Task lease was lost");
  }

  /**
   * Aborts the handler signal at the end of the shutdown grace. The heartbeat continues, because
   * `release_owned_v1` and `complete_v1` refuse an expired lease. Another outcome that already won
   * keeps its signal reason.
   */
  abortForShutdown(): void {
    if (this.arbiter.outcome !== undefined || this.controller.signal.aborted) return;
    this.shutdownRequested = true;
    this.controller.abort(new WorkerShutdownError(this.task.id));
  }

  /** True when the shutdown abort ended the handler and no other outcome won after it. */
  get stoppedForShutdown(): boolean {
    return this.shutdownRequested && this.arbiter.outcome === undefined;
  }

  /**
   * Records that the handler returned. A batch member records it when the batch callback returns.
   * Only the first call counts.
   */
  markHandlerReturned(): void {
    this.shutdownAtReturn ??= this.shutdownRequested;
  }

  /**
   * True when the shutdown abort came before the handler returned and no other outcome won. A
   * failure then releases the task (ADR 0117). A stop that comes after the return cannot turn a
   * failure of the handler's own into a release.
   */
  get failedAfterShutdown(): boolean {
    return (this.shutdownAtReturn ?? this.shutdownRequested) && this.arbiter.outcome === undefined;
  }

  /**
   * Suspend on a durable wait or child, even if another outcome already won. PostgreSQL parked the
   * task, so the code after the wait must not run before the wake. A stale heartbeat, a stale
   * expiry answer, or the lease watchdog can win while the wait request is in flight. The handler
   * then still stops here, and the outcome that won stays (SM-1929).
   */
  suspend(outcome: "suspended_for_wait" | "suspended_for_child"): never {
    const reason =
      outcome === "suspended_for_wait" ? DURABLE_WAIT_SUSPENSION : CHILD_TASK_SUSPENSION;
    if (this.arbiter.submit(outcome)) this.controller.abort(reason);
    throw reason;
  }

  /** Stop renewing the lease and cancel the local expiration timer. */
  stop(): void {
    this.stopHeartbeat();
    this.cancelExpirationTimer?.();
    this.cancelExpirationTimer = undefined;
    this.cancelLeaseWatchdog?.();
    this.cancelLeaseWatchdog = undefined;
    this.leaseWindowEndsAt = undefined;
  }

  markCancellationRequested(): void {
    this.arbiter.submit("cancelled");
    this.stop();
    this.abort(new CancellationRequestedError(this.task.id));
  }

  async acknowledgeCancellation(): Promise<boolean> {
    const accepted = await this.services.acknowledgeCancel(this.task, this.services.workerId);
    if (accepted && this.arbiter.is("cancelled")) this.recordExecution("canceled");
    return accepted;
  }

  /**
   * Acknowledges the cancellation that a fenced failure or release answered with, and returns
   * whether PostgreSQL accepted it. The outcome comes from that answer: `canceled` if PostgreSQL
   * accepts, also when a `stale` heartbeat answer arrived first. If PostgreSQL refuses, the worker
   * settled nothing, so the attempt reports a lost lease.
   */
  async acknowledgeRequestedCancellation(): Promise<boolean> {
    this.stop();
    this.abort(new CancellationRequestedError(this.task.id));
    const accepted = await this.services.acknowledgeCancel(this.task, this.services.workerId);
    this.recordSettled(accepted ? "cancelled" : "lease_expired");
    return accepted;
  }

  /**
   * Settles the cause of a fenced failure or release that PostgreSQL answered `stale`, under this
   * attempt's fence, and returns the handler span outcome.
   *
   * `expire_owned_v1` does not read `expires_at`, so a due deadline or attempt timeout settles also
   * after the lease lapsed under an unchanged fence (SM-1884). A requested cancellation settles
   * when `acknowledge_cancel_v1` accepts it. Any other answer leaves the task to lease recovery and
   * reports a lost lease.
   *
   * A local expiry can ask PostgreSQL at the same time. The request that commits first settles the
   * boundary, and the other one reads `stale`. Thus the reconciliation uses the answer of a request
   * already in flight, and waits for it for at most {@link SHARED_EXPIRATION_BUDGET_MS}. That
   * request can ask again after a `not_due` answer. If it does not answer in time, the
   * reconciliation sends one request of its own.
   */
  async reconcileStale(): Promise<"canceled" | "deadline_exceeded" | "timeout_exceeded" | "stale"> {
    let status =
      (await this.sharedExpiration()) ??
      (await this.services.expireOwned(this.task, this.services.workerId));
    if (status === "stale") status = (await this.sharedExpiration()) ?? status;
    if (status === "deadline_exceeded") return this.recordSettled("deadline_exceeded");
    if (status === "timeout_exceeded") return this.recordSettled("attempt_timeout");
    if (
      status === "cancel_requested" &&
      (await this.services.acknowledgeCancel(this.task, this.services.workerId))
    ) {
      return this.recordSettled("cancelled");
    }
    return this.recordSettled("lease_expired");
  }

  /** The answer of the expiration request in flight, or undefined if none answers in time. */
  private async sharedExpiration(): Promise<ExpireOwnedStatus | undefined> {
    const pending = this.expirationPromise;
    if (pending === undefined) return undefined;
    let cancel: (() => void) | undefined;
    const timeout = new Promise<undefined>((resolve) => {
      const timer = setTimeout(resolve, SHARED_EXPIRATION_BUDGET_MS, undefined);
      cancel = () => clearTimeout(timer);
    });
    try {
      // A failed request proves nothing about the expiry, so the reconciliation asks itself.
      return await Promise.race([pending.catch(() => undefined), timeout]);
    } finally {
      cancel?.();
    }
  }

  /**
   * Records the outcome that PostgreSQL settled, and returns its handler span outcome. The
   * activation records that outcome, also when a racing answer submitted another one first.
   */
  private recordSettled(
    outcome: "cancelled" | "deadline_exceeded" | "attempt_timeout" | "lease_expired",
  ): "canceled" | "deadline_exceeded" | "timeout_exceeded" | "stale" {
    this.arbiter.submit(outcome);
    if (outcome === "cancelled") {
      this.recordExecution("canceled");
      return "canceled";
    }
    if (outcome === "deadline_exceeded") {
      this.recordExecution("deadline_exceeded");
      return "deadline_exceeded";
    }
    if (outcome === "attempt_timeout") {
      this.recordExecution("timeout");
      return "timeout_exceeded";
    }
    this.recordExecution("lease_lost");
    return "stale";
  }

  /** True when this attempt asked PostgreSQL to expire its ownership. */
  get expirationRequested(): boolean {
    return this.expirationPromise !== undefined;
  }

  /**
   * Waits for the answer of the expiry request in flight, if this attempt asked PostgreSQL for one.
   *
   * The handler has ended, so settlement reads only that answer. A `not_due` answer ends the retry
   * loop, and the worker then settles the handler's error through `fail_v1`. If a heartbeat already
   * reported the expiry, the loop continues until PostgreSQL settles it. Settlement waits for the
   * answer for at most {@link SHARED_EXPIRATION_BUDGET_MS}, so a connection that stops answering
   * cannot hold the worker slot. A failed request or the end of that wait proves nothing about the
   * expiry. Then settlement logs `workhorse.worker.expiration_request_failed` and continues with an
   * empty arbiter. The fenced `fail_v1`, and `reconcileStale` after a `stale` answer, check each
   * boundary again in PostgreSQL.
   */
  async settleExpiration(): Promise<void> {
    this.settling = true;
    this.wakeExpirationRetry?.();
    const pending = this.expirationPromise;
    if (pending === undefined) return;
    let cancel: (() => void) | undefined;
    const timeout = new Promise<{ errorType: string }>((resolve) => {
      const timer = setTimeout(resolve, SHARED_EXPIRATION_BUDGET_MS, { errorType: "timeout" });
      cancel = () => clearTimeout(timer);
    });
    try {
      // The handlers on pending also consume a rejection that arrives after the budget.
      const failure = await Promise.race([
        pending.then(
          () => undefined,
          (error: unknown) => ({
            errorType: error instanceof Error ? error.name : typeof error,
          }),
        ),
        timeout,
      ]);
      if (failure === undefined) return;
      logWarn(
        "workhorse.worker.expiration_request_failed",
        "Worker settles a task without the answer of its expiry request",
        {
          ...taskSpanAttributes(this.task),
          "workhorse.queue.name": this.task.queue,
          "workhorse.worker.id": this.services.workerId,
          "error.type": failure.errorType,
        },
      );
    } finally {
      cancel?.();
    }
  }

  /** Records the activation's outcome once; later calls keep the first. */
  recordExecution(outcome: TaskExecutionOutcome): void {
    if (this.activation.outcome !== "unknown") return;
    this.activation.outcome = outcome;
    recordHandlerExecution(this.task.queue, this.task.type, outcome);
    logInfo("workhorse.task.execution_finished", "Task execution finished", {
      ...taskSpanAttributes(this.task),
      "workhorse.queue.name": this.task.queue,
      "workhorse.worker.id": this.services.workerId,
      "workhorse.handler.outcome": outcome,
    });
  }

  recordFailure(state: Exclude<FailureStatus, "cancel_requested" | "stale">): void {
    if (state === "ready" || state === "scheduled") {
      if (this.arbiter.submit("failed")) this.recordExecution("retry");
    } else if (state === "failed") {
      if (this.arbiter.submit("failed")) this.recordExecution("failed");
    } else if (state === "deadline_exceeded") {
      if (this.arbiter.submit("deadline_exceeded")) this.recordExecution("deadline_exceeded");
    } else if (state === "timeout_exceeded") {
      if (this.arbiter.submit("attempt_timeout")) this.recordExecution("timeout");
    }
  }

  /**
   * Records the verdict of a fenced release: a claim handed back with its attempt intact.
   *
   * A refused release names the boundary PostgreSQL settled instead, so this reads the same
   * vocabulary {@link recordFailure} does and the attempt still ends with one truthful outcome.
   */
  recordRelease(status: Exclude<ReleaseOwnedStatus, "cancel_requested" | "stale">): void {
    if (status === "released") {
      if (this.arbiter.submit("released")) this.recordExecution("released");
    } else if (status === "deadline_exceeded") {
      if (this.arbiter.submit("deadline_exceeded")) this.recordExecution("deadline_exceeded");
    } else if (status === "timeout_exceeded") {
      if (this.arbiter.submit("attempt_timeout")) this.recordExecution("timeout");
    } else {
      // A boundary the database already passed cannot come back, so it never answers not_due to a
      // release. That answer means this worker no longer owns what it is handing back.
      if (this.arbiter.submit("lease_expired")) this.recordExecution("lease_lost");
    }
  }

  private stopHeartbeat(): void {
    this.heartbeatStopped = true;
    this.removeHeartbeatLease?.();
    this.removeHeartbeatLease = undefined;
  }

  private abort(reason: Error): void {
    if (!this.controller.signal.aborted) this.controller.abort(reason);
  }

  private expireOwnership(): Promise<ExpireOwnedStatus> {
    this.expirationPromise ??= this.requestExpiration().then((status) => {
      if (status === "cancel_requested") this.markCancellationRequested();
      else if (status === "deadline_exceeded") this.arbiter.submit("deadline_exceeded");
      else if (status === "timeout_exceeded") this.arbiter.submit("attempt_timeout");
      else if (status === "stale") this.arbiter.submit("lease_expired");
      return status;
    });
    return this.expirationPromise;
  }

  /**
   * Asks PostgreSQL to expire ownership until it agrees that the expiry has arrived.
   *
   * "not_due" is the database refusing the transition because its clock has not reached the stored
   * expiry. The attempt still owns the task then, so the handler keeps running and the question is
   * asked again. The wait runs to the database-relative due time, and at least a short backoff. A
   * truncated timestamp can make the local timer lead by a fraction of a millisecond. Once another
   * outcome wins, or the attempt stops or settles before any heartbeat reported the expiry, asking
   * stops and the answer stays "not_due". Settlement also ends the wait before the next request.
   */
  private async requestExpiration(): Promise<ExpireOwnedStatus> {
    let retryMs = EXPIRATION_RETRY_MIN_MS;
    for (;;) {
      const status = await this.services.expireOwned(this.task, this.services.workerId);
      if (status !== "not_due" || this.finished()) return status;
      const waitMs = Math.max(retryMs, (this.expirationDueAt ?? 0) - monotonicNow());
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, waitMs);
        this.wakeExpirationRetry = () => {
          clearTimeout(timer);
          resolve();
        };
      });
      this.wakeExpirationRetry = undefined;
      if (this.finished()) return status;
      retryMs = Math.min(retryMs * 2, EXPIRATION_RETRY_MAX_MS);
    }
  }

  private finished(): boolean {
    return (
      this.arbiter.outcome !== undefined ||
      ((this.heartbeatStopped || this.settling) && !this.expiryReported)
    );
  }

  private armExpirationTimer(atMs: number, retryMs: number): void {
    this.cancelExpirationTimer = setUnrefTimeoutAt(atMs, () => {
      this.cancelExpirationTimer = undefined;
      this.expireOnConfirmation(retryMs);
    });
  }

  // The local expiry has arrived. The handler keeps running until PostgreSQL confirms it.
  private expireOnConfirmation(retryMs: number): void {
    this.expireOwnership().then(
      (status) => {
        if (status === "deadline_exceeded") {
          this.stop();
          this.abort(new DeadlineExceededError(this.task.id));
        } else if (status === "timeout_exceeded") {
          this.stop();
          this.abort(new ExecutionTimeoutError(this.task.id, this.task.attempt));
        } else if (status === "stale") {
          this.stop();
          this.abort(new Error("Task lease was lost"));
        }
        // markCancellationRequested already ended a cancel_requested attempt. A not_due answer
        // means another outcome won while PostgreSQL was being asked.
      },
      () => {
        // A failed request proves nothing about the expiry, so the handler keeps running and the
        // question is asked again. The lease watchdog still ends an attempt PostgreSQL cannot renew.
        if (this.finished()) return;
        this.expirationPromise = undefined;
        this.armExpirationTimer(
          monotonicNow() + retryMs,
          Math.min(retryMs * 2, EXPIRATION_RETRY_MAX_MS),
        );
      },
    );
  }

  private expireOwnershipInBackground(): void {
    // Observe the memoized promise without replacing it. Settlement still reads the original
    // rejection and logs it, and a handler that ignores abort cannot cause an unhandled rejection.
    void this.expireOwnership().catch((error: unknown) => this.controller.abort(error));
  }

  private renewLease(sentAt: number): void {
    if (this.heartbeatStopped) return;
    // A window that has already ended stays ended, even if its watchdog timer has not fired yet.
    // A late accepted answer never reopens it.
    if (this.leaseWindowEndsAt !== undefined && monotonicNow() >= this.leaseWindowEndsAt) {
      this.endLeaseWindow();
      return;
    }
    this.cancelLeaseWatchdog?.();
    this.cancelLeaseWatchdog = undefined;
    this.leaseWindowEndsAt = sentAt + this.services.leaseMs;
    // An answer that arrives a full lease after its request left opens no window at all.
    if (monotonicNow() >= this.leaseWindowEndsAt) {
      this.endLeaseWindow();
      return;
    }
    this.cancelLeaseWatchdog = setUnrefTimeoutAt(this.leaseWindowEndsAt, () =>
      this.endLeaseWindow(),
    );
  }

  private endLeaseWindow(): void {
    this.cancelLeaseWatchdog = undefined;
    this.arbiter.submit("lease_expired");
    this.stop();
    this.abort(new Error("No heartbeat was accepted within the task lease"));
  }

  private refreshOwnership(status: HeartbeatBatchStatus, sentAt: number): void {
    // A busy lease got no renewal and no ownership verdict, so the watchdog keeps its window.
    if (status === "busy") return;
    if (status === "accepted") {
      this.renewLease(sentAt);
    } else if (status === "cancel_requested") {
      this.markCancellationRequested();
    } else if (status === "deadline_exceeded") {
      this.expiryReported = true;
      this.stop();
      this.expireOwnershipInBackground();
      this.abort(new DeadlineExceededError(this.task.id));
    } else if (status === "timeout_exceeded") {
      this.expiryReported = true;
      this.stop();
      this.expireOwnershipInBackground();
      this.abort(new ExecutionTimeoutError(this.task.id, this.task.attempt));
    } else if (status === "stale") {
      const expiration = this.expirationPromise;
      if (expiration === undefined) {
        this.loseLease();
        return;
      }
      // expire_owned_v1 is in flight, and its own commit can be what this heartbeat found missing.
      // Its answer names the outcome, so the lease is reported lost only if that answer does not.
      // The lease watchdog keeps running and still ends the attempt if the answer never comes.
      this.stopHeartbeat();
      void expiration.then(
        () => this.loseLease(),
        () => this.loseLease(),
      );
    }
  }

  private loseLease(): void {
    this.arbiter.submit("lease_expired");
    this.stop();
    this.abort(new Error("Task lease was lost"));
  }
}
