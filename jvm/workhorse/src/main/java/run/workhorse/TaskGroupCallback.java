package run.workhorse;

import java.util.UUID;
import org.jspecify.annotations.Nullable;

/**
 * A requested callback of a task group.
 *
 * @param kind the callback kind
 * @param taskId the callback task, {@code null} until the group finishes, and {@code null} for the
 *     callback that the result does not select
 */
public record TaskGroupCallback(TaskGroupCallbackKind kind, @Nullable UUID taskId) {}
