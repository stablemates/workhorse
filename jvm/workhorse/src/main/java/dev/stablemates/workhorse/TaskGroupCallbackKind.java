package dev.stablemates.workhorse;

/** A callback of a task group, in the order a group enqueues them. */
public enum TaskGroupCallbackKind {
  /** Enqueued when the group finishes. */
  ON_FINISH,
  /** Enqueued when the group succeeds. */
  ON_SUCCESS,
  /** Enqueued when the group fails. */
  ON_FAILURE
}
