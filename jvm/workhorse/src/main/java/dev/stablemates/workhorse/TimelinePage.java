package dev.stablemates.workhorse;

import java.util.List;
import org.jspecify.annotations.Nullable;

/**
 * One page of the events and attempts of a task, newest first.
 *
 * @param items the entries of the page
 * @param nextCursor the cursor of the next page, or {@code null} on the last page
 */
public record TimelinePage(List<TaskTimelineEntry> items, @Nullable TaskTimelineCursor nextCursor) {
  /** Copies the items. */
  public TimelinePage {
    items = List.copyOf(items);
  }
}
