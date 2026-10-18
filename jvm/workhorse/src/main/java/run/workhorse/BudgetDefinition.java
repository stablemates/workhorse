package run.workhorse;

import org.jspecify.annotations.Nullable;

/**
 * One named budget that tasks in any queue can name. Set {@code maxActive}, {@code rate}, or both.
 *
 * @param name the budget name
 * @param maxActive the active task limit, or {@code null}
 * @param rate the rate limit, or {@code null}
 */
public record BudgetDefinition(
    String name, @Nullable Integer maxActive, @Nullable RateLimit rate) {}
