package dev.stablemates.workhorse;

/** Why a task is in the blocked state. */
public enum TaskBlockedReason {
  /** A prerequisite task is not finished. */
  PREREQUISITE_PENDING
}
