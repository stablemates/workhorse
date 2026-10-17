package dev.stablemates.workhorse;

import java.util.Map;
import java.util.UUID;
import org.jspecify.annotations.Nullable;

/** SQLSTATE P1010: enqueue idempotency returned a task that is not a member of the task group. */
public final class TaskGroupMembershipConflictException extends DiagnosedException {
  private static final long serialVersionUID = 1L;

  /** An exception with PostgreSQL's details. */
  public TaskGroupMembershipConflictException(Map<String, @Nullable Object> details) {
    super(
        details,
        "Enqueue idempotency returned task "
            + text(details, "taskId", "unknown")
            + ", which is not a member of task group "
            + text(details, "groupId", "unknown"));
  }

  /** The group, or {@code null}. */
  public @Nullable UUID groupId() {
    return uuid(details(), "groupId");
  }

  /** The existing task, or {@code null}. */
  public @Nullable UUID taskId() {
    return uuid(details(), "taskId");
  }

  /** The 1-based position of the request in its batch, or {@code null}. */
  public @Nullable Long ordinal() {
    return number(details(), "ordinal");
  }

  /** The group the existing task belongs to, or {@code null}. */
  public @Nullable UUID memberOf() {
    return uuid(details(), "memberOf");
  }
}
