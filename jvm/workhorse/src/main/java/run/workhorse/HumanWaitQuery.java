package run.workhorse;

import org.jspecify.annotations.Nullable;

/**
 * The page of {@link Admin#listHumanWaits}.
 *
 * @param limit the page size, 1 to 1,000
 * @param cursor the cursor of the previous page, or {@code null} for the first page
 */
public record HumanWaitQuery(int limit, @Nullable ExternalWaitCursor cursor) {
  private static final HumanWaitQuery DEFAULTS = new HumanWaitQuery(100, null);

  /** The first page of 100 waits. */
  public static HumanWaitQuery defaults() {
    return DEFAULTS;
  }
}
