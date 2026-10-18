package run.workhorse;

import java.util.Map;
import org.jspecify.annotations.Nullable;

/** SQLSTATE P1005: a dependency limit was reached. */
public final class DependencyLimitExceededException extends DiagnosedException {
  private static final long serialVersionUID = 1L;

  /** An exception with PostgreSQL's details. */
  public DependencyLimitExceededException(Map<String, @Nullable Object> details) {
    super(details, "PostgreSQL rejected a task dependency limit");
  }
}
