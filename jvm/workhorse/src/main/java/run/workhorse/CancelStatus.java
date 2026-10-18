package run.workhorse;

/** PostgreSQL's disposition for a cancellation request. */
public enum CancelStatus {
  /** The task was canceled. */
  CANCELED,
  /** The active task stops at its next PostgreSQL-owned checkpoint. */
  CANCEL_REQUESTED,
  /** The task had already finished. */
  ALREADY_TERMINAL,
  /** No such task exists. */
  NOT_FOUND
}
