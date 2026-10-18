package run.workhorse;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import io.opentelemetry.api.common.AttributeKey;
import io.opentelemetry.api.common.Attributes;
import io.opentelemetry.api.trace.Span;
import io.opentelemetry.api.trace.SpanKind;
import io.opentelemetry.api.trace.StatusCode;
import io.opentelemetry.api.trace.Tracer;
import io.opentelemetry.context.Scope;
import io.opentelemetry.sdk.metrics.data.MetricData;
import io.opentelemetry.sdk.metrics.data.PointData;
import io.opentelemetry.sdk.trace.data.SpanData;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.SQLException;
import java.time.Duration;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.function.BooleanSupplier;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import run.workhorse.internal.Sql;
import run.workhorse.internal.SqlCatalogue;
import run.workhorse.internal.telemetry.Names;
import run.workhorse.internal.telemetry.Telemetry;
import run.workhorse.testing.RecordingOpenTelemetry;
import run.workhorse.testing.ScratchDataSource;
import run.workhorse.testing.ScratchDatabase;

/**
 * The worker's spans and metrics against PostgreSQL. The worker row "OpenTelemetry tracing and
 * metrics" of parity, as Ruby's {@code worker_runtime_spec.rb} example "continues the enqueuing
 * trace in the handler span and records the shared metrics".
 */
// A scope only makes a span current, so a try block never reads it.
@SuppressWarnings("try")
@ExtendWith(ScratchDatabase.class)
class WorkerTelemetryDatabaseTest {
  private static final Duration WAIT = Duration.ofSeconds(30);

  private final ScratchDataSource dataSource = new ScratchDataSource(true);
  private final RecordingOpenTelemetry recording = new RecordingOpenTelemetry();
  private final WorkhorseTelemetry telemetry = WorkhorseTelemetry.of(recording.sdk());
  private final Queue queue =
      new Queue(
          ConnectionSource.of(dataSource), QueueOptions.builder().telemetry(telemetry).build());
  private final String queueName = "worker-telemetry-" + UUID.randomUUID();

  @AfterEach
  void close() {
    recording.close();
  }

  private Worker.Builder worker() {
    return Worker.builder(dataSource)
        .queues(queueName)
        .pollingOnly(true)
        .pollInterval(Duration.ofMillis(10))
        .disableRegistry(true)
        .telemetry(telemetry);
  }

  private EnqueueOptions options() {
    return EnqueueOptions.builder().queue(queueName).build();
  }

  private static String text(SpanData span, String key) {
    return span.getAttributes().get(AttributeKey.stringKey(key));
  }

  private MetricData metric(String name) {
    return recording.metrics().stream()
        .filter(metric -> metric.getName().equals(name))
        .findFirst()
        .orElseThrow(() -> new AssertionError(name + " was not recorded"));
  }

  private static List<Attributes> points(MetricData metric) {
    return metric.getData().getPoints().stream().map(PointData::getAttributes).toList();
  }

