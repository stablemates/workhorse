package run.workhorse.internal.telemetry;

import io.opentelemetry.api.OpenTelemetry;
import io.opentelemetry.api.common.AttributeKey;
import io.opentelemetry.api.common.Attributes;
import io.opentelemetry.api.common.AttributesBuilder;
import io.opentelemetry.api.logs.Logger;
import io.opentelemetry.api.logs.LoggerBuilder;
import io.opentelemetry.api.metrics.DoubleCounter;
import io.opentelemetry.api.metrics.DoubleHistogram;
import io.opentelemetry.api.metrics.LongCounter;
import io.opentelemetry.api.metrics.Meter;
import io.opentelemetry.api.metrics.MeterBuilder;
import io.opentelemetry.api.trace.Span;
import io.opentelemetry.api.trace.SpanKind;
import io.opentelemetry.api.trace.StatusCode;
import io.opentelemetry.api.trace.Tracer;
import io.opentelemetry.api.trace.TracerBuilder;
import io.opentelemetry.api.trace.propagation.W3CTraceContextPropagator;
import io.opentelemetry.context.Context;
import io.opentelemetry.context.Scope;
import io.opentelemetry.context.propagation.TextMapGetter;
import io.opentelemetry.context.propagation.TextMapPropagator;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.function.Supplier;
import org.jspecify.annotations.Nullable;
import run.workhorse.internal.Json;
import run.workhorse.internal.SdkVersion;

/**
 * {@link Telemetry} on an OpenTelemetry instance. The only SDK class that names an OpenTelemetry
 * type. {@link GlobalHolder} and {@code WorkhorseTelemetry.of} load it only when the API is on the
 * class path.
 *
 * <p>The trace context is always W3C trace context, as {@code valid_trace_context_v1} requires, so
 * the propagator is {@link W3CTraceContextPropagator} and not the instance's propagators.
 */
public final class OpenTelemetryTelemetry implements Telemetry {
  private static final TextMapPropagator PROPAGATOR = W3CTraceContextPropagator.getInstance();
  private static final @Nullable String VERSION = SdkVersion.current();

  private static final TextMapGetter<Map<String, String>> GETTER =
      new TextMapGetter<>() {
        // 1.67.0 deprecates keys and gives it a default body, but it is abstract in the 1.55.0 API
        // of the Spring Boot 4.0 BOM. The override keeps the getter complete on that API.
        @Override
        @SuppressWarnings("deprecation")
        public Iterable<String> keys(Map<String, String> carrier) {
          return carrier.keySet();
        }

        @Override
        public @Nullable String get(@Nullable Map<String, String> carrier, String key) {
          return carrier == null ? null : carrier.get(key);
        }
      };

  private final Supplier<OpenTelemetry> source;
  // The tracer and the instruments of the instance that `source` returned last. A new global
  // instance replaces them, so a provider installed after the first span still receives data.
  private volatile @Nullable Bound bound;

  private OpenTelemetryTelemetry(Supplier<OpenTelemetry> source) {
    this.source = source;
  }

  /** Telemetry on {@code openTelemetry}. */
  public static Telemetry of(OpenTelemetry openTelemetry) {
    return new OpenTelemetryTelemetry(() -> openTelemetry);
  }

  /**
   * Telemetry that reads the current {@code GlobalOpenTelemetry} instance at each use, and installs
   * none. {@link GlobalSource} tells how.
   */
  static Telemetry global() {
    return new OpenTelemetryTelemetry(GlobalSource.of());
  }

  @Override
  public @Nullable Map<String, String> injectTraceContext() {
    Map<String, String> carrier = new LinkedHashMap<>();
    try {
      PROPAGATOR.inject(
          Context.current(),
          carrier,
          (map, key, value) -> {
            if (map != null) {
              map.put(key, value);
            }
          });
    } catch (RuntimeException ignored) {
      // The context storage or the current span failed. The task stores no trace context.
      return null;
    }
    if (!carrier.containsKey("traceparent")) {
      return null;
    }
    return storedBytes(carrier) <= MAX_TRACE_CONTEXT_BYTES ? Map.copyOf(carrier) : null;
  }

  /**
   * The UTF-8 size of {@code carrier} as {@code valid_trace_context_v1} measures it. PostgreSQL
   * measures the text of the {@code jsonb} value, which puts a space after each colon and after
   * each comma. Compact JSON has neither, and the string values need no other escape.
   */
  static int storedBytes(Map<String, String> carrier) {
    int compact = Json.write(carrier).getBytes(StandardCharsets.UTF_8).length;
    return compact + 2 * carrier.size() - 1;
  }

  @Override
  public @Nullable Object currentContext() {
    try {
      return Context.current();
    } catch (RuntimeException ignored) {
      // The context storage failed. A span on another thread then takes its current context.
      return null;
    }
  }

