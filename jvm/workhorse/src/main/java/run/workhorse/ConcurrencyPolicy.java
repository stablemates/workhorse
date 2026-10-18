package run.workhorse;

import java.time.Instant;
import org.jspecify.annotations.Nullable;

/**
 * A stored concurrency policy for one queue.
 *
 * @param namespace the namespace that synced the policy
 * @param queue the queue
 * @param maxActive the active task limit
 * @param maxActivePerKey the active task limit for each concurrency key, or {@code null}
 * @param updatedAt when the policy last changed
 */
public record ConcurrencyPolicy(
    String namespace,
    String queue,
    int maxActive,
    @Nullable Integer maxActivePerKey,
    Instant updatedAt) {}
