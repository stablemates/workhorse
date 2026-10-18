package dev.stablemates.workhorse;

import java.util.List;
import org.jspecify.annotations.Nullable;

/**
 * Runs the tasks of one task type in batches. The counterpart of the block that Ruby's {@code
 * Worker#handle_batch} takes.
 *
 * <p>The worker calls the handler with one {@link BatchHandlerItem} for each task, highest priority
 * first and then in claim order. The handler returns one {@link BatchHandlerOutcome} for each item,
 * in the same order. Each task still holds its own lease and settles on its own, so one failed
 * member does not fail the others.
 *
 * <p>If the handler throws an exception, every member of the batch fails with it. An {@link Error}
 * fails every member with a {@link WorkhorseException} that names it. If the handler returns {@code
 * null}, a list of the wrong size, or a {@code null} element, every member fails with a {@link
 * WorkhorseException} that names the problem.
 *
 * @param <P> the payload type. A JSON payload can be {@code null}, so the bound is nullable.
 */
@FunctionalInterface
public interface BatchHandler<P extends @Nullable Object> {
  /**
   * Runs one batch.
   *
   * @param items the members of the batch, each with its payload and its own context
   * @return one outcome for each item, in item order
   * @throws Exception to fail every member of the batch
   */
  List<BatchHandlerOutcome> handle(List<BatchHandlerItem<P>> items) throws Exception;
}
