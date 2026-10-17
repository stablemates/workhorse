package dev.stablemates.workhorse;

import java.time.Instant;
import java.util.UUID;
import org.jspecify.annotations.Nullable;

/**
 * PostgreSQL's disposition for a human wait completion.
 *
 * @param status the disposition
 * @param taskId the task
 * @param name the wait name
 * @param payload the recorded decision, or {@code null}
 * @param completedAt when the wait was completed, or {@code null}
 * @param completedBy who completed it, or {@code null}
 */
public record HumanWaitCompletionResult(
    HumanWaitStatus status,
    UUID taskId,
    String name,
    @Nullable Object payload,
    @Nullable Instant completedAt,
    @Nullable String completedBy) {}
