package run.workhorse;

import java.util.Map;
import org.jspecify.annotations.Nullable;

/** SQLSTATE P1002: a retained redrive request ID received a different source task. */
public final class RedriveIdempotencyConflictException extends DiagnosedException {
  private static final long serialVersionUID = 1L;

  /** An exception with PostgreSQL's details. */
  public RedriveIdempotencyConflictException(Map<String, @Nullable Object> details) {
    super(details, "PostgreSQL rejected a materially different idempotent redrive");
  }
}
