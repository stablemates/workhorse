package run.workhorse;

import java.time.Instant;
import java.util.UUID;
import org.jspecify.annotations.Nullable;

/**
 * The latest progress value of a task, and the attempt that wrote it.
 *
 * @param taskId the task
 * @param value the progress value as the core's JSON tree
 * @param revision the revision, which each accepted update increases
 * @param attempt the attempt that wrote the value
 * @param fenceToken the fence token of that attempt
 * @param workerId the worker that wrote the value
 * @param createdAt the time of the first update
 * @param updatedAt the time of the last update
 */
public record TaskProgress(
    UUID taskId,
    @Nullable Object value,
    long revision,
    int attempt,
    long fenceToken,
    String workerId,
    Instant createdAt,
    Instant updatedAt) {}