  @Test
  void continuesTheEnqueuingTraceInTheHandlerSpanAndRecordsTheSharedMetrics() {
    Tracer tracer = recording.sdk().getTracer("caller");
    Span caller = tracer.spanBuilder("caller").startSpan();
    UUID taskId;
    try (Scope ignored = caller.makeCurrent()) {
      taskId = queue.enqueue("email.send", Map.of(), options()).taskId();
    } finally {
      caller.end();
    }
    Worker subject =
        worker()
            .handle(
                "email.send",
                Object.class,
                (context, payload) -> {
                  tracer.spanBuilder("inside").startSpan().end();
                  return null;
                })
            .build();
    assertTrue(subject.runOnce());

    SpanData enqueue = recording.spans(Names.SPAN_ENQUEUE).get(0);
    SpanData handler = recording.spans(Names.SPAN_HANDLER).get(0);
    assertEquals(SpanKind.CONSUMER, handler.getKind());
    assertEquals(caller.getSpanContext().getTraceId(), handler.getTraceId());
    assertEquals(enqueue.getSpanId(), handler.getParentSpanId());
    assertEquals(taskId.toString(), text(handler, Names.TASK_ID));
    assertEquals(queueName, text(handler, Names.QUEUE_NAME));
    assertEquals("succeeded", text(handler, Names.HANDLER_OUTCOME));
    assertEquals(handler.getSpanId(), recording.spans("inside").get(0).getParentSpanId());

    SpanData complete = recording.spans(Names.SPAN_COMPLETE).get(0);
    assertEquals(handler.getSpanId(), complete.getParentSpanId());
    assertEquals(
        true, complete.getAttributes().get(AttributeKey.booleanKey(Names.COMPLETE_ACCEPTED)));
    SpanData claim = recording.spans(Names.SPAN_CLAIM).get(0);
    assertEquals(queueName, text(claim, Names.QUEUE_NAME));
    assertEquals(taskId.toString(), text(claim, Names.TASK_ID));

    Attributes task =
        Attributes.builder()
            .put(Names.QUEUE_NAME, queueName)
            .put(Names.TASK_TYPE, "email.send")
            .build();
    assertEquals(List.of(task), points(metric("workhorse.tasks.claimed")));
    assertEquals(List.of(task), points(metric("workhorse.tasks.completed")));
    assertEquals(List.of(task), points(metric("workhorse.handler.runtime")));
    Attributes succeeded = task.toBuilder().put(Names.HANDLER_OUTCOME, "succeeded").build();
    assertEquals(List.of(succeeded), points(metric("workhorse.handler.executions")));
    assertEquals(List.of(succeeded), points(metric("workhorse.handler.duration")));
    assertTrue(
        points(metric("workhorse.claim.duration"))
            .contains(
                Attributes.builder()
                    .put(Names.QUEUE_NAME, queueName)
                    .put(Names.CLAIM_RESULT, "claimed")
                    .build()));
    recording.assertGoverned(Telemetry.TRACE_ATTRIBUTE_COUNT_LIMIT);
  }

  @Test
  void marksTheHandlerSpanFailedAndRecordsTheRetry() {
    queue.enqueue(
        "email.send", Map.of(), EnqueueOptions.builder().queue(queueName).maxAttempts(2).build());
    Worker subject =
        worker()
            .handle(
                "email.send",
                Object.class,
                (context, payload) -> {
                  throw new IllegalStateException("declined");
                })
            .build();
    assertTrue(subject.runOnce());

    SpanData handler = recording.spans(Names.SPAN_HANDLER).get(0);
    assertEquals(StatusCode.ERROR, handler.getStatus().getStatusCode());
    assertEquals(
        IllegalStateException.class.getName(),
        handler.getEvents().get(0).getAttributes().get(AttributeKey.stringKey("exception.type")));
    SpanData retry = recording.spans(Names.SPAN_RETRY).get(0);
    assertEquals(handler.getSpanId(), retry.getParentSpanId());
    String state = text(retry, Names.RETRY_OUTCOME);
    assertTrue(List.of("ready", "scheduled").contains(state), state);
    assertEquals(state, text(handler, Names.HANDLER_OUTCOME), "the span names the stored state");
    Attributes task =
        Attributes.builder()
            .put(Names.QUEUE_NAME, queueName)
            .put(Names.TASK_TYPE, "email.send")
            .build();
    assertEquals(
        List.of(task.toBuilder().put(Names.ATTEMPT_OUTCOME, state).build()),
        points(metric("workhorse.tasks.failed")));
    assertEquals(List.of(task), points(metric("workhorse.tasks.retried")));
    recording.assertGoverned(Telemetry.TRACE_ATTRIBUTE_COUNT_LIMIT);
  }

  @Test
  void namesARedactedErrorWithoutItsClass() throws SQLException {
    UUID taskId =
        queue
            .enqueue(
                "email.send",
                Map.of(),
                EnqueueOptions.builder().queue(queueName).maxAttempts(1).build())
            .taskId();
    try (Connection connection = ScratchDatabase.connect();
        PreparedStatement statement =
            connection.prepareStatement(
                "UPDATE workhorse.task SET payload_redact_keys = ARRAY['secret'] WHERE id = ?")) {
      statement.setObject(1, taskId);
      statement.executeUpdate();
    }
    Worker subject =
        worker()
            .handle(
                "email.send",
                Object.class,
                (context, payload) -> {
                  throw new IllegalStateException("card 4242 declined");
                })
            .build();
    assertTrue(subject.runOnce());
    SpanData handler = recording.spans(Names.SPAN_HANDLER).get(0);
    assertEquals("failed", text(handler, Names.HANDLER_OUTCOME));
    assertEquals(
        "RedactedTaskError",
        handler.getEvents().get(0).getAttributes().get(AttributeKey.stringKey("exception.type")));
  }

