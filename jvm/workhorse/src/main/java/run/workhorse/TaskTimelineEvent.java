package run.workhorse;

import java.time.Instant;
import java.util.UUID;
import org.jspecify.annotations.Nullable;

/**
 * A task event of a timeline.
 *
 * @param recordId the event record
 * @param priority the priority of the task when the event occurred
 * @param attempt the attempt of the event, or {@code null}
 * @param occurredAt when the event occurred
 * @param eventType the event type
 * @param details the event details as the core's JSON tree, or {@code null}
 */
public record TaskTimelineEvent(
    UUID recordId,
    int priority,
    @Nullable Integer attempt,
    Instant occurredAt,
    String eventType,
    @Nullable Object details)
    implements TaskTimelineEntry {
  @Override
  public TaskTimelineKind kind() {
    return TaskTimelineKind.EVENT;
  }
}
