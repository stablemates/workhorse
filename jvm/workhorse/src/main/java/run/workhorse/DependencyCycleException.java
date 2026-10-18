package run.workhorse;

import java.util.Map;
import org.jspecify.annotations.Nullable;

/** SQLSTATE P1003: the dependency would close a cycle. */
public final class DependencyCycleException extends DiagnosedException {
  private static final long serialVersionUID = 1L;

  /** An exception with PostgreSQL's details. */
  public DependencyCycleException(Map<String, @Nullable Object> details) {
    super(details, "PostgreSQL rejected a cyclic task dependency");
  }
}
