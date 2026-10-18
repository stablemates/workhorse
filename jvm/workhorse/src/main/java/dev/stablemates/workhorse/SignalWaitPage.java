package dev.stablemates.workhorse;

import java.util.List;
import org.jspecify.annotations.Nullable;

/**
 * One page of the tasks that wait for a signal, oldest first.
 *
 * @param items the waits of the page
 * @param nextCursor the cursor of the next page, or {@code null} on the last page
 */
public record SignalWaitPage(List<SignalWait> items, @Nullable ExternalWaitCursor nextCursor) {
  /** Copies the items. */
  public SignalWaitPage {
    items = List.copyOf(items);
  }
}
