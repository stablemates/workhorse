package dev.stablemates.workhorse;

import java.util.Objects;
import org.jspecify.annotations.Nullable;

/**
 * One child of {@link HandlerContext#runChildren} or {@link HandlerContext#runChildrenAll}. The
 * counterpart of Ruby's {@code ChildTaskRequest}.
 *
 * @param name the child name, unique in the set, of 1 to 200 characters
 * @param taskType the task type of the child
 * @param payload the JSON payload, which can be {@code null}
 * @param options the enqueue options, without idempotency, debounce, throttle, or dependencies. A
 *     child with no queue runs on the queue of its parent.
 */
public record ChildRequest(
    String name, String taskType, @Nullable Object payload, EnqueueOptions options) {
  /** Checks that no component is {@code null}, apart from the payload. */
  public ChildRequest {
    Objects.requireNonNull(name, "name");
    Objects.requireNonNull(taskType, "taskType");
    Objects.requireNonNull(options, "options");
  }

  /** A child with the default options. */
  public static ChildRequest of(String name, String taskType, @Nullable Object payload) {
    return new ChildRequest(name, taskType, payload, EnqueueOptions.defaults());
  }

  /** A child with {@code options}. */
  public static ChildRequest of(
      String name, String taskType, @Nullable Object payload, EnqueueOptions options) {
    return new ChildRequest(name, taskType, payload, options);
  }
}
