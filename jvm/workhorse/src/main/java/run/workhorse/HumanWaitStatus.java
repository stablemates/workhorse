package run.workhorse;

/** PostgreSQL's disposition for a human wait completion. */
public enum HumanWaitStatus {
  /** The decision reached the waiting task. */
  COMPLETED,
  /** The idempotency key replayed a recorded decision. */
  DUPLICATE,
  /** The task does not wait for the decision. */
  NOT_WAITING,
  /** Another decision already completed the wait. */
  ALREADY_COMPLETED,
  /** The wait belongs to an earlier attempt. */
  STALE,
  /** No such task exists. */
  NOT_FOUND
}
