package dev.stablemates.workhorse;

import java.util.Map;
import org.jspecify.annotations.Nullable;

/** SQLSTATE P1006: a retained purge request ID received a different queue. */
public final class PurgeIdempotencyConflictException extends DiagnosedException {
  private static final long serialVersionUID = 1L;

  /** An exception with PostgreSQL's details. */
  public PurgeIdempotencyConflictException(Map<String, @Nullable Object> details) {
    super(details, "PostgreSQL rejected a materially different idempotent queue purge");
  }
}
