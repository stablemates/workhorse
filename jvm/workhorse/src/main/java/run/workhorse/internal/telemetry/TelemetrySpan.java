package run.workhorse.internal.telemetry;

import org.jspecify.annotations.Nullable;

/**
 * One span that is current on this thread until {@link #close} ends it. Without OpenTelemetry,
 * every method does nothing.
 */
public interface TelemetrySpan extends AutoCloseable {
  /** A span that records nothing. */
  TelemetrySpan NOOP =
      new TelemetrySpan() {
        @Override
        public void setAttribute(String key, @Nullable Object value) {}

        @Override
        public void recordError(String errorType) {}

        @Override
        public void close() {}
      };

  /**
   * Sets one attribute. A {@code null} value sets nothing. A {@link Boolean}, an integral {@link
   * Number}, and a {@link Double} or {@link Float} keep their type; any other value is its string.
   */
  void setAttribute(String key, @Nullable Object value);

  /**
   * Marks the span as failed and adds one {@code exception} event with {@code exception.type}. The
   * span records no message and no stack, as Ruby's {@code record_error} does.
   */
  void recordError(String errorType);

  /** Ends the span and restores the context that was current before it. */
  @Override
  void close();
}
