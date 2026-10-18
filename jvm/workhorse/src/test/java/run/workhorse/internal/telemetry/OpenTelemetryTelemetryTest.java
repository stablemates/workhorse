package run.workhorse.internal.telemetry;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import io.opentelemetry.api.OpenTelemetry;
import io.opentelemetry.api.common.AttributeKey;
import io.opentelemetry.api.trace.Span;
import io.opentelemetry.api.trace.SpanKind;
import io.opentelemetry.api.trace.StatusCode;
import io.opentelemetry.context.Scope;
import io.opentelemetry.sdk.metrics.data.MetricData;
import io.opentelemetry.sdk.trace.data.SpanData;
import java.util.Map;
import org.jspecify.annotations.Nullable;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import run.workhorse.internal.SdkVersion;
import run.workhorse.testing.RecordingOpenTelemetry;
import run.workhorse.testing.WithoutVersionResource;

/** The OpenTelemetry backend without PostgreSQL: trace context, span parents, and instruments. */
// A scope only makes a span current, so a try block never reads it.
@SuppressWarnings("try")
class OpenTelemetryTelemetryTest {
  private final RecordingOpenTelemetry recording = new RecordingOpenTelemetry();
  private final Telemetry telemetry = OpenTelemetryTelemetry.of(recording.sdk());

  @AfterEach
  void close() {
    recording.close();
  }

  @Test
  void injectsTheW3cTraceContextOfTheCurrentSpan() {
    Span caller = recording.sdk().getTracer("caller").spanBuilder("caller").startSpan();
    Map<String, String> carrier;
    try (Scope ignored = caller.makeCurrent()) {
      carrier = telemetry.injectTraceContext();
    } finally {
      caller.end();
    }
    assertNotNull(carrier);
    assertEquals(
        "00-"
            + caller.getSpanContext().getTraceId()
            + "-"
            + caller.getSpanContext().getSpanId()
            + "-01",
        carrier.get("traceparent"));
  }

  @Test
  void injectsNothingWithoutAValidCurrentSpan() {
    assertNull(telemetry.injectTraceContext());
    assertNull(OpenTelemetryTelemetry.of(OpenTelemetry.noop()).injectTraceContext());
  }

  @Test
  void continuesTheStoredTraceInAConsumerSpanAndIgnoresTheCurrentSpan() {
    String traceId = "4bf92f3577b34da6a3ce929d0e0e4736";
    String parentId = "00f067aa0ba902b7";
    Span unrelated = recording.sdk().getTracer("caller").spanBuilder("unrelated").startSpan();
    try (Scope ignored = unrelated.makeCurrent();
        TelemetrySpan span =
            telemetry.consumerSpan(
                Names.SPAN_HANDLER,
                Map.of(Names.TASK_TYPE, "email.send"),
                Map.of("TraceParent", "00-" + traceId + "-" + parentId + "-01", "other", 1L))) {
      span.setAttribute(Names.TASK_ATTEMPT, 2);
    } finally {
      unrelated.end();
    }
    SpanData handler = recording.spans(Names.SPAN_HANDLER).get(0);
    assertEquals(SpanKind.CONSUMER, handler.getKind());
    assertEquals(traceId, handler.getTraceId());
    assertEquals(parentId, handler.getParentSpanId());
    assertEquals(2L, handler.getAttributes().get(AttributeKey.longKey(Names.TASK_ATTEMPT)));
  }

  @Test
  void startsANewTraceForATaskWithoutAStoredContext() {
    Span unrelated = recording.sdk().getTracer("caller").spanBuilder("unrelated").startSpan();
    try (Scope ignored = unrelated.makeCurrent();
        TelemetrySpan span = telemetry.consumerSpan(Names.SPAN_HANDLER, Map.of(), null)) {
      assertNotNull(span);
    } finally {
      unrelated.end();
    }
    SpanData handler = recording.spans(Names.SPAN_HANDLER).get(0);
    assertFalse(handler.getParentSpanContext().isValid());
    assertTrue(!handler.getTraceId().equals(unrelated.getSpanContext().getTraceId()));
  }

