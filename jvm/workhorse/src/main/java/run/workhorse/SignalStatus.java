package run.workhorse;

/** PostgreSQL's disposition for a signal. */
public enum SignalStatus {
  /** The signal reached the waiting task. */
  DELIVERED,
  /** The idempotency key replayed a delivered signal. */
  DUPLICATE,
  /** The task does not wait for the signal. */
  NOT_WAITING,
  /** Another signal already completed the wait. */
  ALREADY_DELIVERED,
  /** The wait belongs to an earlier attempt. */
  STALE,
  /** No such task exists. */
  NOT_FOUND
}
