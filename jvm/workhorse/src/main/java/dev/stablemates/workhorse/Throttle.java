package dev.stablemates.workhorse;

import java.time.Duration;

/**
 * Accepts at most one equivalent keyed task during a PostgreSQL-owned window.
 *
 * @param key the throttle key, 1 to 512 UTF-8 bytes
 * @param window the window
 * @param scope the scope of the key, {@code "default"} by default
 */
public record Throttle(String key, Duration window, String scope) {
  /** A key in the default scope. */
  public Throttle(String key, Duration window) {
    this(key, window, "default");
  }
}
