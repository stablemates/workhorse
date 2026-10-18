package run.workhorse;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import io.opentelemetry.api.GlobalOpenTelemetry;
import io.opentelemetry.api.OpenTelemetry;
import io.opentelemetry.api.common.AttributeKey;
import io.opentelemetry.api.trace.Span;
import io.opentelemetry.api.trace.SpanContext;
import io.opentelemetry.api.trace.StatusCode;
import io.opentelemetry.api.trace.TraceFlags;
import io.opentelemetry.api.trace.TraceState;
import io.opentelemetry.api.trace.TraceStateBuilder;
import io.opentelemetry.context.Context;
import io.opentelemetry.context.Scope;
import io.opentelemetry.sdk.trace.data.SpanData;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.jspecify.annotations.Nullable;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import run.workhorse.internal.Json;
import run.workhorse.internal.telemetry.Names;
import run.workhorse.internal.telemetry.Telemetry;
import run.workhorse.testing.RecordingOpenTelemetry;
import run.workhorse.testing.ScratchDataSource;
import run.workhorse.testing.ScratchDatabase;

/**
 * The queue's enqueue span and the trace context it stores, against PostgreSQL. The client row
 * "Enqueue trace-context propagation" of parity.
 */
// A scope only makes a span current, so a try block never reads it.
@SuppressWarnings("try")
@ExtendWith(ScratchDatabase.class)
class QueueTelemetryDatabaseTest {
  private final ScratchDataSource dataSource = new ScratchDataSource(true);
  private final RecordingOpenTelemetry recording = new RecordingOpenTelemetry();
  private final Queue queue =
      new Queue(
          ConnectionSource.of(dataSource),
          QueueOptions.builder().telemetry(WorkhorseTelemetry.of(recording.sdk())).build());
  private final String queueName = "telemetry-" + UUID.randomUUID();

  @AfterEach
  void close() {
    recording.close();
  }

  private static @Nullable Object storedTraceContext(UUID taskId) throws SQLException {
    try (Connection connection = ScratchDatabase.connect();
        PreparedStatement statement =
            connection.prepareStatement(
                "SELECT trace_context::text FROM workhorse.task WHERE id = ?")) {
      statement.setObject(1, taskId);
      try (ResultSet result = statement.executeQuery()) {
        assertTrue(result.next());
        String text = result.getString(1);
        return text == null ? null : Json.parse(text);
      }
    }
  }

  private EnqueueOptions options() {
    return EnqueueOptions.builder().queue(queueName).build();
  }

  @Test
  void storesTheEnqueueSpanOfTheCallersTraceAsTheTaskTraceContext() throws SQLException {
    Span caller = recording.sdk().getTracer("caller").spanBuilder("caller").startSpan();
    EnqueueResult result;
    try (Scope ignored = caller.makeCurrent()) {
      result = queue.enqueue("email.send", Map.of(), options());
    } finally {
      caller.end();
    }
    SpanData enqueue = recording.spans(Names.SPAN_ENQUEUE).get(0);
    assertEquals(caller.getSpanContext().getTraceId(), enqueue.getTraceId());
    assertEquals(caller.getSpanContext().getSpanId(), enqueue.getParentSpanId());
    assertEquals(
        Map.of(
            "traceparent",
            "00-"
                + enqueue.getTraceId()
                + "-"
                + enqueue.getSpanId()
                + "-"
                + enqueue.getSpanContext().getTraceFlags().asHex()),
        storedTraceContext(result.taskId()));
    assertEquals(queueName, enqueue.getAttributes().get(AttributeKey.stringKey(Names.QUEUE_NAME)));
    assertEquals(
        "email.send", enqueue.getAttributes().get(AttributeKey.stringKey(Names.TASK_TYPE)));
    assertEquals(1L, enqueue.getAttributes().get(AttributeKey.longKey(Names.ENQUEUE_COUNT)));
    assertEquals(
        result.taskId().toString(),
        enqueue.getAttributes().get(AttributeKey.stringKey(Names.TASK_ID)));
    assertEquals(
        "accepted", enqueue.getAttributes().get(AttributeKey.stringKey(Names.ENQUEUE_OUTCOME)));
    recording.assertGoverned(Telemetry.TRACE_ATTRIBUTE_COUNT_LIMIT);
  }

