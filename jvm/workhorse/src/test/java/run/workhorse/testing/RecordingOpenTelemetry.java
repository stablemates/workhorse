package run.workhorse.testing;

import static org.junit.jupiter.api.Assertions.assertTrue;

import io.opentelemetry.api.common.AttributeKey;
import io.opentelemetry.sdk.OpenTelemetrySdk;
import io.opentelemetry.sdk.logs.SdkLoggerProvider;
import io.opentelemetry.sdk.logs.data.LogRecordData;
import io.opentelemetry.sdk.logs.export.SimpleLogRecordProcessor;
import io.opentelemetry.sdk.metrics.SdkMeterProvider;
import io.opentelemetry.sdk.metrics.data.MetricData;
import io.opentelemetry.sdk.testing.exporter.InMemoryLogRecordExporter;
import io.opentelemetry.sdk.testing.exporter.InMemoryMetricReader;
import io.opentelemetry.sdk.testing.exporter.InMemorySpanExporter;
import io.opentelemetry.sdk.trace.SdkTracerProvider;
import io.opentelemetry.sdk.trace.data.SpanData;
import io.opentelemetry.sdk.trace.export.SimpleSpanProcessor;
import java.util.Collection;
import java.util.List;
import run.workhorse.internal.telemetry.Names;

/**
 * An OpenTelemetry SDK that keeps every finished span, every metric, and every log record in
 * memory, so a test can read what the Java SDK emitted. The counterpart of Ruby's recording tracer
 * provider.
 */
public final class RecordingOpenTelemetry implements AutoCloseable {
  private final InMemorySpanExporter spans = InMemorySpanExporter.create();
  private final InMemoryMetricReader metrics = InMemoryMetricReader.create();
  private final InMemoryLogRecordExporter logs = InMemoryLogRecordExporter.create();
  private final OpenTelemetrySdk sdk =
      OpenTelemetrySdk.builder()
          .setTracerProvider(
              SdkTracerProvider.builder()
                  .addSpanProcessor(SimpleSpanProcessor.create(spans))
                  .build())
          .setMeterProvider(SdkMeterProvider.builder().registerMetricReader(metrics).build())
          .setLoggerProvider(
              SdkLoggerProvider.builder()
                  .addLogRecordProcessor(SimpleLogRecordProcessor.create(logs))
                  .build())
          .build();

  /** The SDK instance. */
  public OpenTelemetrySdk sdk() {
    return sdk;
  }

  /** The finished spans, oldest first. */
  public List<SpanData> spans() {
    return spans.getFinishedSpanItems();
  }

  /** The finished spans named {@code name}. */
  public List<SpanData> spans(String name) {
    return spans().stream().filter(span -> span.getName().equals(name)).toList();
  }

  /** The emitted log records, oldest first. */
  public List<LogRecordData> logs() {
    return logs.getFinishedLogRecordItems();
  }

  /** The emitted log records with the event name {@code event}. */
  public List<LogRecordData> logs(String event) {
    return logs().stream().filter(log -> event.equals(log.getEventName())).toList();
  }

  /** The metrics recorded so far. */
  public Collection<MetricData> metrics() {
    return metrics.collectAllMetrics();
  }

  /**
   * Checks that each recorded span name, span attribute, instrument, metric attribute, and log
   * record attribute that starts with {@code workhorse.} is in {@code api/telemetry.txt}, that each
   * log record has a TypeScript event name, and that no span carries more than {@code limit}
   * attributes.
   */
  public void assertGoverned(int limit) {
    TelemetrySurface surface = TelemetrySurface.read();
    for (SpanData span : spans()) {
      if (span.getName().startsWith("workhorse.")) {
        assertTrue(surface.spans().contains(span.getName()), span.getName() + " is not governed");
        assertTrue(
            span.getAttributes().size() <= limit,
            span.getName() + " carries " + span.getAttributes().size() + " attributes");
      }
      for (AttributeKey<?> key : span.getAttributes().asMap().keySet()) {
        assertGovernedAttribute(surface, key.getKey());
      }
    }
    for (MetricData metric : metrics()) {
      assertTrue(
          surface.instruments().containsKey(metric.getName()),
          metric.getName() + " is not governed");
      metric.getData().getPoints().stream()
          .flatMap(point -> point.getAttributes().asMap().keySet().stream())
          .forEach(key -> assertGovernedAttribute(surface, key.getKey()));
    }
    for (LogRecordData log : logs()) {
      assertTrue(
          Names.LOG_EVENTS.contains(log.getEventName()), log.getEventName() + " is not governed");
      for (AttributeKey<?> key : log.getAttributes().asMap().keySet()) {
        assertGovernedAttribute(surface, key.getKey());
      }
    }
  }

  private static void assertGovernedAttribute(TelemetrySurface surface, String key) {
    if (key.startsWith("workhorse.")) {
      assertTrue(surface.attributes().contains(key), key + " is not a governed attribute");
    }
  }

  @Override
  public void close() {
    sdk.close();
  }
}
