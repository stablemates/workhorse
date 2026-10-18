package run.workhorse;

import java.time.Instant;
import java.util.UUID;
import org.jspecify.annotations.Nullable;

/**
 * PostgreSQL's answer to a cancellation request.
 *
 * @param status the disposition
 * @param taskId the task
 * @param state the task's state, or {@code null} when it was not found
 * @param currentAttempt the current attempt, or {@code null}
 * @param requestedAt when cancellation was first requested, or {@code null}
 * @param requestedBy who requested cancellation, or {@code null}
 * @param reason the recorded reason, or {@code null}
 * @param finishedAt when the task finished, or {@code null}
 */
public record CancelResult(
    CancelStatus status,
    UUID taskId,
    @Nullable TaskState state,
    @Nullable Integer currentAttempt,
    @Nullable Instant requestedAt,
    @Nullable String requestedBy,
    @Nullable String reason,
    @Nullable Instant finishedAt) {}
