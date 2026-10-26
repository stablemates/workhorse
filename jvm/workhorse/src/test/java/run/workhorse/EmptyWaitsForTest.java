package run.workhorse;

import org.jspecify.annotations.Nullable;

/**
 * Gives tests outside this package a view of the empty-claim wait of a worker. The view is in test
 * sources only, so it is not part of the public API.
 */
public final class EmptyWaitsForTest {
  private EmptyWaitsForTest() {}

  /**
   * The deadline of the empty-claim wait that {@code worker} has installed, in {@link
   * System#nanoTime} units, if a wake can end that wait. It is {@code null} when the worker has no
   * wait or has a wait that a wake cannot end.
   */
  public static @Nullable Long wakeableDeadline(Worker worker) {
    Worker.EmptyWaitView wait = worker.installedEmptyWait();
    return wait == null || !wait.wakeable() ? null : wait.deadline();
  }
}
