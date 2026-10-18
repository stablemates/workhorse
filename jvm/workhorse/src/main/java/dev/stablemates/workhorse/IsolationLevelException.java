package dev.stablemates.workhorse;

/**
 * SQLSTATE {@code 0A000} on a claim: the connection runs at an isolation level above read
 * committed. Configure the pool at read committed.
 */
public final class IsolationLevelException extends DatabaseException {
  private static final long serialVersionUID = 1L;

  private final String isolationLevel;

  /** An exception for the isolation level that PostgreSQL reported. */
  public IsolationLevelException(String isolationLevel, String message, Throwable cause) {
    super(message, "0A000", cause);
    this.isolationLevel = isolationLevel;
  }

  /** The isolation level the connection reported, such as {@code repeatable read}. */
  public String isolationLevel() {
    return isolationLevel;
  }
}
