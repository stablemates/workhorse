import { setTimeout as sleep } from "node:timers/promises";
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
import { setUnrefTimeoutAt } from "./timers.js";
import type { ClaimedTask, ExpireOwnedStatus, HeartbeatStatus } from "./types.js";

const DURABLE_WAIT_SUSPENSION = Symbol("workhorse.durableWaitSuspension");
const CHILD_TASK_SUSPENSION = Symbol("workhorse.childTaskSuspension");

type AttemptOutcome =
  | "completed"
  | "failed"
  | "cancelled"
  | "deadline_exceeded"
  | "attempt_timeout"
  | "lease_expired"
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
  acknowledgeCancel(task: ClaimedTask, workerId: string): Promise<boolean>;
  expireOwned(task: ClaimedTask, workerId: string): Promise<ExpireOwnedStatus>;
  addHeartbeatLease(
    task: ClaimedTask,
    status: (status: HeartbeatStatus) => void,
    error: (error: unknown) => void,
  ): () => void;
}

/**
 * One claimed task's ownership for the duration of a handler activation.
 *
 * The attempt owns the abort signal the handler sees, and the arbiter that decides which outcome
 * wins when cancellation, expiry, lease loss, suspension, and completion race. It keeps the lease
 * alive through the worker's heartbeat batch and fires the deadline or attempt timeout locally.
 * Construction starts both; `stop()` ends both.
 */
export class TaskAttempt {
  readonly arbiter = new AttemptOutcomeArbiter();
  private readonly controller = new AbortController();
  private cancelExpirationTimer: (() => void) | undefined;
  private expirationPromise: Promise<ExpireOwnedStatus> | undefined;
  private heartbeatStopped = false;
  private removeHeartbeatLease: (() => void) | undefined;

  constructor(
    readonly task: ClaimedTask,
    private readonly services: TaskAttemptServices,
    private readonly activation: { outcome: TaskExecutionOutcome },
  ) {
    const expirationAt = [task.deadlineAt, task.attemptTimeoutAt].reduce<Date | null>(
      (earliest, candidate) =>
        candidate !== null && (earliest === null || candidate < earliest) ? candidate : earliest,
      null,
    );
    if (expirationAt) {
      this.cancelExpirationTimer = setUnrefTimeoutAt(
        // The extra millisecond keeps the timer from leading the database clock: expirationAt was
        // truncated to milliseconds on the way to the client, so firing at it exactly can precede
        // the stored microsecond value and earn a not_due answer from expiration.
        expirationAt.getTime() + 1,
        () => {
          this.cancelExpirationTimer = undefined;
          const isDeadline =
            task.deadlineAt !== null &&
            (task.attemptTimeoutAt === null || task.deadlineAt <= task.attemptTimeoutAt);
          if (isDeadline) {
            this.abort(new DeadlineExceededError(task.id));
          } else {
            this.abort(new ExecutionTimeoutError(task.id, task.attempt));
          }
          this.stop();
          this.expireOwnershipInBackground();
        },
      );
    }
    this.removeHeartbeatLease = services.addHeartbeatLease(
      task,
      (status) => this.refreshOwnership(status),
      (error) => {
        if (this.heartbeatStopped) return;
        this.stop();
        this.controller.abort(error);
      },
    );
  }

  /** The signal handed to the handler; it aborts when this attempt loses its task. */
  get signal(): AbortSignal {
    return this.controller.signal;
  }

  /** Every durable side effect first confirms that this attempt still owns the task. */
  requireLease(): void {
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
   * Waits for PostgreSQL to accept the local expiry.
   *
   * "not_due" is the database refusing the transition: its clock has not reached the stored
   * expiry the local timer fired for. Timestamps round-trip to the client at millisecond
   * precision while PostgreSQL stores microseconds, so the timer can lead by a fraction.
   * Ask again until the database agrees — returning on not_due would abandon an attempt the
   * handler already gave up, leaving it active under a live lease until lease recovery.
   */
  async settleExpiration(): Promise<void> {
    let expirationStatus = await this.expirationPromise;
    const expirationRetryBudgetAt = Date.now() + 1_000;
    while (expirationStatus === "not_due" && Date.now() < expirationRetryBudgetAt) {
      await sleep(5);
      this.expirationPromise = undefined;
      expirationStatus = await this.expireOwnership();
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

  private abort(reason: Error): void {
    if (!this.controller.signal.aborted) this.controller.abort(reason);
  }

  private expireOwnership(): Promise<ExpireOwnedStatus> {
    this.expirationPromise ??= this.services
      .expireOwned(this.task, this.services.workerId)
      .then((status) => {
        if (status === "cancel_requested") this.markCancellationRequested();
        else if (status === "deadline_exceeded") this.arbiter.submit("deadline_exceeded");
        else if (status === "timeout_exceeded") this.arbiter.submit("attempt_timeout");
        else if (status === "stale") this.arbiter.submit("lease_expired");
        return status;
      });
    return this.expirationPromise;
  }

  private expireOwnershipInBackground(): void {
    // Observe the memoized promise without replacing it: the settlement path still awaits the
    // original rejection, while a handler that ignores abort cannot cause an unhandled rejection.
    void this.expireOwnership().catch((error: unknown) => this.controller.abort(error));
  }

  private refreshOwnership(status: HeartbeatStatus): void {
    if (status === "cancel_requested") {
      this.markCancellationRequested();
    } else if (status === "deadline_exceeded") {
      this.stop();
      this.expireOwnershipInBackground();
      this.abort(new DeadlineExceededError(this.task.id));
    } else if (status === "timeout_exceeded") {
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
