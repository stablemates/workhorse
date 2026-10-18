package dev.stablemates.workhorse;

/** What a dependent task does when one of its prerequisite tasks ends. */
public enum DependencyPolicy {
  /** The dependent task can run. */
  RELEASE,
  /** The dependent task is canceled. */
  CANCEL,
  /** The dependent task fails. */
  FAIL
}
