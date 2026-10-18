package dev.stablemates.workhorse;

import java.time.Duration;
import org.jspecify.annotations.Nullable;

/**
 * Chooses the delay before the retry of a failed attempt, in place of the persisted retry policy.
 * The counterpart of Ruby's {@code retry_delay} option.
 *
 * <p>The worker sends the delay to {@code fail_v1}. A {@code null} delay lets the persisted policy
 * choose.
 */
@FunctionalInterface
public interface RetryDelay {
  /**
   * The delay for one failed attempt.
   *
   * @param attempt the attempt that failed, from 1
   * @param task the task
   * @return a delay from 0 to 2,147,483,647 milliseconds, or {@code null}
   */
  @Nullable Duration delay(int attempt, ClaimedTask task);
}
