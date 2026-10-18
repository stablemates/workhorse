package dev.stablemates.workhorse;

import java.time.Instant;
import org.jspecify.annotations.Nullable;

/**
 * A stored rate limit policy for one queue.
 *
 * @param namespace the namespace that synced the policy
 * @param queue the queue
 * @param rate the queue's rate limit
 * @param perKey the rate limit for each concurrency key, or {@code null}
 * @param updatedAt when the policy last changed
 */
public record RateLimitPolicy(
    String namespace,
    String queue,
    RateLimit rate,
    @Nullable RateLimit perKey,
    Instant updatedAt) {}
