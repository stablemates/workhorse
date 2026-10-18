package dev.stablemates.workhorse;

/** The type of a task group event. */
public enum TaskGroupEventType {
  /** The group was created. */
  CREATED,
  /** The group was sealed. */
  SEALED,
  /** An operator canceled the group. */
  CANCELED,
  /** The group finished. */
  FINISHED,
  /** The group enqueued a callback task. */
  CALLBACK_ENQUEUED,
  /** The group could not enqueue a callback task. */
  CALLBACK_FAILED,
  /** A drift repair recounted or finished the group. */
  COUNTER_REPAIRED
}
