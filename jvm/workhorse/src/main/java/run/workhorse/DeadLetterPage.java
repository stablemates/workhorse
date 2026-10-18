package run.workhorse;

import java.util.List;
import org.jspecify.annotations.Nullable;

/**
 * One page of failed tasks, most recently finished first.
 *
 * @param items the failed tasks of the page
 * @param nextCursor the cursor of the next page, or {@code null} on the last page
 */
public record DeadLetterPage(List<DeadLetter> items, @Nullable DeadLetterCursor nextCursor) {
  /** Copies the items. */
  public DeadLetterPage {
    items = List.copyOf(items);
  }
}
