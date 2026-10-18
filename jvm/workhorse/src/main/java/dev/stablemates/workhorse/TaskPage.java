package dev.stablemates.workhorse;

import java.util.List;
import org.jspecify.annotations.Nullable;

/**
 * One page of tasks, newest first.
 *
 * @param items the tasks of the page
 * @param nextCursor the cursor of the next page, or {@code null} on the last page
 */
public record TaskPage(List<TaskListItem> items, @Nullable TaskListCursor nextCursor) {
  /** Copies the items. */
  public TaskPage {
    items = List.copyOf(items);
  }
}
