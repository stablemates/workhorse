package run.workhorse;

import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.jspecify.annotations.Nullable;

/**
 * One task of a {@link TaskPage}.
 *
 * @param id the task
 * @param queue the queue
 * @param type the task type
 * @param concurrencyKey the concurrency key, or {@code null}
 * @param priority the priority
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
 * @param runAt the earliest run time
 * @param cancelRequestedAt when cancellation was requested, or {@code null}
 * @param cancelRequestedBy who requested cancellation, or {@code null}
 * @param cancelReason why, or {@code null}
 * @param createdAt the creation time
 * @param updatedAt the time of the last change
 * @param payload the payload as the core's JSON tree, or {@code null} when the page omits it or the
 *     payload is JSON {@code null}
 * @param payloadStatus what the page did with the payload
 * @param payloadBytes the size of the payload when the projection includes payloads, or {@code
 *     null}
 */
public record TaskListItem(
    UUID id,
    String queue,
    String type,
    @Nullable String concurrencyKey,
    int priority,
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
    Instant runAt,
    @Nullable Instant cancelRequestedAt,
    @Nullable String cancelRequestedBy,
    @Nullable String cancelReason,
    Instant createdAt,
    Instant updatedAt,
    @Nullable Object payload,
    TaskPayloadStatus payloadStatus,
    @Nullable Long payloadBytes) {
  /** Copies the lists. */
  public TaskListItem {
    tags = List.copyOf(tags);
    prerequisiteTaskIds = List.copyOf(prerequisiteTaskIds);
    childTaskIds = List.copyOf(childTaskIds);
  }
}
