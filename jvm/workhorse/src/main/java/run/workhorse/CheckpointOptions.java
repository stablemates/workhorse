package run.workhorse;

import org.jspecify.annotations.Nullable;

/**
 * The options of {@link HandlerContext#checkpoint(String, java.lang.reflect.Type,
 * CheckpointOptions, java.util.concurrent.Callable)}.
 *
 * @param input the checkpoint input, a JSON value whose fingerprint the checkpoint stores (ADR
 *     0098). A {@code null} input is the JSON value {@code null}. Only a call without options has
 *     no input.
 */
public record CheckpointOptions(@Nullable Object input) {
  /** Options with {@code input}. */
  public static CheckpointOptions input(@Nullable Object input) {
    return new CheckpointOptions(input);
  }
}
