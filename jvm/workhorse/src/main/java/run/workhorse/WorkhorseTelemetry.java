package run.workhorse;

import io.opentelemetry.api.OpenTelemetry;
import java.util.Objects;
import run.workhorse.internal.telemetry.OpenTelemetryTelemetry;
import run.workhorse.internal.telemetry.Telemetry;

/**
 * The OpenTelemetry instance that a {@link Queue} and a {@link Worker} report to (ADR 0103,
 * "Telemetry").
 *
 * <p>The OpenTelemetry API is an optional dependency. By default the SDK reads the current {@code
 * GlobalOpenTelemetry} instance at each use when the API is on the class path. Until the
 * application sets that instance, the SDK records nothing and installs no global instance. Thus the
 * application can call {@code GlobalOpenTelemetry.set} after it builds a {@link Queue}, an {@link
 * Admin}, or a {@link Worker}.
 *
 * <p>On an OpenTelemetry API older than 1.57.0, the first use installs the no-op global instance,
 * as {@code GlobalOpenTelemetry.get()} does. If the global autoconfiguration of OpenTelemetry is
 * on, the first use calls {@code GlobalOpenTelemetry.get()}, which installs the global instance.
 * Without the API, telemetry does nothing and the SDK loads no OpenTelemetry class. Use {@link #of}
 * to pass an explicit instance instead of the global one.
 *
 * <p>A telemetry failure never changes the result of an operation. If the instance, an instrument,
 * or a span throws a {@code RuntimeException}, the SDK discards the signal.
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
