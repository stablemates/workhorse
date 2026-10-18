package run.workhorse;

import java.util.Objects;

/**
 * Fails one batch member's attempt. PostgreSQL then retries or fails the task by its retry policy.
 *
 * @param error the member's error
 */
public record BatchFailed(Exception error) implements BatchHandlerOutcome {
  /** Refuses a {@code null} error. */
  public BatchFailed {
    Objects.requireNonNull(error, "error");
  }
}
