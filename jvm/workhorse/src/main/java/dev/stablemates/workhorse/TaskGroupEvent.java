package dev.stablemates.workhorse;

import java.time.Instant;
import java.util.UUID;
import org.jspecify.annotations.Nullable;

/**
 * One event of the history of a task group.
 *
 * @param id the event
 * @param type the event type
 * @param details the event details as the core's JSON tree, or {@code null}
 * @param occurredAt when the event occurred
 */
public record TaskGroupEvent(
    UUID id, TaskGroupEventType type, @Nullable Object details, Instant occurredAt) {}
