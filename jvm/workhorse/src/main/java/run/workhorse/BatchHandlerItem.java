package run.workhorse;

import org.jspecify.annotations.Nullable;

/**
 * One member of a batch: its payload and its own context. The counterpart of Ruby's {@code
 * BatchHandlerItem}.
 *
 * @param payload the payload, decoded by the worker's codec
 * @param context the member's own context
 * @param <P> the payload type
 */
public record BatchHandlerItem<P extends @Nullable Object>(
    P payload, BatchHandlerContext context) {}