  @Test
  void makesASpanCurrentUntilItCloses() {
    Map<String, String> inside;
    try (TelemetrySpan span = telemetry.span(Names.SPAN_ENQUEUE, Map.of())) {
      assertNotNull(span);
      inside = telemetry.injectTraceContext();
    }
    assertNull(telemetry.injectTraceContext(), "the span is no longer current");
    SpanData enqueue = recording.spans(Names.SPAN_ENQUEUE).get(0);
    assertEquals(SpanKind.INTERNAL, enqueue.getKind());
    assertNotNull(inside);
    assertTrue(inside.get("traceparent").contains(enqueue.getSpanId()));
  }

  @Test
  void parentsASpanOnAContextFromAnotherThread() throws InterruptedException {
    Object[] parent = new Object[1];
    try (TelemetrySpan span = telemetry.span(Names.SPAN_HANDLER, Map.of())) {
      assertNotNull(span);
      parent[0] = telemetry.currentContext();
    }
    Thread thread =
        Thread.ofVirtual()
            .start(
                () -> {
                  try (TelemetrySpan retry =
                      telemetry.span(Names.SPAN_RETRY, Map.of(), parent[0])) {
                    retry.setAttribute(Names.RETRY_OUTCOME, "ready");
                  }
                });
    thread.join();
    assertEquals(
        recording.spans(Names.SPAN_HANDLER).get(0).getSpanId(),
        recording.spans(Names.SPAN_RETRY).get(0).getParentSpanId());
  }

  @Test
  void recordsAnErrorAsTheStatusAndOneExceptionEvent() {
    try (TelemetrySpan span = telemetry.span(Names.SPAN_COMPLETE, Map.of())) {
      span.recordError("LeaseLostException");
    }
    SpanData complete = recording.spans(Names.SPAN_COMPLETE).get(0);
    assertEquals(StatusCode.ERROR, complete.getStatus().getStatusCode());
    assertEquals("exception", complete.getEvents().get(0).getName());
    assertEquals(
        "LeaseLostException",
        complete.getEvents().get(0).getAttributes().get(AttributeKey.stringKey("exception.type")));
  }

  @Test
  void keepsTheTypeOfEachAttributeValue() {
    Map<String, @Nullable Object> attributes = new java.util.LinkedHashMap<>();
    attributes.put(Names.COMPLETE_ACCEPTED, true);
    attributes.put(Names.TASK_ATTEMPT, 3);
    attributes.put(
        Names.TASK_ID, java.util.UUID.fromString("00000000-0000-0000-0000-000000000001"));
    attributes.put(Names.QUEUE_NAME, null);
    try (TelemetrySpan span = telemetry.span(Names.SPAN_COMPLETE, attributes)) {
      span.setAttribute(Names.QUEUE_TIER, null);
    }
    SpanData complete = recording.spans(Names.SPAN_COMPLETE).get(0);
    assertEquals(
        true, complete.getAttributes().get(AttributeKey.booleanKey(Names.COMPLETE_ACCEPTED)));
    assertEquals(3L, complete.getAttributes().get(AttributeKey.longKey(Names.TASK_ATTEMPT)));
    assertEquals(
        "00000000-0000-0000-0000-000000000001",
        complete.getAttributes().get(AttributeKey.stringKey(Names.TASK_ID)));
    assertEquals(3, complete.getAttributes().size());
  }

