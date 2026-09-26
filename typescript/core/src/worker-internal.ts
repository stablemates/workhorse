import type {
  ClaimedTask,
  CompletionClaim,
  CompletionClaimResult,
  HeartbeatStatus,
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
 * Returns a heartbeat channel on one reserved pooled connection, or undefined when the database
 * cannot lend one. The worker then heartbeats through the shared pool.
 */
export const workerHeartbeatReservation = Symbol("workhorse.worker.heartbeat-reservation");

export interface WorkerHeartbeatChannel {
  /** Take the connection now, ahead of any handler that could exhaust the pool. */
  reserve(): void;
  heartbeatMany(
    tasks: readonly ClaimedTask[],
    workerId: string,
    leaseMs: number,
    timeoutMs: number,
  ): Promise<Map<string, HeartbeatStatus>>;
  close(): Promise<void>;
}

export interface WorkerHeartbeatReservation {
  [workerHeartbeatReservation](): WorkerHeartbeatChannel | undefined;
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
