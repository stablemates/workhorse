package run.workhorse;

import org.jspecify.annotations.Nullable;

/** PostgreSQL returned a status this SDK does not know. An unknown status is never a success. */
public final class UnexpectedStatusException extends WorkhorseException {
  private static final long serialVersionUID = 1L;

  private final String operation;
  private final @Nullable String status;

  /** An exception for the operation and the status text. */
  public UnexpectedStatusException(String operation, @Nullable String status) {
    super(
        operation
            + " returned unexpected status "
            + (status == null ? "null" : "\"" + status + "\""));
    this.operation = operation;
    this.status = status;
  }

  /** The operation. */
  public String operation() {
    return operation;
  }

  /** The status PostgreSQL returned, or {@code null}. */
  public @Nullable String status() {
    return status;
  }
}
