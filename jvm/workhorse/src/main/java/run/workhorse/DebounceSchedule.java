package run.workhorse;

/** How a debounce replacement moves the run time of the keyed task. */
public enum DebounceSchedule {
  /** The window starts again at each replacement. */
  RESET,
  /** The first run time stays. */
  PRESERVE
}
