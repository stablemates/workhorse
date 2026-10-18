package run.workhorse;

import io.opentelemetry.api.OpenTelemetry;
import java.util.Objects;
import run.workhorse.internal.telemetry.OpenTelemetryTelemetry;
import run.workhorse.internal.telemetry.Telemetry;

/**
 * The OpenTelemetry instance that a {@link Queue} and a {@link Worker} report to (ADR 0103,
 * "Telemetry").
 *
 * <p>The OpenTelemetry API is an optional dependency. By default the SDK reads {@code
 * GlobalOpenTelemetry} on each use when the API is on the class path. Without the API, telemetry
 * does nothing and the SDK loads no OpenTelemetry class. Use {@link #of} to pass an explicit
 * instance instead of the global one.
 *
 * <p>The SDK emits the span, instrument, and attribute names of {@code api/telemetry.txt}, and
 * propagates W3C trace context from the enqueue to the handler span.
 */
public final class WorkhorseTelemetry {
  private static final WorkhorseTelemetry GLOBAL = new WorkhorseTelemetry(Telemetry.global());

  private final Telemetry telemetry;

  private WorkhorseTelemetry(Telemetry telemetry) {
    this.telemetry = telemetry;
  }

  /** Telemetry that reports to {@code openTelemetry}. */
  // The module reads the optional API without `transitive`, which is an automatic module. A caller
  // that builds an OpenTelemetry instance already reads it.
  @SuppressWarnings("exports")
  public static WorkhorseTelemetry of(OpenTelemetry openTelemetry) {
    return new WorkhorseTelemetry(
        OpenTelemetryTelemetry.of(Objects.requireNonNull(openTelemetry, "openTelemetry")));
  }

  /** The default: {@code GlobalOpenTelemetry} when the API is on the class path. */
  static WorkhorseTelemetry global() {
    return GLOBAL;
  }

  Telemetry telemetry() {
    return telemetry;
  }
}
