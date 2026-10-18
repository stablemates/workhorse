package run.workhorse;

import java.time.Instant;
import java.util.UUID;
import org.jspecify.annotations.Nullable;

/**
 * The result of a redrive for one source task.
 *
 * @param status what the redrive did
 * @param sourceTaskId the failed task
 * @param targetTaskId the fresh copy, or {@code null} when the redrive enqueued none
 * @param sourceState the state of the source task, or {@code null} when it does not exist
 * @param targetState the state of the copy, or {@code null}
 * @param requestedAt when the redrive was first requested, or {@code null}
 */
public record RedriveResult(
    RedriveStatus status,
    UUID sourceTaskId,
    @Nullable UUID targetTaskId,
    @Nullable TaskState sourceState,
    @Nullable TaskState targetState,
    @Nullable Instant requestedAt) {}
