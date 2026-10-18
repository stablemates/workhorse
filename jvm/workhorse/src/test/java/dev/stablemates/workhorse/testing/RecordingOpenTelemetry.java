package dev.stablemates.workhorse.testing;

import static org.junit.jupiter.api.Assertions.assertTrue;

import io.opentelemetry.api.common.AttributeKey;
import io.opentelemetry.sdk.OpenTelemetrySdk;
import io.opentelemetry.sdk.metrics.SdkMeterProvider;
import io.opentelemetry.sdk.metrics.data.MetricData;
import io.opentelemetry.sdk.testing.exporter.InMemoryMetricReader;
import io.opentelemetry.sdk.testing.exporter.InMemorySpanExporter;
import io.opentelemetry.sdk.trace.SdkTracerProvider;
import io.opentelemetry.sdk.trace.data.SpanData;
import io.opentelemetry.sdk.trace.export.SimpleSpanProcessor;
import java.util.Collection;
import java.util.List;

/**
 * An OpenTelemetry SDK that keeps every finished span and every metric in memory, so a test can
 * read what the Java SDK emitted. The counterpart of Ruby's recording tracer provider.
 */
public final class RecordingOpenTelemetry implements AutoCloseable {
  private final InMemorySpanExporter spans = InMemorySpanExporter.create();
  private final InMemoryMetricReader metrics = InMemoryMetricReader.create();
  private final OpenTelemetrySdk sdk =
      OpenTelemetrySdk.builder()
          .setTracerProvider(
              SdkTracerProvider.builder()
                  .addSpanProcessor(SimpleSpanProcessor.create(spans))
                  .build())
          .setMeterProvider(SdkMeterProvider.builder().registerMetricReader(metrics).build())
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

  /** The metrics recorded so far. */
  public Collection<MetricData> metrics() {
    return metrics.collectAllMetrics();
  }

  /**
   * Checks that each recorded span name, span attribute, instrument, and metric attribute that
   * starts with {@code workhorse.} is in {@code api/telemetry.txt}, and that no span carries more
   * than {@code limit} attributes.
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
