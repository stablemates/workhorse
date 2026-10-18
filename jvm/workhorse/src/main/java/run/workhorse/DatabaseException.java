package run.workhorse;

import org.jspecify.annotations.Nullable;

/**
 * Any other {@link java.sql.SQLException}. The original is the {@linkplain #getCause cause}, and
 * {@link #sqlState} is its SQLSTATE. This class keeps PgJDBC types out of a caller's catch clauses.
 */
public class DatabaseException extends WorkhorseException {
  private static final long serialVersionUID = 1L;

  private final @Nullable String sqlState;

  /** An exception with the driver's message, its SQLSTATE, and the original exception. */
  public DatabaseException(String message, @Nullable String sqlState, Throwable cause) {
    super(message, cause);
    this.sqlState = sqlState;
  }

  /** The SQLSTATE, or {@code null} when the driver reported none. */
  public @Nullable String sqlState() {
    return sqlState;
  }
}
