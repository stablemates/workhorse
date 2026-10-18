package dev.stablemates.workhorse;

import java.util.Map;
import java.util.UUID;
import org.jspecify.annotations.Nullable;

/** SQLSTATE P1009: an add would take the task group above its member limit. */
public final class TaskGroupLimitExceededException extends DiagnosedException {
  private static final long serialVersionUID = 1L;

  /** An exception with PostgreSQL's details. */
  public TaskGroupLimitExceededException(Map<String, @Nullable Object> details) {
    super(
        details,
        "Task group "
            + text(details, "groupId", "unknown")
            + " holds "
            + text(details, "total", "0")
            + " tasks and accepts at most "
            + text(details, "limit", "100000"));
  }

  /** The group, or {@code null}. */
  public @Nullable UUID groupId() {
    return uuid(details(), "groupId");
  }

  /** The member limit, or {@code null}. */
  public @Nullable Long limit() {
    return number(details(), "limit");
  }

  /** The members the group holds, or {@code null}. */
  public @Nullable Long total() {
    return number(details(), "total");
  }

  /** The members the refused add requested, or {@code null}. */
  public @Nullable Long requested() {
    return number(details(), "requested");
  }
}
