import {
  CancellationRequestedError,
  DeadlineExceededError,
  ExecutionTimeoutError,
} from "./errors.js";
import type { FailureStatus } from "./queue/claim-lease-fence.js";
import {
  logInfo,
  recordHandlerExecution,
  taskSpanAttributes,
  type TaskExecutionOutcome,
} from "./telemetry.js";
import { monotonicNow, setUnrefTimeoutAt } from "./timers.js";
import type {
  ClaimedTask,
  ExpireOwnedStatus,
  HeartbeatStatus,
  ReleaseOwnedStatus,
} from "./types.js";

const DURABLE_WAIT_SUSPENSION = Symbol("workhorse.durableWaitSuspension");
const CHILD_TASK_SUSPENSION = Symbol("workhorse.childTaskSuspension");
// Bounds on the wait before asking PostgreSQL again whether a local expiry has arrived.
const EXPIRATION_RETRY_MIN_MS = 5;
const EXPIRATION_RETRY_MAX_MS = 1_000;

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
   * from `monotonicNow()`.
   */
  addHeartbeatLease(
    task: ClaimedTask,
    status: (status: HeartbeatStatus, sentAt: number) => void,
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
  private removeHeartbeatLease: (() => void) | undefined;

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
    this.removeHeartbeatLease = services.addHeartbeatLease(task, (status, sentAt) =>
      this.refreshOwnership(status, sentAt),
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

  /** Suspend on a durable wait or child, even if another outcome already won. */
  suspend(outcome: "suspended_for_wait" | "suspended_for_child"): never {
    const reason =
      outcome === "suspended_for_wait" ? DURABLE_WAIT_SUSPENSION : CHILD_TASK_SUSPENSION;
    if (this.arbiter.submit(outcome)) this.controller.abort(reason);
    throw reason;
  }

  /** Suspend on a scheduled sleep only when no other outcome has won yet. */
  suspendForScheduledWait(): void {
    if (!this.arbiter.submit("suspended_for_wait")) return;
    this.controller.abort(DURABLE_WAIT_SUSPENSION);
    throw DURABLE_WAIT_SUSPENSION;
  }

  /** Stop renewing the lease and cancel the local expiration timer. */
  stop(): void {
    this.heartbeatStopped = true;
    this.removeHeartbeatLease?.();
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

  /** Waits for the answer to an expiry this attempt asked PostgreSQL for, if it asked. */
  async settleExpiration(): Promise<void> {
    await this.expirationPromise;
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

  recordFailure(state: Exclude<FailureStatus, "cancel_requested">): void {
    if (state === "ready" || state === "scheduled") {
      if (this.arbiter.submit("failed")) this.recordExecution("retry");
    } else if (state === "failed") {
      if (this.arbiter.submit("failed")) this.recordExecution("failed");
    } else if (state === "deadline_exceeded") {
      if (this.arbiter.submit("deadline_exceeded")) this.recordExecution("deadline_exceeded");
    } else if (state === "timeout_exceeded") {
      if (this.arbiter.submit("attempt_timeout")) this.recordExecution("timeout");
    } else if (state === "stale") {
      if (this.arbiter.submit("lease_expired")) this.recordExecution("lease_lost");
    }
  }

  /**
   * Records the verdict of a fenced release: a claim handed back with its attempt intact.
   *
   * A refused release names the boundary PostgreSQL settled instead, so this reads the same
   * vocabulary {@link recordFailure} does and the attempt still ends with one truthful outcome.
   */
  recordRelease(status: Exclude<ReleaseOwnedStatus, "cancel_requested">): void {
    if (status === "released") {
      if (this.arbiter.submit("released")) this.recordExecution("released");
    } else if (status === "deadline_exceeded") {
      if (this.arbiter.submit("deadline_exceeded")) this.recordExecution("deadline_exceeded");
    } else if (status === "timeout_exceeded") {
      if (this.arbiter.submit("attempt_timeout")) this.recordExecution("timeout");
    } else {
      // A boundary the database already passed cannot come back, so it never answers not_due to a
      // release. Both remaining answers mean this worker no longer owns what it is handing back.
      if (this.arbiter.submit("lease_expired")) this.recordExecution("lease_lost");
    }
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
   * outcome wins, or the attempt stops before any heartbeat reported the expiry, asking stops and
   * the answer stays "not_due".
   */
  private async requestExpiration(): Promise<ExpireOwnedStatus> {
    let retryMs = EXPIRATION_RETRY_MIN_MS;
    for (;;) {
      const status = await this.services.expireOwned(this.task, this.services.workerId);
      if (status !== "not_due" || this.finished()) return status;
      const waitMs = Math.max(retryMs, (this.expirationDueAt ?? 0) - monotonicNow());
      await new Promise<void>((resolve) => {
        setTimeout(resolve, waitMs);
      });
      if (this.finished()) return status;
      retryMs = Math.min(retryMs * 2, EXPIRATION_RETRY_MAX_MS);
    }
  }

  private finished(): boolean {
    return this.arbiter.outcome !== undefined || (this.heartbeatStopped && !this.expiryReported);
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
    // Observe the memoized promise without replacing it: the settlement path still awaits the
    // original rejection, while a handler that ignores abort cannot cause an unhandled rejection.
    void this.expireOwnership().catch((error: unknown) => this.controller.abort(error));
  }

  private renewLease(sentAt: number): void {
    if (this.heartbeatStopped) return;
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

  private refreshOwnership(status: HeartbeatStatus, sentAt: number): void {
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
      this.arbiter.submit("lease_expired");
      this.stop();
      this.abort(new Error("Task lease was lost"));
    }
  }
}
