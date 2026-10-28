import type {
  ClaimedTask,
  CompletionClaim,
  CompletionClaimResult,
  HeartbeatBatchStatus,
  Json,
} from "./types.js";

/** Package-internal Queue capabilities used to build one handler activation snapshot. */
export const workerCheckpointsRead = Symbol("workhorse.worker.checkpoints-read");
export const workerProgressRead = Symbol("workhorse.worker.progress-read");
export const workerWaitsRead = Symbol("workhorse.worker.waits-read");

/**
 * Validates a handler result and returns the fenced write that completes the task. The worker
 * charges a validation error to the handler and treats a write error as a settlement failure. With
 * a claim, the write is the fast tier's fused completion and also returns the tasks it claimed.
 */
export const workerCompletionPrepare = Symbol("workhorse.worker.completion-prepare");

export interface WorkerCompletionPreparation {
  [workerCompletionPrepare](
    task: ClaimedTask,
    workerId: string,
    result: Json,
  ): Promise<(claim?: CompletionClaim) => Promise<CompletionClaimResult>>;
}

/**
 * Set by the worker on the `CompletionClaim` of a fused completion. The statement that claims for
 * it runs inside this function, so the worker warns once when that statement waits longer than its
 * stop budget.
 */
export const workerStatementWatch = Symbol("workhorse.worker.statement-watch");

export type WorkerStatementWatch = <T>(statement: () => Promise<T>) => Promise<T>;

export interface WatchedCompletionClaim extends CompletionClaim {
  [workerStatementWatch]?: WorkerStatementWatch;
}

/**
 * Returns a heartbeat channel on one reserved pooled connection, or undefined when the database
 * cannot lend one. The worker then heartbeats through the shared pool.
 */
export const workerHeartbeatReservation = Symbol("workhorse.worker.heartbeat-reservation");

/** Why a startup readiness check failed. A schema verdict throws instead. */
export type WorkerReadinessFailure =
  | { step: "heartbeat" | "ordinary"; reason: "timeout" | "error"; cause?: unknown }
  | { step: "stopped" };

export interface WorkerHeartbeatChannel {
  /** Take the connection now, ahead of any handler that could exhaust the pool. */
  reserve(): void;
  /** Whether claims may take leases that this channel renews (ADR 0071 rule 6). */
  usable(): boolean;
  /** Call `listener` each time the channel becomes usable after a loss. */
  onReady(listener: () => void): () => void;
  /**
   * The startup readiness check of ADR 0071 rule 3, within `timeoutMs`: wait for the reserved
   * connection, then borrow one ordinary connection, run the compatibility query on it, and
   * return it at once. Resolves undefined when both steps pass.
   */
  checkReadiness(
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<WorkerReadinessFailure | undefined>;
  /** Wait up to `timeoutMs` for the channel to become usable. */
  ready(timeoutMs: number, signal?: AbortSignal): Promise<boolean>;
  /** A short description of the pool, as a refusal names it. */
  readonly pool: string;
  heartbeatMany(
    tasks: readonly ClaimedTask[],
    workerId: string,
    leaseMs: number,
    timeoutMs: number,
  ): Promise<Map<string, HeartbeatBatchStatus>>;
  close(): Promise<void>;
}

export interface WorkerHeartbeatReservation {
  [workerHeartbeatReservation](heartbeatMs: number): WorkerHeartbeatChannel | undefined;
  [workerHeartbeatReservationProblem](): string | undefined;
}

/** Explains why the queue cannot lend a heartbeat connection, or returns undefined when it can. */
export const workerHeartbeatReservationProblem = Symbol(
  "workhorse.worker.heartbeat-reservation-problem",
);

/**
 * Returns the size of the pool that runs the queue's statements, or undefined when it is unknown.
 * The worker caps its default cohorts to the connections that pool has left for them.
 */
export const workerStatementPoolCapacity = Symbol("workhorse.worker.statement-pool-capacity");

/**
 * Returns the maximum size of the pool that the queue's listener takes its connection from, or
 * undefined when the pool reports none. The polling-only warning names it.
 */
export const workerListenerPoolMaxSize = Symbol("workhorse.worker.listener-pool-max-size");

/**
 * Reads whether a queue is fast-tier now. A queue without a control row is full-tier. The worker
 * reads it for tasks that claim_many_v1 returned, which carry no tier marker (ADR 0077).
 */
export const workerQueueTierRead = Symbol("workhorse.worker.queue-tier-read");

export interface WorkerQueueTierRead {
  [workerQueueTierRead](queueName: string): Promise<boolean>;
}

/**
 * Runs the cached compatibility check of the queue. `runOnce()` and a `run()` without a reserved
 * heartbeat connection call it before the worker registers. The readiness check of a reserved
 * connection stores its answer in the same cache.
 */
export const workerSchemaCheck = Symbol("workhorse.worker.schema-check");

export interface WorkerSchemaCheck {
  [workerSchemaCheck](): Promise<void>;
}
