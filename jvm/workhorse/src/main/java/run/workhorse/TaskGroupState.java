package run.workhorse;

/** The state of a task group (ADR 0095). */
public enum TaskGroupState {
  /** The group accepts tasks. */
  OPEN,
  /** The group accepts tasks only from a running member task. */
  SEALED,
  /** Every member task is finished. */
  FINISHED
}
