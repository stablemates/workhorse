package dev.stablemates.workhorse;

/** The worker's {@link HandlerContext} for one attempt. */
final class TaskContext implements HandlerContext {
  private final ClaimedTask task;
  private final TaskCancellation cancellation;

  TaskContext(ClaimedTask task, TaskCancellation cancellation) {
    this.task = task;
    this.cancellation = cancellation;
  }

  @Override
  public ClaimedTask task() {
    return task;
  }

  @Override
  public CancellationToken cancellation() {
    return cancellation;
  }

  @Override
  public boolean isCancelled() {
    return cancellation.isCancelled();
  }
}
