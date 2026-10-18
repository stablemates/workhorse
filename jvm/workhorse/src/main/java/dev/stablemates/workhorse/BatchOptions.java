package dev.stablemates.workhorse;

import dev.stablemates.workhorse.internal.Values;
import java.time.Duration;
import java.util.Objects;

/**
 * The bounds of one batch handler. {@link Worker.Builder#handleBatch} takes them. The counterpart
 * of the {@code max_size} and {@code linger} keywords of Ruby's {@code Worker#handle_batch}.
 *
 * @param maxSize the most tasks one handler call receives, from 1 to 100. It must not exceed the
 *     worker's concurrency, which {@link Worker.Builder#build} checks.
 * @param linger how long a claimed task waits for others of its queue, a whole number of
 *     milliseconds from 0 to 60 s
 */
public record BatchOptions(int maxSize, Duration linger) {
  /**
   * Checks the bounds.
   *
   * @throws IllegalArgumentException if a bound is out of range
   */
  public BatchOptions {
    if (maxSize < 1 || maxSize > 100) {
      throw new IllegalArgumentException("maxSize must be between 1 and 100");
    }
    Objects.requireNonNull(linger, "linger");
    if (linger.toNanos() % 1_000_000 != 0) {
      throw new IllegalArgumentException("linger must be a whole number of milliseconds");
    }
    Values.milliseconds(linger, "linger", 0, 60_000);
  }
}
