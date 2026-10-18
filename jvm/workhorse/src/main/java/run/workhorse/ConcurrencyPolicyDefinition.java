package run.workhorse;

import org.jspecify.annotations.Nullable;

/**
 * The concurrency limit a sync gives one queue.
 *
 * @param queue the queue
 * @param maxActive the active task limit, 1 to 1,000,000
 * @param maxActivePerKey the active task limit for each concurrency key, or {@code null}
 */
public record ConcurrencyPolicyDefinition(
    String queue, int maxActive, @Nullable Integer maxActivePerKey) {
  /** A policy without a limit for each key. */
  public ConcurrencyPolicyDefinition(String queue, int maxActive) {
    this(queue, maxActive, null);
  }
}
