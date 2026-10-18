package run.workhorse;

import org.jspecify.annotations.Nullable;

/**
 * Completes one batch member with a result.
 *
 * @param result the member's result, or {@code null} for the JSON value {@code null}
 */
public record BatchSucceeded(@Nullable Object result) implements BatchHandlerOutcome {}
