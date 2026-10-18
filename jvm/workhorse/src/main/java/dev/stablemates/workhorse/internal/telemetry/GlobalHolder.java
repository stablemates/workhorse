package dev.stablemates.workhorse.internal.telemetry;

/**
 * Holds {@link Telemetry#global}. The class initializer probes for the OpenTelemetry API once. It
 * loads {@link OpenTelemetryTelemetry} only when the probe finds the API, so the JVM never links an
 * OpenTelemetry class without it.
 */
final class GlobalHolder {
  static final Telemetry GLOBAL = available() ? OpenTelemetryTelemetry.global() : Telemetry.NOOP;

  private GlobalHolder() {}

  /** Whether the OpenTelemetry API is visible to the SDK's class loader or module. */
  static boolean available() {
    try {
      Class.forName(
          "io.opentelemetry.api.GlobalOpenTelemetry", false, GlobalHolder.class.getClassLoader());
      return true;
    } catch (ClassNotFoundException | LinkageError error) {
      return false;
    }
  }
}
