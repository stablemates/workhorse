package run.workhorse.internal.telemetry;

import io.opentelemetry.api.GlobalOpenTelemetry;
import io.opentelemetry.api.OpenTelemetry;
import io.opentelemetry.api.common.Attributes;
import io.opentelemetry.api.common.AttributesBuilder;
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
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.util.LinkedHashMap;
import java.util.Locale;
import java.util.Map;
import java.util.Properties;
import java.util.concurrent.ConcurrentHashMap;
import java.util.function.Supplier;
import org.jspecify.annotations.Nullable;
import run.workhorse.internal.Json;

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
  private static final @Nullable String VERSION = version();

  private static final TextMapGetter<Map<String, String>> GETTER =
      new TextMapGetter<>() {
        @Override
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

  /** Telemetry that reads {@code GlobalOpenTelemetry} on each use. */
  static Telemetry global() {
    return new OpenTelemetryTelemetry(GlobalOpenTelemetry::get);
  }

  @Override
  public @Nullable Map<String, String> injectTraceContext() {
    Map<String, String> carrier = new LinkedHashMap<>();
    PROPAGATOR.inject(
        Context.current(),
        carrier,
        (map, key, value) -> {
          if (map != null) {
            map.put(key, value);
          }
        });
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
  public Object currentContext() {
    return Context.current();
  }

  @Override
  public TelemetrySpan span(
      String name, Map<String, ? extends @Nullable Object> attributes, @Nullable Object parent) {
    Context context = parent instanceof Context given ? given : Context.current();
    return start(name, attributes, context, SpanKind.INTERNAL);
  }

  @Override
  public TelemetrySpan consumerSpan(
      String name,
      Map<String, ? extends @Nullable Object> attributes,
      @Nullable Object traceContext) {
    Context parent = Context.root();
    if (traceContext instanceof Map<?, ?> stored) {
      Map<String, String> carrier = new LinkedHashMap<>();
      for (Map.Entry<?, ?> entry : stored.entrySet()) {
        if (entry.getKey() instanceof String key && entry.getValue() instanceof String value) {
          carrier.put(key.toLowerCase(Locale.ROOT), value);
        }
      }
      parent = PROPAGATOR.extract(Context.root(), carrier, GETTER);
    }
    return start(name, attributes, parent, SpanKind.CONSUMER);
  }

  @Override
  public void add(
      Instrument instrument, double amount, Map<String, ? extends @Nullable Object> attributes) {
    Object recorder = bound().instrument(instrument);
    Attributes values = attributes(attributes);
    if (recorder instanceof LongCounter counter) {
      counter.add((long) amount, values);
    } else if (recorder instanceof DoubleCounter counter) {
      counter.add(amount, values);
    }
  }

  @Override
  public void record(
      Instrument instrument, double amount, Map<String, ? extends @Nullable Object> attributes) {
    if (bound().instrument(instrument) instanceof DoubleHistogram histogram) {
      histogram.record(amount, attributes(attributes));
    }
  }

  // The returned span owns the scope and closes it in `close`.
  @SuppressWarnings("MustBeClosedChecker")
  private TelemetrySpan start(
      String name,
      Map<String, ? extends @Nullable Object> attributes,
      Context parent,
      SpanKind kind) {
    Span span =
        bound()
            .tracer
            .spanBuilder(name)
            .setParent(parent)
            .setSpanKind(kind)
            .setAllAttributes(attributes(attributes))
            .startSpan();
    Scope scope = parent.with(span).makeCurrent();
    return new OpenTelemetrySpan(span, scope);
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
    } else {
      builder.put(key, value.toString());
    }
  }

  /** The SDK version that the build writes into {@code version.properties}, or {@code null}. */
  private static @Nullable String version() {
    try (InputStream stream =
        OpenTelemetryTelemetry.class.getResourceAsStream("/run/workhorse/version.properties")) {
      if (stream == null) {
        return null;
      }
      Properties properties = new Properties();
      properties.load(new InputStreamReader(stream, StandardCharsets.UTF_8));
      String version = properties.getProperty("version", "").trim();
      return version.isEmpty() ? null : version;
    } catch (IOException error) {
      return null;
    }
  }

  /** The tracer and the lazily created instruments of one OpenTelemetry instance. */
  private static final class Bound {
    final OpenTelemetry openTelemetry;
    final Tracer tracer;
    private final Meter meter;
    private final Map<Instrument, Object> instruments = new ConcurrentHashMap<>();

    Bound(OpenTelemetry openTelemetry) {
      this.openTelemetry = openTelemetry;
      TracerBuilder tracers = openTelemetry.getTracerProvider().tracerBuilder(INSTRUMENTATION_NAME);
      MeterBuilder meters = openTelemetry.getMeterProvider().meterBuilder(INSTRUMENTATION_NAME);
      if (VERSION != null) {
        tracers.setInstrumentationVersion(VERSION);
        meters.setInstrumentationVersion(VERSION);
      }
      this.tracer = tracers.build();
      this.meter = meters.build();
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
      AttributesBuilder builder = Attributes.builder();
      put(builder, key, value);
      span.setAllAttributes(builder.build());
    }

    @Override
    public void recordError(String errorType) {
      span.setStatus(StatusCode.ERROR);
      span.addEvent(
          "exception",
          Attributes.builder()
              .put("exception.type", errorType)
              .put("exception.escaped", false)
              .build());
    }

    @Override
    public void close() {
      try {
        scope.close();
      } finally {
        span.end();
      }
    }
  }
}
