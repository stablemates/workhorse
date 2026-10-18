package run.workhorse;

/** The result of a finished task group. */
public enum TaskGroupResult {
  /** Every member task succeeded. */
  SUCCEEDED,
  /** A member task failed or was canceled. */
  FAILED
}
