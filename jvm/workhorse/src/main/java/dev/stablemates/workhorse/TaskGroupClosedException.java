package dev.stablemates.workhorse;

import java.util.Locale;
import java.util.Map;
import java.util.UUID;
import org.jspecify.annotations.Nullable;

/** SQLSTATE P1008: the task group does not accept tasks. */
public final class TaskGroupClosedException extends DiagnosedException {
  private static final long serialVersionUID = 1L;

  /** Why the task group refused the tasks. */
  public enum Reason {
    /** The group is sealed, and the caller is not a running member task. */
    SEALED,
    /** The group is finished. */
    FINISHED,
    /** The group is canceled. */
    CANCELED,
    /** The task that adds is not a running member task of the group. */
    NOT_RUNNING_MEMBER
  }

  /** An exception with PostgreSQL's details. */
  public TaskGroupClosedException(Map<String, @Nullable Object> details) {
    super(
        details,
        "Task group "
            + text(details, "groupId", "unknown")
            + " does not accept tasks ("
            + text(details, "reason", "unknown")
            + ")");
  }

  /** The group, or {@code null} when PostgreSQL did not name it. */
  public @Nullable UUID groupId() {
    return uuid(details(), "groupId");
  }

  /** The state of the group, or {@code null} when PostgreSQL did not name a known state. */
  public @Nullable TaskGroupState state() {
    return constant(TaskGroupState.class, details().get("state"));
  }

  /** The reason, or {@code null} when PostgreSQL did not name a known reason. */
  public @Nullable Reason reason() {
    return constant(Reason.class, details().get("reason"));
  }

  private static <E extends Enum<E>> @Nullable E constant(Class<E> type, @Nullable Object value) {
    if (!(value instanceof String text)) {
      return null;
    }
    try {
      return Enum.valueOf(type, text.toUpperCase(Locale.ROOT));
    } catch (IllegalArgumentException error) {
      return null;
    }
  }
}
