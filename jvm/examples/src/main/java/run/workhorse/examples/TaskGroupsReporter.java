package run.workhorse.examples;

import org.jspecify.annotations.Nullable;

/** Sends the report of one import, for the snippets of the site page about task groups. */
public interface TaskGroupsReporter {
  /** Sends the counts of the import {@code importId}. */
  void send(@Nullable Object importId, long succeeded, long failed);
}
