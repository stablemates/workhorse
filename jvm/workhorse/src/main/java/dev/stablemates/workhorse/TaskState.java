package dev.stablemates.workhorse;

/** PostgreSQL's durable lifecycle state for a task. */
public enum TaskState {
  /** The task waits for a prerequisite task. */
  BLOCKED,
  /** The task waits for its run time. */
  SCHEDULED,
  /** The task can be claimed. */
  READY,
  /** A worker holds the task. */
  ACTIVE,
  /** The task succeeded. */
  SUCCEEDED,
  /** The task failed. */
  FAILED,
  /** The task was canceled. */
  CANCELED
}