  @Test
  void recordsEachInstrumentWithItsKindAndUnit() {
    Map<String, Object> attributes = Map.of(Names.QUEUE_NAME, "emails");
    for (Instrument instrument : Instrument.values()) {
      if (instrument.kind() == Instrument.Kind.HISTOGRAM) {
        telemetry.record(instrument, 1.5, attributes);
      } else {
        telemetry.add(instrument, 2, attributes);
      }
    }
    Map<String, MetricData> metrics = new java.util.HashMap<>();
    for (MetricData metric : recording.metrics()) {
      metrics.put(metric.getName(), metric);
    }
    for (Instrument instrument : Instrument.values()) {
      MetricData metric = metrics.get(instrument.instrumentName());
      assertNotNull(metric, instrument.instrumentName());
      assertEquals(instrument.unit(), metric.getUnit());
      assertEquals(instrument.description(), metric.getDescription());
      assertEquals("workhorse", metric.getInstrumentationScopeInfo().getName());
    }
    assertEquals(
        2L,
        metrics
            .get("workhorse.tasks.claimed")
            .getLongSumData()
            .getPoints()
            .iterator()
            .next()
            .getValue());
    assertEquals(
        2.0,
        metrics
            .get("workhorse.handler.runtime")
            .getDoubleSumData()
            .getPoints()
            .iterator()
            .next()
            .getValue());
    recording.assertGoverned(Telemetry.TRACE_ATTRIBUTE_COUNT_LIMIT);
  }

  @Test
  void namesTheSdkVersionAsTheInstrumentationVersion() {
    assertNotNull(SdkVersion.current());
    recordOneSpanAndOneMetric(telemetry);
    assertEquals(
        SdkVersion.current(),
        recording.spans(Names.SPAN_ENQUEUE).get(0).getInstrumentationScopeInfo().getVersion());
    for (MetricData metric : recording.metrics()) {
      assertEquals(SdkVersion.current(), metric.getInstrumentationScopeInfo().getVersion());
    }
  }

  @Test
  void namesNoInstrumentationVersionWithoutTheVersionResource() throws Exception {
    try (WithoutVersionResource loader = new WithoutVersionResource()) {
      assertNull(loader.getResource(WithoutVersionResource.RESOURCE));
      Class<?> backend = loader.sdkClass(OpenTelemetryTelemetry.class.getName());
      Object hidden = backend.getMethod("of", OpenTelemetry.class).invoke(null, recording.sdk());
      Class<?> telemetryType = loader.sdkClass(Telemetry.class.getName());
      Class<?> instrumentType = loader.sdkClass(Instrument.class.getName());
      Object claimed = instrumentType.getField(Instrument.TASKS_CLAIMED.name()).get(null);
      try (AutoCloseable span =
          (AutoCloseable)
              telemetryType
                  .getMethod("span", String.class, Map.class)
                  .invoke(hidden, Names.SPAN_ENQUEUE, Map.of())) {
        telemetryType
            .getMethod("add", instrumentType, double.class, Map.class)
            .invoke(hidden, claimed, 1.0, Map.of());
      }
    }
    assertNull(
        recording.spans(Names.SPAN_ENQUEUE).get(0).getInstrumentationScopeInfo().getVersion());
    assertFalse(recording.metrics().isEmpty());
    for (MetricData metric : recording.metrics()) {
      assertNull(metric.getInstrumentationScopeInfo().getVersion());
    }
  }

  private static void recordOneSpanAndOneMetric(Telemetry telemetry) {
    try (TelemetrySpan span = telemetry.span(Names.SPAN_ENQUEUE, Map.of())) {
      telemetry.add(Instrument.TASKS_CLAIMED, 1, Map.of());
    }
  }

  @Test
  void theNoopTelemetryRecordsNothing() {
    try (TelemetrySpan span = Telemetry.NOOP.span(Names.SPAN_ENQUEUE, Map.of())) {
      span.setAttribute(Names.TASK_ID, "x");
      span.recordError("Error");
    }
    Telemetry.NOOP.add(Instrument.TASKS_CLAIMED, 1, Map.of());
    assertNull(Telemetry.NOOP.injectTraceContext());
    assertNull(Telemetry.NOOP.currentContext());
    assertTrue(recording.spans().isEmpty());
  }
}