  @Test
  void namesNeitherQueueNorTypeForABatchThatSpansQueues() throws SQLException {
    List<EnqueueResult> results =
        queue.enqueueMany(
            List.of(
                EnqueueRequest.of("a", null, options()),
                EnqueueRequest.of(
                    "b", null, EnqueueOptions.builder().queue(queueName + "-2").build())));
    SpanData enqueue = recording.spans(Names.SPAN_ENQUEUE).get(0);
    assertEquals(2L, enqueue.getAttributes().get(AttributeKey.longKey(Names.ENQUEUE_COUNT)));
    assertNull(enqueue.getAttributes().get(AttributeKey.stringKey(Names.QUEUE_NAME)));
    assertNull(enqueue.getAttributes().get(AttributeKey.stringKey(Names.TASK_TYPE)));
    assertNull(enqueue.getAttributes().get(AttributeKey.stringKey(Names.TASK_ID)));
    for (EnqueueResult result : results) {
      assertNotNull(storedTraceContext(result.taskId()), "each task carries the trace context");
    }
  }

  @Test
  void marksTheEnqueueSpanFailedWhenTheEnqueueThrows() {
    assertThrows(
        IllegalArgumentException.class,
        () ->
            queue.enqueue(
                "email.send",
                Map.of(),
                EnqueueOptions.builder().queue(queueName).maxAttempts(101).build()));
    SpanData enqueue = recording.spans(Names.SPAN_ENQUEUE).get(0);
    assertEquals(StatusCode.ERROR, enqueue.getStatus().getStatusCode());
    assertEquals(
        "IllegalArgumentException",
        enqueue.getEvents().get(0).getAttributes().get(AttributeKey.stringKey("exception.type")));
  }

  /** A caller span whose trace state is {@code length} characters: four entries {@code kN=v...}. */
  private Span callerWithTraceState(int length) {
    TraceStateBuilder state = TraceState.builder();
    int values = length - 15;
    for (int index = 0; index < 4; index++) {
      state.put("k" + index, "v".repeat(values / 4 + (index < values % 4 ? 1 : 0)));
    }
    SpanContext parent =
        SpanContext.create(
            "4bf92f3577b34da6a3ce929d0e0e4736",
            "00f067aa0ba902b7",
            TraceFlags.getSampled(),
            state.build());
    return recording
        .sdk()
        .getTracer("caller")
        .spanBuilder("caller")
        .setParent(Context.root().with(Span.wrap(parent)))
        .startSpan();
  }

  /** The bytes that {@code valid_trace_context_v1} measures for a carrier. */
  private static long postgresBytes(String traceparent, String tracestate) throws SQLException {
    try (Connection connection = ScratchDatabase.connect();
        PreparedStatement statement =
            connection.prepareStatement(
                "SELECT octet_length(jsonb_build_object('traceparent', ?::text,"
                    + " 'tracestate', ?::text)::text)")) {
      statement.setString(1, traceparent);
      statement.setString(2, tracestate);
      try (ResultSet result = statement.executeQuery()) {
        assertTrue(result.next());
        return result.getLong(1);
      }
    }
  }

  private @Nullable Object enqueuedUnder(Span caller) throws SQLException {
    EnqueueResult result;
    try (Scope ignored = caller.makeCurrent()) {
      result = queue.enqueue("email.send", Map.of(), options());
    } finally {
      caller.end();
    }
    return storedTraceContext(result.taskId());
  }

  @Test
  void storesTheLargestTraceContextThatPostgresqlAcceptsAndDropsALargerOne() throws SQLException {
    String traceparent = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
    int length = 900;
    String tracestate =
        callerWithTraceState(length).getSpanContext().getTraceState().asMap().entrySet().stream()
            .map(entry -> entry.getKey() + "=" + entry.getValue())
            .reduce((left, right) -> left + "," + right)
            .orElseThrow();
    assertEquals(length, tracestate.length());
    long base = postgresBytes(traceparent, tracestate) - length;
    int largest = (int) (Telemetry.MAX_TRACE_CONTEXT_BYTES - base);

    Object stored = enqueuedUnder(callerWithTraceState(largest));
    assertTrue(stored instanceof Map<?, ?> carrier && carrier.containsKey("tracestate"));
    assertNull(enqueuedUnder(callerWithTraceState(largest + 1)), "the queue drops the carrier");
  }

  @Test
  void storesNoTraceContextWhenTheInstanceRecordsNoSpan() throws SQLException {
    Queue untraced =
        new Queue(
            ConnectionSource.of(dataSource),
            QueueOptions.builder().telemetry(WorkhorseTelemetry.of(OpenTelemetry.noop())).build());
    assertNull(storedTraceContext(untraced.enqueue("email.send", Map.of(), options()).taskId()));
  }

  @Test
  void readsTheGlobalInstanceByDefaultWhenTheCallerInstallsItLater() {
    Queue global = new Queue(ConnectionSource.of(dataSource));
    GlobalOpenTelemetry.resetForTest();
    try {
      GlobalOpenTelemetry.set(recording.sdk());
      global.enqueue("email.send", Map.of(), options());
    } finally {
      GlobalOpenTelemetry.resetForTest();
    }
    assertEquals(1, recording.spans(Names.SPAN_ENQUEUE).size());
  }
}
