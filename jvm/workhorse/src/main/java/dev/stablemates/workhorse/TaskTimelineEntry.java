package dev.stablemates.workhorse;

import java.time.Instant;
import java.util.UUID;
import org.jspecify.annotations.Nullable;

/** One entry of a task timeline: an event or an attempt. */
public sealed interface TaskTimelineEntry permits TaskTimelineEvent, TaskTimelineAttempt {
  /** The kind of the entry. */
  TaskTimelineKind kind();

  /** The record of the entry. */
  UUID recordId();

  /** The priority of the task when the entry occurred. */
  int priority();

  /** The attempt of the entry, or {@code null} for an event outside an attempt. */
  @Nullable Integer attempt();

  /** When the entry occurred. */
  Instant occurredAt();
}
