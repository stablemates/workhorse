package run.workhorse;

import org.jspecify.annotations.Nullable;

/**
 * The optional callbacks of a task group. A callback cannot use enqueue idempotency, debounce, or
 * throttle. When the group is sealed and every member task is finished, Workhorse enqueues {@code
 * onFinish}, and {@code onSuccess} or {@code onFailure} as the result selects.
 *
 * @param onFinish the callback for every result, or {@code null}
 * @param onSuccess the callback for a successful group, or {@code null}
 * @param onFailure the callback for a failed group, or {@code null}
 */
public record TaskGroupCallbacks(
    @Nullable EnqueueRequest onFinish,
    @Nullable EnqueueRequest onSuccess,
    @Nullable EnqueueRequest onFailure) {
  /** No callbacks. */
  public static TaskGroupCallbacks none() {
    return new TaskGroupCallbacks(null, null, null);
  }
}
