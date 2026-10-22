package run.workhorse.internal.telemetry;

import java.util.Map;
import org.jspecify.annotations.Nullable;

/**
 * Spans, metrics, log records, and W3C trace context for the queue and the worker. The counterpart
 * of Ruby's {@code Telemetry} module and Python's {@code _telemetry}.
 *
 * <p>No signature names an OpenTelemetry type, so the queue and the worker load without the
 * optional API. {@link #global} reads {@code GlobalOpenTelemetry} on each use when the API is on
 * the class path, and is {@link #NOOP} without it.
 */
public interface Telemetry {
  /** The instrumentation scope name of every tracer and meter. */
  String INSTRUMENTATION_NAME = "workhorse";

  /** The largest trace context PostgreSQL stores, in UTF-8 bytes of its JSON. */
  int MAX_TRACE_CONTEXT_BYTES = 1_024;

  /** The most attributes Workhorse sets on one span. */
  int TRACE_ATTRIBUTE_COUNT_LIMIT = 8;

  /** Telemetry that records nothing and loads no OpenTelemetry class. */
  Telemetry NOOP =
      new Telemetry() {
        @Override
        public @Nullable Map<String, String> injectTraceContext() {
          return null;
        }

        @Override
        public @Nullable Object currentContext() {
          return null;
        }

        @Override
        public TelemetrySpan span(
            String name,
            Map<String, ? extends @Nullable Object> attributes,
            @Nullable Object parent) {
          return TelemetrySpan.NOOP;
        }

        @Override
        public TelemetrySpan consumerSpan(
            String name,
            Map<String, ? extends @Nullable Object> attributes,
            @Nullable Object traceContext) {
          return TelemetrySpan.NOOP;
        }

        @Override
        public void add(
            Instrument instrument,
            double amount,
            Map<String, ? extends @Nullable Object> attributes) {}

        @Override
        public void record(
            Instrument instrument,
            double amount,
            Map<String, ? extends @Nullable Object> attributes) {}

        @Override
        public void log(
            Severity severity,
            String event,
            String body,
            Map<String, ? extends @Nullable Object> attributes) {}
      };

  /**
   * The severity of a log record, as the TypeScript {@code logDebug}, {@code logInfo}, and {@code
   * logWarn} set it.
   */
  enum Severity {
    DEBUG,
    INFO,
    WARN
  }

  /**
   * The telemetry of {@code GlobalOpenTelemetry} when the OpenTelemetry API is on the class path,
   * or {@link #NOOP}.
   */
  static Telemetry global() {
    return GlobalHolder.GLOBAL;
  }

  /**
   * The current W3C trace context as a carrier, or {@code null} without OpenTelemetry, without a
   * valid current span, or when PostgreSQL would measure its JSON as larger than {@link
   * #MAX_TRACE_CONTEXT_BYTES}.
   */
  @Nullable Map<String, String> injectTraceContext();

  /**
   * The OpenTelemetry context current on this thread, as an opaque value for {@link #span} on
   * another thread, or {@code null} without OpenTelemetry.
   */
  @Nullable Object currentContext();

  /**
   * Starts an internal span and makes it current on this thread. The parent is {@code parent}, from
   * {@link #currentContext}, or the current context when {@code parent} is {@code null}.
   */
  TelemetrySpan span(
      String name, Map<String, ? extends @Nullable Object> attributes, @Nullable Object parent);

  /** Starts an internal span whose parent is the current context. */
  default TelemetrySpan span(String name, Map<String, ? extends @Nullable Object> attributes) {
    return span(name, attributes, null);
  }

  /**
   * Starts a consumer span for a claimed task and makes it current on this thread.
   *
   * <p>A claimed task descends only from the trace that its enqueue stored. A span that is current
   * where the worker runs is unrelated to the task. So the parent is the stored {@code
   * traceContext} carrier, and a task without one starts a new trace.
   */
  TelemetrySpan consumerSpan(
      String name,
      Map<String, ? extends @Nullable Object> attributes,
      @Nullable Object traceContext);

  /** Adds {@code amount} to a counter. */
  void add(
      Instrument instrument, double amount, Map<String, ? extends @Nullable Object> attributes);

  /** Records {@code amount} in a histogram. */
  void record(
      Instrument instrument, double amount, Map<String, ? extends @Nullable Object> attributes);

  /**
   * Emits one log record in the current context, as the TypeScript OpenTelemetry adapter emits
   * {@code emitLog}. It sets the event name, the severity, the severity text, and the body. An
   * {@code event} that is not in {@link Names#LOG_EVENTS} emits nothing, because {@code
   * api/typescript.txt} governs the event names.
   */
  void log(
      Severity severity,
      String event,
      String body,
      Map<String, ? extends @Nullable Object> attributes);
}
