package dev.stablemates.workhorse;

import java.time.Instant;
import java.util.UUID;
import org.jspecify.annotations.Nullable;

/**
 * A task that waits for a human decision.
 *
 * @param taskId the task
 * @param queue the queue
 * @param taskType the task type
 * @param name the decision name
 * @param attempt the attempt that waits
 * @param createdAt when the wait started
 * @param deadlineAt when the wait times out
 * @param context the context for the human as the core's JSON tree
 */
public record HumanWait(
    UUID taskId,
    String queue,
    String taskType,
    String name,
    int attempt,
    Instant createdAt,
    Instant deadlineAt,
    @Nullable Object context) {}
