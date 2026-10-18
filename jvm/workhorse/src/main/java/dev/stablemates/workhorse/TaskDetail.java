package dev.stablemates.workhorse;

import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.jspecify.annotations.Nullable;

/**
 * The snapshot of one task. The counterpart of Ruby's {@code TaskSnapshot}.
 *
 * <p>The payload and the result have their redacted keys removed. The fields that {@link
 * TaskListItem} also has have the same meaning.
 *
 * @param id the task
 * @param queue the queue
 * @param type the task type
 * @param concurrencyKey the concurrency key, or {@code null}
 * @param priority the priority
 * @param payload the payload as the core's JSON tree
 * @param contractVersion the payload contract version that the task was stamped with, or {@code
 *     null}
 * @param tags the tags
 * @param state the state
 * @param prerequisiteTaskId the prerequisite task when the task has exactly one, or {@code null}
 * @param prerequisiteTaskIds every prerequisite task
 * @param dependencyPolicy the prerequisite policy, or {@code null} when the task has no
 *     prerequisite
 * @param blockedReason why the task is blocked, or {@code null}
 * @param parentTaskId the parent task, or {@code null}
 * @param childTaskIds the child tasks
 * @param currentAttempt the current attempt
 * @param maxAttempts the attempt limit
 * @param retryPolicy the persisted retry policy, or {@code null}
 * @param deadlineAt the absolute deadline, or {@code null}
 * @param executionTimeout the timeout of each attempt, or {@code null}
 * @param fenceToken the fence token of the current attempt, or {@code null} for a fast-tier task
 *     that finished before a worker claimed it
 * @param runAt the earliest run time
 * @param result the result as the core's JSON tree, or {@code null}
 * @param error the latest error as the core's JSON tree, or {@code null}
 * @param cancelRequestedAt when cancellation was requested, or {@code null}
 * @param cancelRequestedBy who requested cancellation, or {@code null}
 * @param cancelReason why, or {@code null}
 * @param progress the latest progress, or {@code null}
 * @param createdAt the creation time
 * @param updatedAt the time of the last change
 */
public record TaskDetail(
    UUID id,
    String queue,
    String type,
    @Nullable String concurrencyKey,
    int priority,
    @Nullable Object payload,
    @Nullable String contractVersion,
    List<String> tags,
    TaskState state,
    @Nullable UUID prerequisiteTaskId,
    List<UUID> prerequisiteTaskIds,
    @Nullable TaskDependencyPolicy dependencyPolicy,
    @Nullable TaskBlockedReason blockedReason,
    @Nullable UUID parentTaskId,
    List<UUID> childTaskIds,
    int currentAttempt,
    int maxAttempts,
    @Nullable Map<String, @Nullable Object> retryPolicy,
    @Nullable Instant deadlineAt,
    @Nullable Duration executionTimeout,
    @Nullable Long fenceToken,
    Instant runAt,
    @Nullable Object result,
    @Nullable Object error,
    @Nullable Instant cancelRequestedAt,
    @Nullable String cancelRequestedBy,
    @Nullable String cancelReason,
    @Nullable TaskProgress progress,
    Instant createdAt,
    Instant updatedAt) {
  /** Copies the lists. */
  public TaskDetail {
    tags = List.copyOf(tags);
    prerequisiteTaskIds = List.copyOf(prerequisiteTaskIds);
    childTaskIds = List.copyOf(childTaskIds);
  }
}
