package dev.stablemates.workhorse;

import org.jspecify.annotations.Nullable;

/**
 * The rate limit a sync gives one queue.
 *
 * @param queue the queue
 * @param rate the queue's rate limit
 * @param perKey the rate limit for each concurrency key, or {@code null}
 */
public record RateLimitPolicyDefinition(String queue, RateLimit rate, @Nullable RateLimit perKey) {
  /** A policy without a limit for each key. */
  public RateLimitPolicyDefinition(String queue, RateLimit rate) {
    this(queue, rate, null);
  }
}
