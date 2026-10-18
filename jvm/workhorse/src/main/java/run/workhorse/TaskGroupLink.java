package run.workhorse;

import org.jspecify.annotations.Nullable;

/**
 * The group of a task.
 *
 * @param role whether the task is a member task or a callback
 * @param callback the callback kind of a callback task, and {@code null} for a member task
 * @param group the group
 */
public record TaskGroupLink(
    TaskGroupRole role, @Nullable TaskGroupCallbackKind callback, TaskGroup group) {}
