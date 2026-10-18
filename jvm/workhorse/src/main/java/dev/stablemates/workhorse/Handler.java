package dev.stablemates.workhorse;

import org.jspecify.annotations.Nullable;

/**
 * Runs the tasks of one task type. The counterpart of the block that Ruby's {@code Worker#handle}
 * takes.
 *
 * <p>The worker calls the handler on its own thread for each task. The return value is the task's
 * JSON result, which the worker encodes with its codec. A handler fails its attempt by throwing any
 * {@link Exception}; PostgreSQL then retries or fails the task by its retry policy.
 *
 * @param <P> the payload type. A JSON payload can be {@code null}, so the bound is nullable.
 */
@FunctionalInterface
public interface Handler<P extends @Nullable Object> {
  /**
   * Runs one task.
   *
   * @param ctx the task and its cancellation token
   * @param payload the payload, decoded by the worker's codec
   * @return the result, or {@code null} for the JSON value {@code null}
   * @throws Exception to fail the attempt
   */
  @Nullable Object handle(HandlerContext ctx, P payload) throws Exception;
}
