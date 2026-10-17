package dev.stablemates.workhorse;

import org.jspecify.annotations.Nullable;

/**
 * One request of an enqueue batch, a task group, or a callback.
 *
 * @param taskType the task type
 * @param payload the JSON payload, which can be {@code null}
 * @param options the enqueue options
 */
public record EnqueueRequest(String taskType, @Nullable Object payload, EnqueueOptions options) {
  /** A request with the default options. */
  public static EnqueueRequest of(String taskType, @Nullable Object payload) {
    return new EnqueueRequest(taskType, payload, EnqueueOptions.defaults());
  }

  /** A request with {@code options}. */
  public static EnqueueRequest of(
      String taskType, @Nullable Object payload, EnqueueOptions options) {
    return new EnqueueRequest(taskType, payload, options);
  }
}