  @Test
  void countsTheTasksThatAFastTierCompletionClaimsAsItRefills() throws Exception {
    try (Connection connection = ScratchDatabase.connect()) {
      Sql.rows(connection, SqlCatalogue.SET_QUEUE_TIER_V1, queueName, "fast", "jvm-test", "test");
    }
    int tasks = 12;
    for (int index = 0; index < tasks; index++) {
      queue.enqueue("email.send", Map.of(), options());
    }
    List<Worker.FusedStatement> statements = new CopyOnWriteArrayList<>();
    Worker subject =
        worker()
            .concurrency(4)
            .handle("email.send", Object.class, (context, payload) -> null)
            .build();
    subject.fusedStatementHook = statements::add;
    subject.start();
    try {
      waitUntil(() -> sum("workhorse.tasks.completed") == tasks);
    } finally {
      subject.close();
    }
    assertTrue(
        statements.stream().anyMatch(statement -> statement.claimed() > 0),
        "a fused completion claimed the next tasks");
    assertEquals(tasks, sum("workhorse.tasks.claimed"), "each claimed task is counted once");
    assertTrue(
        points(metric("workhorse.claim.duration")).stream()
            .allMatch(
                point -> queueName.equals(point.get(AttributeKey.stringKey(Names.QUEUE_NAME)))));
    recording.assertGoverned(Telemetry.TRACE_ATTRIBUTE_COUNT_LIMIT);
  }

  /** The sum of a counter across its points, or 0 before the first point. */
  private long sum(String name) {
    return recording.metrics().stream()
        .filter(metric -> metric.getName().equals(name))
        .flatMap(metric -> metric.getLongSumData().getPoints().stream())
        .mapToLong(point -> point.getValue())
        .sum();
  }

  @Test
  void startsANewTraceForATaskEnqueuedWithoutTraceContext() {
    Queue untraced = new Queue(ConnectionSource.of(dataSource));
    untraced.enqueue("email.send", Map.of(), options());
    Worker subject =
        worker().handle("email.send", Object.class, (context, payload) -> null).build();
    assertTrue(subject.runOnce());
    SpanData handler = recording.spans(Names.SPAN_HANDLER).get(0);
    assertFalse(handler.getParentSpanContext().isValid());
  }

  @Test
  void tracesAMaintenancePassAndItsRecovery() throws Exception {
    Worker subject =
        worker()
            .maintenanceInterval(Duration.ofMillis(100))
            .handle("email.send", Object.class, (context, payload) -> null)
            .build();
    subject.start();
    try {
      waitUntil(() -> !recording.spans(Names.SPAN_MAINTENANCE).isEmpty());
    } finally {
      subject.close();
    }
    SpanData maintenance = recording.spans(Names.SPAN_MAINTENANCE).get(0);
    assertEquals("tick", text(maintenance, Names.MAINTENANCE_OPERATION));
    SpanData recovery = recording.spans(Names.SPAN_RECOVERY).get(0);
    assertEquals(maintenance.getSpanId(), recovery.getParentSpanId());
    assertTrue(
        points(metric("workhorse.maintenance.runs")).stream()
            .anyMatch(
                point -> "tick".equals(point.get(AttributeKey.stringKey(Names.MAINTENANCE_LOOP)))));
    recording.assertGoverned(Telemetry.TRACE_ATTRIBUTE_COUNT_LIMIT);
  }

  private static void waitUntil(BooleanSupplier condition) throws InterruptedException {
    long deadline = System.nanoTime() + WAIT.toNanos();
    while (!condition.getAsBoolean()) {
      if (System.nanoTime() > deadline) {
        throw new AssertionError("timed out waiting for the recorded telemetry");
      }
      Thread.sleep(10);
    }
  }
}
