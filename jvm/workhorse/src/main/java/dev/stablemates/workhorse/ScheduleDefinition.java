package dev.stablemates.workhorse;

/**
 * One named schedule.
 *
 * @param name the schedule name
 * @param schedule a cron expression or an interval that PostgreSQL accepts
 * @param task the task each occurrence enqueues
 * @param timezone the time zone of the cron expression, {@code "UTC"} by default
 * @param catchupPolicy what the schedule does with missed occurrences, {@link CatchupPolicy#SKIP}
 *     by default
 * @param enabled whether the schedule fires, {@code true} by default
 */
public record ScheduleDefinition(
    String name,
    String schedule,
    ScheduledTask task,
    String timezone,
    CatchupPolicy catchupPolicy,
    boolean enabled) {
  /** An enabled schedule in UTC that skips missed occurrences. */
  public ScheduleDefinition(String name, String schedule, ScheduledTask task) {
    this(name, schedule, task, "UTC", CatchupPolicy.SKIP, true);
  }
}
