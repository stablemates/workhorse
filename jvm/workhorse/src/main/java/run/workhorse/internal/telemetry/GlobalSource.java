package run.workhorse.internal.telemetry;

import io.opentelemetry.api.GlobalOpenTelemetry;
import io.opentelemetry.api.OpenTelemetry;
import java.util.function.BooleanSupplier;
import java.util.function.Supplier;

/**
 * The current {@code GlobalOpenTelemetry} instance, read at each use, as the TypeScript SDK reads
 * its telemetry provider at each use.
 *
 * <p>The first {@code GlobalOpenTelemetry.get()} of a process installs the no-op instance when no
 * instance is set, and a later {@code GlobalOpenTelemetry.set} then throws. So the source calls
 * {@code get()} only after {@code GlobalOpenTelemetry.isSet()} is true, and uses the no-op instance
 * before that without installing it. An application can then register its global instance after it
 * builds and uses a queue, an admin client, or a worker.
 *
 * <p>The source calls {@code get()} at each use in two cases:
 *
 * <ul>
 *   <li>The global autoconfiguration of OpenTelemetry is on. The source reads the setting at each
 *       use before the instance is set, as {@code get()} reads it when it configures the global
 *       instance. {@link #autoConfigureEnabled} tells which keys it reads.
 *   <li>The OpenTelemetry API is older than 1.57.0, which has no {@code isSet}. The SDK runs on
 *       1.55.0, the version of the Spring Boot 4.0 BOM. On that API the first use still installs
 *       the no-op instance.
 * </ul>
 */
final class GlobalSource implements Supplier<OpenTelemetry> {
  private static final String AUTOCONFIGURE = "otel.java.global-autoconfigure.enabled";
  // OpenTelemetry also accepts the key with a dot in place of the dash.
  private static final String AUTOCONFIGURE_DOTTED = "otel.java.global.autoconfigure.enabled";
  private static final String AUTOCONFIGURE_VARIABLE = "OTEL_JAVA_GLOBAL_AUTOCONFIGURE_ENABLED";

  private final BooleanSupplier isSet;
  private final Supplier<OpenTelemetry> global;
  private final BooleanSupplier autoConfigure;
  // True after `isSet` failed to link. A failed link fails again at each call, so the source probes
  // once.
  private volatile boolean noIsSet;

  GlobalSource(
      BooleanSupplier isSet, Supplier<OpenTelemetry> global, BooleanSupplier autoConfigure) {
    this.isSet = isSet;
    this.global = global;
    this.autoConfigure = autoConfigure;
  }

  /** The source of {@code GlobalOpenTelemetry}. */
  // A method reference to `isSet` links when `of` runs and fails there on an older API. The lambda
  // body links at its first call, where `set` catches the failure.
  @SuppressWarnings("UnnecessaryLambda")
  static GlobalSource of() {
    BooleanSupplier isSet = () -> GlobalOpenTelemetry.isSet();
    return new GlobalSource(isSet, GlobalOpenTelemetry::get, GlobalSource::autoConfigureEnabled);
  }

  @Override
  public OpenTelemetry get() {
    if (noIsSet || set() || autoConfigure.getAsBoolean()) {
      return global.get();
    }
    return OpenTelemetry.noop();
  }

  private boolean set() {
    try {
      return isSet.getAsBoolean();
    } catch (LinkageError olderApi) {
      noIsSet = true;
      return true;
    }
  }

  /**
   * Whether the global autoconfiguration of OpenTelemetry is on. The source reads the system
   * property {@code otel.java.global-autoconfigure.enabled} or {@code
   * otel.java.global.autoconfigure.enabled}, then the environment variable {@code
   * OTEL_JAVA_GLOBAL_AUTOCONFIGURE_ENABLED}, as OpenTelemetry does. OpenTelemetry also reads a
   * property key in another letter case, and the source does not. That needs a scan of all the
   * system properties at each use.
   */
  static boolean autoConfigureEnabled() {
    try {
      String value = System.getProperty(AUTOCONFIGURE);
      if (value == null) {
        value = System.getProperty(AUTOCONFIGURE_DOTTED);
      }
      if (value == null) {
        value = System.getenv(AUTOCONFIGURE_VARIABLE);
      }
      return Boolean.parseBoolean(value);
    } catch (SecurityException denied) {
      return false;
    }
  }
}
