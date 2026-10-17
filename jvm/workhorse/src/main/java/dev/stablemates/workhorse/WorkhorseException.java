package dev.stablemates.workhorse;

/**
 * The root of every exception the SDK throws.
 *
 * <p>A caller catches a category, not one class for each primitive. An invalid argument throws
 * Java's own {@link IllegalArgumentException} before any statement runs. The counterpart of Ruby's
 * {@code Stablemates::Workhorse::Error}.
 */
public class WorkhorseException extends RuntimeException {
  private static final long serialVersionUID = 1L;

  /** An exception with a message. */
  public WorkhorseException(String message) {
    super(message);
  }

  /** An exception with a message and the exception that caused it. */
  public WorkhorseException(String message, Throwable cause) {
    super(message, cause);
  }
}
