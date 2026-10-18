package dev.stablemates.workhorse;

import java.time.Instant;
import org.jspecify.annotations.Nullable;

/**
 * A stored budget.
 *
 * @param namespace the namespace that synced the budget
 * @param name the budget name
 * @param maxActive the active task limit, or {@code null}
 * @param rate the rate limit, or {@code null}
 * @param updatedAt when the budget last changed
 */
public record Budget(
    String namespace,
    String name,
    @Nullable Integer maxActive,
    @Nullable RateLimit rate,
    Instant updatedAt) {}
