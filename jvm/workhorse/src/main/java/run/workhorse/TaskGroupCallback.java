package run.workhorse;

import java.util.UUID;
import org.jspecify.annotations.Nullable;

/**
 * A requested callback of a task group.
 *
 * @param kind the callback kind
 * @param taskId the callback task, {@code null} until the group finishes, and {@code null} for the
 *     callback that the result does not select
 * @param failure why the finished group did not enqueue this callback, or {@code null} when it did
 *     not fail
 */
public record TaskGroupCallback(
    TaskGroupCallbackKind kind, @Nullable UUID taskId, @Nullable TaskGroupCallbackFailure failure) {

  /** A callback with no failure. */
  public TaskGroupCallback(TaskGroupCallbackKind kind, @Nullable UUID taskId) {
    this(kind, taskId, null);
  }
}
