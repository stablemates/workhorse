package run.workhorse;

import java.util.List;

/**
 * What the block form of {@link Queue#taskGroup(TaskGroupCallbacks, java.util.function.Consumer)}
 * returns.
 *
 * @param group the sealed group
 * @param tasks one result for each added request, in order
 */
public record TaskGroupBlockResult(TaskGroup group, List<EnqueueResult> tasks) {
  /** Copies the results. */
  public TaskGroupBlockResult {
    tasks = List.copyOf(tasks);
  }
}
