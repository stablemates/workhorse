package run.workhorse;

import org.jspecify.annotations.Nullable;

/**
 * How one child of {@link HandlerContext#runChildren} ended. The counterpart of Ruby's {@code
 * ChildOutcome}.
 *
 * @param status how the child ended
 * @param result the result of a child that succeeded, as the core's JSON tree, or {@code null}
 * @param error the failure envelope of a child that failed, as the core's JSON tree, or {@code
 *     null}
 */
public record ChildOutcome(ChildStatus status, @Nullable Object result, @Nullable Object error) {}
