package dev.stablemates.workhorse;

/** The outcome a task group counted for one member task. */
public enum TaskGroupMemberOutcome {
  /** The member task succeeded. */
  SUCCEEDED,
  /** The member task failed. */
  FAILED,
  /** The member task was canceled. */
  CANCELED
}
