package dev.stablemates.workhorse;

import java.time.Duration;

/** Progress was written too often. */
public final class ProgressRateLimitedException extends WorkhorseException {
  private static final long serialVersionUID = 1L;

  private final Duration retryAfter;

  /** An exception that names how long the caller must wait. */
  public ProgressRateLimitedException(Duration retryAfter) {
    super(
        "progress is rate limited; retry after "
            + java.math.BigDecimal.valueOf(retryAfter.toMillis(), 3)
                .stripTrailingZeros()
                .toPlainString()
            + " seconds");
    this.retryAfter = retryAfter;
  }

  /** How long the caller must wait before the next progress write. */
  public Duration retryAfter() {
    return retryAfter;
  }
}
