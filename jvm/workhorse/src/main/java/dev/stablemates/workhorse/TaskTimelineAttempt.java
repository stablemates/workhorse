package dev.stablemates.workhorse;

import java.time.Instant;
import java.util.UUID;
import org.jspecify.annotations.Nullable;

/**
 * A finished attempt of a timeline.
 *
 * @param recordId the attempt record
 * @param priority the priority of the task when the attempt finished
 * @param attempt the attempt number
 * @param occurredAt when the attempt finished
 * @param fenceToken the fence token of the attempt
 * @param workerId the worker that ran the attempt
 * @param outcome PostgreSQL's outcome of the attempt, such as {@code "succeeded"} or {@code
 *     "retry"}
 * @param startedAt when the attempt started
 * @param claimedAt when the worker claimed the task
 * @param finishedAt when the attempt finished
 * @param error the error of the attempt as the core's JSON tree, or {@code null}
 */
public record TaskTimelineAttempt(
    UUID recordId,
    int priority,
    @Nullable Integer attempt,
    Instant occurredAt,
    long fenceToken,
    String workerId,
    String outcome,
    Instant startedAt,
    Instant claimedAt,
    Instant finishedAt,
    @Nullable Object error)
    implements TaskTimelineEntry {
  @Override
  public TaskTimelineKind kind() {
    return TaskTimelineKind.ATTEMPT;
  }
}
