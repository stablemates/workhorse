package run.workhorse;

import java.util.List;
import org.jspecify.annotations.Nullable;

/**
 * One page of the tasks that wait for a human, oldest first.
 *
 * @param items the waits of the page
 * @param nextCursor the cursor of the next page, or {@code null} on the last page
 */
public record HumanWaitPage(List<HumanWait> items, @Nullable ExternalWaitCursor nextCursor) {
  /** Copies the items. */
  public HumanWaitPage {
    items = List.copyOf(items);
  }
}
