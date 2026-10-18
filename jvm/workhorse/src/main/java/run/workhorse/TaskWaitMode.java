package run.workhorse;

/** How a durable wait sets its wake time. */
public enum TaskWaitMode {
  /** The wait sleeps for a duration. */
  RELATIVE,
  /** The wait sleeps until a time. */
  ABSOLUTE
}
