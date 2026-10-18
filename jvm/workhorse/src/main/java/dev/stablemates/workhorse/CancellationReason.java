package dev.stablemates.workhorse;

/** Why a task's cancellation token was cancelled. */
public enum CancellationReason {
  /** An operator or a caller requested cancellation. */
  REQUESTED,
  /** The task passed its absolute deadline. */
  DEADLINE_EXCEEDED,
  /** The attempt passed its execution timeout. */
  EXECUTION_TIMEOUT,
  /** Another attempt owns the task now. */
  LEASE_LOST,
  /** The handler suspended on a durable wait or a child join. */
  SUSPENDED,
  /** The worker is shutting down. */
  SHUTDOWN
}
