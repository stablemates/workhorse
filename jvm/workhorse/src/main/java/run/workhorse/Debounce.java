package run.workhorse;

import java.time.Duration;

/**
 * Replaces a pending keyed task during a PostgreSQL-owned window.
 *
 * @param key the debounce key, 1 to 512 UTF-8 bytes
 * @param window the window
 * @param schedule how a replacement moves the run time, {@link DebounceSchedule#RESET} by default
 * @param scope the scope of the key, {@code "default"} by default
 */
public record Debounce(String key, Duration window, DebounceSchedule schedule, String scope) {
  /** A key in the default scope that resets the window. */
  public Debounce(String key, Duration window) {
    this(key, window, DebounceSchedule.RESET, "default");
  }
}
