package run.workhorse;

import org.jspecify.annotations.Nullable;

/**
 * The page of {@link Admin#getTaskTimeline}.
 *
 * @param limit the page size, 1 to 1,000
 * @param cursor the cursor of the previous page of the same task, or {@code null} for the first
 *     page
 */
public record TimelineQuery(int limit, @Nullable TaskTimelineCursor cursor) {
  private static final TimelineQuery DEFAULTS = new TimelineQuery(100, null);

  /** The first page of 100 entries. */
  public static TimelineQuery defaults() {
    return DEFAULTS;
  }
}
