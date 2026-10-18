package run.workhorse;

import java.util.List;
import org.jspecify.annotations.Nullable;

/**
 * The results of one page of a bulk redrive.
 *
 * @param results one result for each source task of the page
 * @param nextCursor the cursor of the next page, or {@code null} on the last page
 */
public record BulkRedrivePage(List<RedriveResult> results, @Nullable DeadLetterCursor nextCursor) {
  /** Copies the results. */
  public BulkRedrivePage {
    results = List.copyOf(results);
  }
}
