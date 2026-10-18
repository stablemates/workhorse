package dev.stablemates.workhorse;

import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.jspecify.annotations.Nullable;

/**
 * One failed task of a {@link DeadLetterPage}.
 *
 * @param taskId the failed task
 * @param queue the queue
 * @param type the task type
 * @param concurrencyKey the concurrency key, or {@code null}
 * @param priority the priority
 * @param payload the payload as the core's JSON tree
 * @param tags the tags
 * @param currentAttempt the last attempt
 * @param maxAttempts the attempt limit
 * @param retryPolicy the persisted retry policy, or {@code null}
 * @param deadlineAt the absolute deadline, or {@code null}
 * @param executionTimeout the timeout of each attempt, or {@code null}
 * @param error the error of the last attempt as the core's JSON tree
 * @param finishedAt when the task failed
 * @param redriveCount how many times an operator redrove the task
 */
public record DeadLetter(
    UUID taskId,
    String queue,
    String type,
    @Nullable String concurrencyKey,
    int priority,
    @Nullable Object payload,
    List<String> tags,
    int currentAttempt,
    int maxAttempts,
    @Nullable Map<String, @Nullable Object> retryPolicy,
    @Nullable Instant deadlineAt,
    @Nullable Duration executionTimeout,
    @Nullable Object error,
    Instant finishedAt,
    long redriveCount) {
  /** Copies the tags. */
  public DeadLetter {
    tags = List.copyOf(tags);
  }
}
