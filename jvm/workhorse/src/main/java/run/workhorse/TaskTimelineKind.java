package run.workhorse;

/** The kind of a timeline entry. */
public enum TaskTimelineKind {
  /** A {@link TaskTimelineEvent}. */
  EVENT,
  /** A {@link TaskTimelineAttempt}. */
  ATTEMPT
}