  @Override
  public TelemetrySpan span(
      String name, Map<String, ? extends @Nullable Object> attributes, @Nullable Object parent) {
    Context context;
    try {
      context = parent instanceof Context given ? given : Context.current();
    } catch (RuntimeException ignored) {
      // The context storage failed, and the operation runs without the span.
      return TelemetrySpan.NOOP;
    }
    return start(name, attributes, context, SpanKind.INTERNAL);
  }

  @Override
  public TelemetrySpan consumerSpan(
      String name,
      Map<String, ? extends @Nullable Object> attributes,
      @Nullable Object traceContext) {
    Context parent;
    try {
      parent = Context.root();
    } catch (RuntimeException ignored) {
      // The context storage failed, and the operation runs without the span.
      return TelemetrySpan.NOOP;
    }
    if (traceContext instanceof Map<?, ?> stored) {
      Map<String, String> carrier = new LinkedHashMap<>();
      for (Map.Entry<?, ?> entry : stored.entrySet()) {
        if (entry.getKey() instanceof String key && entry.getValue() instanceof String value) {
          carrier.put(key.toLowerCase(Locale.ROOT), value);
        }
      }
      try {
        parent = PROPAGATOR.extract(parent, carrier, GETTER);
      } catch (RuntimeException ignored) {
        // The stored context could not be read, so the task starts a new trace.
      }
    }
    return start(name, attributes, parent, SpanKind.CONSUMER);
  }

  @Override
  public void add(
      Instrument instrument, double amount, Map<String, ? extends @Nullable Object> attributes) {
    try {
      Object recorder = bound().instrument(instrument);
      Attributes values = attributes(attributes);
      if (recorder instanceof LongCounter counter) {
        counter.add((long) amount, values);
      } else if (recorder instanceof DoubleCounter counter) {
        counter.add(amount, values);
      }
    } catch (RuntimeException ignored) {
      // The provider or the instrument failed, and the measurement is lost. The operation that it
      // observes continues.
    }
  }

  @Override
  public void record(
      Instrument instrument, double amount, Map<String, ? extends @Nullable Object> attributes) {
    try {
      if (bound().instrument(instrument) instanceof DoubleHistogram histogram) {
        histogram.record(amount, attributes(attributes));
      }
    } catch (RuntimeException ignored) {
      // The provider or the instrument failed, and the measurement is lost.
    }
  }

  /**
   * {@inheritDoc}
   *
   * <p>The OpenTelemetry API 1.55.0 of the Spring Boot 4.0 BOM has no {@code Logger.isEnabled}, so
   * the call fails to link. Then each severity is enabled, and the logger of the SDK decides.
   */
  @Override
  public boolean logEnabled(Severity severity) {
    Bound current;
    try {
      current = bound();
    } catch (RuntimeException ignored) {
      // A provider that fails is a disabled logger.
      return false;
    }
    if (current.noIsEnabled) {
      return true;
    }
    try {
      return current.logger.isEnabled(severity(severity), Context.current());
    } catch (RuntimeException ignored) {
      // A logger that fails is a disabled logger.
      return false;
    } catch (LinkageError olderApi) {
      // A failed link fails again at each call, so the telemetry probes once.
      current.noIsEnabled = true;
      return true;
    }
  }

  @Override
  public void log(
      Severity severity,
      String event,
      String body,
      Map<String, ? extends @Nullable Object> attributes) {
    if (!Names.LOG_EVENTS.contains(event)) {
      return;
    }
    try {
      bound()
          .logger
          .logRecordBuilder()
          .setContext(Context.current())
          .setSeverity(severity(severity))
          .setSeverityText(severity.name())
          .setEventName(event)
          .setBody(body)
          .setAllAttributes(attributes(attributes))
          .emit();
    } catch (RuntimeException ignored) {
      // The logger failed, and the record is lost. The operation that it observes continues.
    }
  }

  private static io.opentelemetry.api.logs.Severity severity(Severity severity) {
    return switch (severity) {
      case DEBUG -> io.opentelemetry.api.logs.Severity.DEBUG;
      case INFO -> io.opentelemetry.api.logs.Severity.INFO;
      case WARN -> io.opentelemetry.api.logs.Severity.WARN;
    };
  }

  // The returned span owns the scope and closes it in `close`. A provider or a tracer that fails
  // gives the no-op span, so the operation in the span runs without it.
  @SuppressWarnings("MustBeClosedChecker")
  private TelemetrySpan start(
      String name,
      Map<String, ? extends @Nullable Object> attributes,
      Context parent,
      SpanKind kind) {
    Span span;
    try {
      span =
          bound()
              .tracer
              .spanBuilder(name)
              .setParent(parent)
              .setSpanKind(kind)
              .setAllAttributes(attributes(attributes))
              .startSpan();
    } catch (RuntimeException ignored) {
      return TelemetrySpan.NOOP;
    }
    try {
      Scope scope = parent.with(span).makeCurrent();
      return new OpenTelemetrySpan(span, scope);
    } catch (RuntimeException ignored) {
      end(span);
      return TelemetrySpan.NOOP;
    }
  }

