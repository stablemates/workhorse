package dev.stablemates.workhorse;

/**
 * What a handler receives beside its payload: the task and its cancellation token. The counterpart
 * of Ruby's {@code HandlerContext}.
 */
public interface HandlerContext {
  /** The task this attempt runs. */
  ClaimedTask task();

  /** The attempt's cancellation token. */
  CancellationToken cancellation();

  /** Whether the attempt's token is cancelled. It delegates to {@link #cancellation()}. */
  boolean isCancelled();
}
