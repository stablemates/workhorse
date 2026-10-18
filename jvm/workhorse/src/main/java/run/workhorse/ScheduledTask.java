package run.workhorse;

import java.util.Map;
import org.jspecify.annotations.Nullable;

/**
 * The task a schedule enqueues at each occurrence.
 *
 * @param taskType the task type
 * @param payload the JSON payload, which can be {@code null}
 * @param queue the queue, or {@code null} for the queue's default queue
 * @param priority the priority, 0 to 100
 * @param concurrencyKey the concurrency key, or {@code null}
 * @param maxAttempts the attempt limit, or {@code null} for the default of 25
 * @param retryPolicy the persisted retry policy, or {@code null}
 */
public record ScheduledTask(
    String taskType,
    @Nullable Object payload,
    @Nullable String queue,
    int priority,
    @Nullable String concurrencyKey,
    @Nullable Integer maxAttempts,
    @Nullable Map<String, ?> retryPolicy) {
  /** A task with priority 0 on the default queue. */
  public static ScheduledTask of(String taskType, @Nullable Object payload) {
    return new ScheduledTask(taskType, payload, null, 0, null, null, null);
  }
}