  private static void end(Span span) {
    try {
      span.end();
    } catch (RuntimeException ignored) {
      // A span processor failed, and the span is lost. The operation in the span continues.
    }
  }

  // A new instance is a new identity. Two equal instances still need their own instruments.
  @SuppressWarnings("ReferenceEquality")
  private Bound bound() {
    OpenTelemetry openTelemetry = source.get();
    Bound current = bound;
    if (current == null || current.openTelemetry != openTelemetry) {
      current = new Bound(openTelemetry);
      bound = current;
    }
    return current;
  }

  private static Attributes attributes(Map<String, ? extends @Nullable Object> values) {
    AttributesBuilder builder = Attributes.builder();
    for (Map.Entry<String, ? extends @Nullable Object> entry : values.entrySet()) {
      put(builder, entry.getKey(), entry.getValue());
    }
    return builder.build();
  }

  private static void put(AttributesBuilder builder, String key, @Nullable Object value) {
    if (value == null) {
      return;
    }
    if (value instanceof Boolean flag) {
      builder.put(key, flag);
    } else if (value instanceof Double || value instanceof Float) {
      builder.put(key, ((Number) value).doubleValue());
    } else if (value instanceof Number number) {
      builder.put(key, number.longValue());
    } else if (value instanceof List<?> list) {
      // A list is a string array, as the TypeScript `workhorse.worker.queues` value is.
      List<String> strings = new ArrayList<>(list.size());
      for (Object item : list) {
        strings.add(String.valueOf(item));
      }
      builder.put(AttributeKey.stringArrayKey(key), strings);
    } else {
      builder.put(key, value.toString());
    }
  }

  /** The tracer, the logger, and the lazily created instruments of one OpenTelemetry instance. */
  private static final class Bound {
    final OpenTelemetry openTelemetry;
    final Tracer tracer;
    final Logger logger;
    private final Meter meter;
    private final Map<Instrument, Object> instruments = new ConcurrentHashMap<>();
    // True after `Logger.isEnabled` failed to link.
    volatile boolean noIsEnabled;

    Bound(OpenTelemetry openTelemetry) {
      this.openTelemetry = openTelemetry;
      TracerBuilder tracers = openTelemetry.getTracerProvider().tracerBuilder(INSTRUMENTATION_NAME);
      MeterBuilder meters = openTelemetry.getMeterProvider().meterBuilder(INSTRUMENTATION_NAME);
      LoggerBuilder loggers = openTelemetry.getLogsBridge().loggerBuilder(INSTRUMENTATION_NAME);
      if (VERSION != null) {
        tracers.setInstrumentationVersion(VERSION);
        meters.setInstrumentationVersion(VERSION);
        loggers.setInstrumentationVersion(VERSION);
      }
      this.tracer = tracers.build();
      this.meter = meters.build();
      this.logger = loggers.build();
    }

    Object instrument(Instrument instrument) {
      return instruments.computeIfAbsent(instrument, this::create);
    }

    private Object create(Instrument instrument) {
      String name = instrument.instrumentName();
      return switch (instrument.kind()) {
        case COUNTER ->
            meter
                .counterBuilder(name)
                .setUnit(instrument.unit())
                .setDescription(instrument.description())
                .build();
        case DOUBLE_COUNTER ->
            meter
                .counterBuilder(name)
                .ofDoubles()
                .setUnit(instrument.unit())
                .setDescription(instrument.description())
                .build();
        case HISTOGRAM ->
            meter
                .histogramBuilder(name)
                .setUnit(instrument.unit())
                .setDescription(instrument.description())
                .build();
      };
    }
  }

  /** One started span and the scope that makes it current. */
  private static final class OpenTelemetrySpan implements TelemetrySpan {
    private final Span span;
    private final Scope scope;

    OpenTelemetrySpan(Span span, Scope scope) {
      this.span = span;
      this.scope = scope;
    }

    @Override
    public void setAttribute(String key, @Nullable Object value) {
      if (value == null) {
        return;
      }
      try {
        AttributesBuilder builder = Attributes.builder();
        put(builder, key, value);
        span.setAllAttributes(builder.build());
      } catch (RuntimeException ignored) {
        // The span failed, and the attribute is lost.
      }
    }

    @Override
    public void recordError(String errorType) {
      try {
        span.setStatus(StatusCode.ERROR);
        span.addEvent(
            "exception",
            Attributes.builder()
                .put("exception.type", errorType)
                .put("exception.escaped", false)
                .build());
      } catch (RuntimeException ignored) {
        // The span failed, and the error status is lost.
      }
    }

    @Override
    public void close() {
      try {
        scope.close();
      } catch (RuntimeException ignored) {
        // The context storage failed. The span still ends.
      } finally {
        end(span);
      }
    }
  }
}
