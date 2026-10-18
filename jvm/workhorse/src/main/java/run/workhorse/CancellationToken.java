package run.workhorse;

import java.time.Duration;
import org.jspecify.annotations.Nullable;

/**
 * Tells a handler that its attempt must stop. The counterpart of Ruby's {@code CancellationToken}.
 *
 * <p>Cancellation is cooperative. The worker cancels the token, and the handler reads it, waits on
 * it, or registers a callback. At the drain deadline the worker also interrupts the handler's
 * thread. Only the first reason sticks.
 */
public interface CancellationToken {
  /** Whether the token is cancelled. */
  boolean isCancelled();

  /** Why the token was cancelled, or {@code null} until it is. */
  @Nullable CancellationReason reason();

  /**
   * Throws once the token is cancelled.
   *
   * @throws CancelledException with the reason, if the token is cancelled
   */
  void throwIfCancelled();

  /** Waits until the token is cancelled. */
  void await() throws InterruptedException;

  /**
   * Waits until the token is cancelled or the timeout passes.
   *
   * @return {@code true} if the token is cancelled
   */
  boolean await(Duration timeout) throws InterruptedException;

  /**
   * Runs {@code callback} once when the token is cancelled, or at once if it already is. On a
   * cancellation, the callback runs on a virtual thread that the worker starts, so a callback that
   * blocks delays neither lease renewal nor the drain. A callback for a token that is already
   * cancelled runs on the calling thread. An exception it throws does not reach the worker.
   *
   * @return a handle whose {@code close} removes the callback
   */
  AutoCloseable onCancel(Runnable callback);
}
