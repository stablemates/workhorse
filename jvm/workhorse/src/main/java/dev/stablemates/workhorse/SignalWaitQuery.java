package dev.stablemates.workhorse;

import org.jspecify.annotations.Nullable;

/**
 * The page of {@link Admin#listSignalWaits}.
 *
 * @param limit the page size, 1 to 1,000
 * @param cursor the cursor of the previous page, or {@code null} for the first page
 */
public record SignalWaitQuery(int limit, @Nullable ExternalWaitCursor cursor) {
  private static final SignalWaitQuery DEFAULTS = new SignalWaitQuery(100, null);

  /** The first page of 100 waits. */
  public static SignalWaitQuery defaults() {
    return DEFAULTS;
  }
}
