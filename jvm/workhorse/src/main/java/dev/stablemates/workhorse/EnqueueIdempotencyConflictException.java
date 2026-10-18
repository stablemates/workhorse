package dev.stablemates.workhorse;

import java.util.Map;
import org.jspecify.annotations.Nullable;

/** SQLSTATE P1001: a retained idempotency key received a materially different request. */
public final class EnqueueIdempotencyConflictException extends DiagnosedException {
  private static final long serialVersionUID = 1L;

  /** An exception with PostgreSQL's details. */
  public EnqueueIdempotencyConflictException(Map<String, @Nullable Object> details) {
    super(details, "PostgreSQL rejected a materially different idempotent enqueue");
  }
}
