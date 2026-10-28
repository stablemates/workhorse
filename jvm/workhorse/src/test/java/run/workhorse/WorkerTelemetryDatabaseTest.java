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
import io.opentelemetry.sdk.metrics.data.LongPointData;
import io.opentelemetry.sdk.metrics.data.MetricData;
import io.opentelemetry.sdk.metrics.data.PointData;
import io.opentelemetry.sdk.trace.data.SpanData;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;
import java.lang.reflect.Proxy;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.locks.LockSupport;
import java.util.function.BooleanSupplier;
import javax.sql.DataSource;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.CsvSource;
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

  /**
   * SM-1649: the handler changes the task in PostgreSQL and returns at once. The worker's own
   * timers still wait for the claimed boundaries and the heartbeat does not run in between, so
   * PostgreSQL refuses the completion write. A due deadline or attempt timeout settles under the
   * attempt's own fence before {@code runOnce} returns. A cancellation and a lost lease keep their
   * own outcomes.
   *
   * <p>{@code runOnce} also runs a due tick before the claim that finds no task. If the attempt
   * takes more than the 1 s default interval, that tick settles the moved deadline of the lost
   * lease (SM-1795). The interval of one hour lets only the tick before the first claim run.
   */
  @ParameterizedTest
  @CsvSource(
      delimiter = '|',
      value = {
        "UPDATE workhorse.task_runtime SET deadline_at = clock_timestamp() - interval '1 second'"
            + " WHERE task_id = ?"
            + "|failed|deadline_exceeded|deadline_exceeded",
        "UPDATE workhorse.task_runtime SET attempt_timeout_at = clock_timestamp()"
            + " - interval '1 second' WHERE task_id = ?"
            + "|failed|timeout_exceeded|timeout",
        "SELECT status FROM workhorse.cancel_v1(?, 'test', 'no longer needed')"
            + "|canceled|canceled|canceled",
        "UPDATE workhorse.task_runtime SET fence_token = fence_token + 1,"
            + " deadline_at = clock_timestamp() - interval '1 second' WHERE task_id = ?"
            + "|active|stale|lease_lost"
      })
  void settlesTheCauseOfARefusedCompletionWrite(
      String change, String state, String spanOutcome, String metricOutcome) throws SQLException {
    UUID taskId =
        queue
            .enqueue(
                "email.send",
                Map.of(),
                EnqueueOptions.builder()
                    .queue(queueName)
                    .maxAttempts(1)
                    .deadline(Instant.now().plus(Duration.ofHours(1)))
                    .executionTimeout(Duration.ofHours(1))
                    .build())
            .taskId();
    Worker subject =
        worker()
            .lease(Duration.ofSeconds(60))
            .heartbeat(Duration.ofSeconds(30))
            .maintenanceInterval(Duration.ofHours(1))
            .handle(
                "email.send",
                Object.class,
                (context, payload) -> {
                  try (Connection connection = ScratchDatabase.connect();
                      PreparedStatement statement = connection.prepareStatement(change)) {
                    statement.setObject(1, taskId);
                    statement.execute();
                  }
                  return Map.of("late", true);
                })
            .build();
    assertTrue(subject.runOnce());

    try (Connection connection = ScratchDatabase.connect();
        PreparedStatement statement =
            connection.prepareStatement(
                "SELECT COALESCE(outcome.state, runtime.state) AS state, outcome.result"
                    + " FROM workhorse.task task"
                    + " LEFT JOIN workhorse.task_runtime runtime ON runtime.task_id = task.id"
                    + " LEFT JOIN workhorse.task_outcome outcome ON outcome.task_id = task.id"
                    + " WHERE task.id = ?")) {
      statement.setObject(1, taskId);
      try (ResultSet row = statement.executeQuery()) {
        assertTrue(row.next());
        assertEquals(state, row.getString("state"), "the state when runOnce returned");
        assertEquals(null, row.getString("result"));
      }
    }
    SpanData complete = recording.spans(Names.SPAN_COMPLETE).get(0);
    assertEquals(
        false, complete.getAttributes().get(AttributeKey.booleanKey(Names.COMPLETE_ACCEPTED)));
    SpanData handler = recording.spans(Names.SPAN_HANDLER).get(0);
    assertEquals(spanOutcome, text(handler, Names.HANDLER_OUTCOME));
    Attributes task =
        Attributes.builder()
            .put(Names.QUEUE_NAME, queueName)
            .put(Names.TASK_TYPE, "email.send")
            .put(Names.HANDLER_OUTCOME, metricOutcome)
            .build();
    assertEquals(List.of(task), points(metric("workhorse.handler.executions")));
  }

  /**
   * SM-1884: a handler fails after its lease lapsed under an unchanged fence, so {@code fail_v1}
   * answers {@code stale}. {@code expire_owned_v1} does not read {@code expires_at}, so the worker
   * still settles a due deadline or attempt timeout and reports that cause. Only a lapsed lease
   * with no due boundary reports a lost lease. The cases are the lapsed-lease cases of the Go test
   * {@code worker_refused_completion_outcome_test.go}.
   */
  @ParameterizedTest
  @CsvSource({
    "deadline_at,failed,deadline_exceeded,deadline_exceeded",
    "attempt_timeout_at,failed,timeout_exceeded,timeout",
    "none,active,stale,lease_lost"
  })
  void settlesTheCauseOfAStaleFailureAfterALapsedLease(
      String boundary, String settledState, String spanOutcome, String metricOutcome)
      throws SQLException {
    UUID taskId = enqueueWithFarBoundaries();
    Worker subject =
        lapsedLeaseWorker()
            .handle(
                "email.send",
                Object.class,
                (context, payload) -> {
                  lapse(taskId, boundary);
                  throw new IllegalStateException("the handler failed");
                })
            .build();
    assertTrue(subject.runOnce());

    assertEquals(settledState, state(taskId), "the state when runOnce returned");
    assertEquals(
        spanOutcome, text(recording.spans(Names.SPAN_HANDLER).get(0), Names.HANDLER_OUTCOME));
    assertEquals(
        List.of(executions(metricOutcome)), points(metric("workhorse.handler.executions")));
  }

  /**
   * SM-1884: a handler stops for the shutdown after its lease lapsed, so {@code release_owned_v1}
   * answers {@code stale}. The worker reconciles that answer as it reconciles a stale failure.
   */
  @ParameterizedTest
  @CsvSource({
    "deadline_at,failed,deadline_exceeded,deadline_exceeded",
    "attempt_timeout_at,failed,timeout_exceeded,timeout",
    "none,active,stale,lease_lost"
  })
  void settlesTheCauseOfAStaleShutdownReleaseAfterALapsedLease(
      String boundary, String settledState, String spanOutcome, String metricOutcome)
      throws SQLException, InterruptedException {
    UUID taskId = enqueueWithFarBoundaries();
    CountDownLatch started = new CountDownLatch(1);
    Worker subject =
        lapsedLeaseWorker()
            .shutdownGrace(Duration.ofMillis(100))
            .handle(
                "email.send",
                Object.class,
                (context, payload) -> {
                  started.countDown();
                  // The drain cancels the token and then interrupts the thread. The interrupt
                  // would close the socket of the lapse below, so the handler waits for it and
                  // clears it first (SM-1889).
                  long deadline = System.nanoTime() + WAIT.toNanos();
                  while (!Thread.interrupted() && System.nanoTime() < deadline) {
                    LockSupport.parkNanos(TimeUnit.MILLISECONDS.toNanos(1));
                  }
                  lapse(taskId, boundary);
                  context.cancellation().throwIfCancelled();
                  return null;
                })
            .build();
    subject.start();
    assertTrue(started.await(WAIT.toMillis(), TimeUnit.MILLISECONDS));
    try {
      subject.close();
    } catch (ShutdownIncompleteException slow) {
      // A loaded host can stall the release past the unwind window. The wait below covers it.
    }
    waitUntil(() -> !recording.spans(Names.SPAN_HANDLER).isEmpty());

    assertEquals(settledState, state(taskId), "the state after the release");
    assertEquals(
        spanOutcome, text(recording.spans(Names.SPAN_HANDLER).get(0), Names.HANDLER_OUTCOME));
    assertEquals(
        List.of(executions(metricOutcome)), points(metric("workhorse.handler.executions")));
  }

  /**
   * SM-1884: {@code fail_v1} answers {@code cancel_requested}, and {@code acknowledge_cancel_v1}
   * refuses. The worker settles nothing, so the handler outcome is a lost lease, not {@code
   * unknown}. A trigger of this test database keeps the acknowledgement from deleting the runtime
   * row.
   */
  @Test
  void reportsALostLeaseWhenTheCancellationAcknowledgementIsRefused() throws SQLException {
    UUID taskId = enqueueWithFarBoundaries();
    execute(
        "CREATE FUNCTION public.keep_runtime() RETURNS trigger LANGUAGE plpgsql"
            + " AS $$ BEGIN RETURN NULL; END; $$");
    execute(
        "CREATE TRIGGER keep_runtime BEFORE DELETE ON workhorse.task_runtime FOR EACH ROW"
            + " WHEN (OLD.task_id = '"
            + taskId
            + "') EXECUTE FUNCTION public.keep_runtime()");
    try {
      Worker subject =
          lapsedLeaseWorker()
              .handle(
                  "email.send",
                  Object.class,
                  (context, payload) -> {
                    execute(
                        "SELECT status FROM workhorse.cancel_v1('"
                            + taskId
                            + "', 'test', 'no longer needed')");
                    throw new IllegalStateException("the handler failed");
                  })
              .build();
      assertTrue(subject.runOnce());
    } finally {
      execute("DROP TRIGGER keep_runtime ON workhorse.task_runtime");
      execute("DROP FUNCTION public.keep_runtime()");
    }

    assertEquals("stale", text(recording.spans(Names.SPAN_HANDLER).get(0), Names.HANDLER_OUTCOME));
    assertEquals(List.of(executions("lease_lost")), points(metric("workhorse.handler.executions")));
  }

  // The enqueued boundaries are far away, so the worker's own timers cannot reach them.
  private UUID enqueueWithFarBoundaries() {
    return queue
        .enqueue(
            "email.send",
            Map.of(),
            EnqueueOptions.builder()
                .queue(queueName)
                .maxAttempts(1)
                .deadline(Instant.now().plus(Duration.ofHours(1)))
                .executionTimeout(Duration.ofHours(1))
                .build())
        .taskId();
  }

  // Only the tick before the claim runs, and no heartbeat round runs while the handler runs.
  private Worker.Builder lapsedLeaseWorker() {
    return worker()
        .lease(Duration.ofSeconds(60))
        .heartbeat(Duration.ofSeconds(30))
        .maintenanceInterval(Duration.ofHours(1));
  }

  private Attributes executions(String outcome) {
    return Attributes.builder()
        .put(Names.QUEUE_NAME, queueName)
        .put(Names.TASK_TYPE, "email.send")
        .put(Names.HANDLER_OUTCOME, outcome)
        .build();
  }

  // Lets the lease lapse under an unchanged fence, and makes the boundary due unless it is none.
  private static void lapse(UUID taskId, String boundary) throws SQLException {
    String past = "clock_timestamp() - interval '1 second'";
    String change =
        "none".equals(boundary)
            ? "expires_at = " + past
            : "expires_at = " + past + ", " + boundary + " = " + past;
    execute("UPDATE workhorse.task_runtime SET " + change + " WHERE task_id = '" + taskId + "'");
  }

  private static void execute(String sql) throws SQLException {
    try (Connection connection = ScratchDatabase.connect();
        PreparedStatement statement = connection.prepareStatement(sql)) {
      statement.execute();
    }
  }

  private static String state(UUID taskId) throws SQLException {
    try (Connection connection = ScratchDatabase.connect();
        PreparedStatement statement =
            connection.prepareStatement(
                "SELECT COALESCE(outcome.state, runtime.state) AS state"
                    + " FROM workhorse.task task"
                    + " LEFT JOIN workhorse.task_runtime runtime ON runtime.task_id = task.id"
                    + " LEFT JOIN workhorse.task_outcome outcome ON outcome.task_id = task.id"
                    + " WHERE task.id = ?")) {
      statement.setObject(1, taskId);
      try (ResultSet row = statement.executeQuery()) {
        assertTrue(row.next());
        return row.getString("state");
      }
    }
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

  /**
   * SM-1704: the first heartbeat round fails before PostgreSQL returns its statuses. The worker
   * counts it once in {@code workhorse.worker.heartbeat.round_failure}, and not in {@code
   * workhorse.worker.heartbeat.failure}. The next round renews the lease, and the task completes.
   *
   * <p>SM-1815: a 100 ms heartbeat gives each round a 75 ms bound and a server budget of about 18
   * ms. On a loaded host, a later round can reach that bound and count once as {@code timeout}.
   * That is a second failed round, so the test accepts it. The injected failure has SQLSTATE {@code
   * 08006} and no timeout in its chain, so it can only count as {@code connection}.
   */
  @Test
  void countsAHeartbeatRoundThatFailsBeforePostgresqlAnswersAndCompletesTheTask() {
    AtomicInteger rounds = new AtomicInteger();
    DataSource failing = failFirstHeartbeat(dataSource, rounds);
    UUID taskId = queue.enqueue("email.send", Map.of(), options()).taskId();
    Worker subject =
        Worker.builder(failing)
            .queues(queueName)
            .pollingOnly(true)
            .pollInterval(Duration.ofMillis(10))
            .disableRegistry(true)
            .telemetry(telemetry)
            .lease(Duration.ofSeconds(10))
            .heartbeat(Duration.ofMillis(100))
            .handle(
                "email.send",
                Object.class,
                (context, payload) -> {
                  // A round after the failed one commits a renewal in PostgreSQL before the handler
                  // returns. Only a committed renewal ends this wait (SM-1815).
                  waitUntil(() -> renewed(taskId));
                  return null;
                })
            .build();
    assertTrue(subject.runOnce());

    MetricData failures = metric("workhorse.worker.heartbeat.round_failure");
    assertEquals("{round}", failures.getUnit());
    List<LongPointData> points = List.copyOf(failures.getLongSumData().getPoints());
    AttributeKey<String> reason = AttributeKey.stringKey(Names.HEARTBEAT_FAILURE_REASON);
    List<LongPointData> connection =
        points.stream()
            .filter(point -> point.getAttributes().equals(Attributes.of(reason, "connection")))
            .toList();
    assertEquals(1, connection.size(), points.toString());
    assertEquals(1, connection.get(0).getValue(), points.toString());
    // A later round that reaches its deadline is a second failed round (SM-1815).
    assertTrue(
        points.stream()
            .map(LongPointData::getAttributes)
            .allMatch(
                attributes ->
                    attributes.equals(Attributes.of(reason, "connection"))
                        || attributes.equals(Attributes.of(reason, "timeout"))),
        points.toString());
    assertTrue(
        recording.metrics().stream()
            .noneMatch(metric -> metric.getName().equals("workhorse.worker.heartbeat.failure")),
        "a failed round gives no ownership verdict");
    Attributes task =
        Attributes.builder()
            .put(Names.QUEUE_NAME, queueName)
            .put(Names.TASK_TYPE, "email.send")
            .build();
    assertEquals(List.of(task), points(metric("workhorse.tasks.completed")));
    assertEquals(
        "succeeded", text(recording.spans(Names.SPAN_HANDLER).get(0), Names.HANDLER_OUTCOME));
    assertEquals(
        taskId.toString(), text(recording.spans(Names.SPAN_HANDLER).get(0), Names.TASK_ID));
    recording.assertGoverned(Telemetry.TRACE_ATTRIBUTE_COUNT_LIMIT);
  }

  /**
   * Whether a heartbeat has renewed the lease of {@code taskId} since its claim. The claim sets
   * {@code heartbeat_at} to {@code acquired_at}, and only a committed renewal moves it later.
   */
  private static boolean renewed(UUID taskId) {
    try (Connection connection = ScratchDatabase.connect();
        PreparedStatement statement =
            connection.prepareStatement(
                "SELECT heartbeat_at > acquired_at AS renewed FROM workhorse.task_runtime"
                    + " WHERE task_id = ?")) {
      statement.setObject(1, taskId);
      try (ResultSet row = statement.executeQuery()) {
        return row.next() && row.getBoolean("renewed");
      }
    } catch (SQLException error) {
      throw new IllegalStateException("could not read the lease", error);
    }
  }

  /**
   * {@code source}, whose connections fail the first heartbeat statement with a connection error
   * before it reaches PostgreSQL. {@code rounds} counts each heartbeat statement that the round
   * prepares.
   */
  private static DataSource failFirstHeartbeat(DataSource source, AtomicInteger rounds) {
    return (DataSource)
        Proxy.newProxyInstance(
            DataSource.class.getClassLoader(),
            new Class<?>[] {DataSource.class},
            (proxy, method, arguments) -> {
              Object result = invoke(method, source, arguments);
              if (!method.getName().equals("getConnection")) {
                return result;
              }
              Connection connection = (Connection) result;
              return Proxy.newProxyInstance(
                  Connection.class.getClassLoader(),
                  new Class<?>[] {Connection.class},
                  (inner, call, values) -> {
                    if (call.getName().equals("prepareStatement")
                        && String.valueOf(values[0]).contains("heartbeat_many_v2")
                        && rounds.getAndIncrement() == 0) {
                      throw new SQLException("injected connection failure", "08006");
                    }
                    return invoke(call, connection, values);
                  });
            });
  }

  private static Object invoke(Method method, Object target, Object[] arguments) throws Throwable {
    try {
      return method.invoke(target, arguments);
    } catch (InvocationTargetException error) {
      throw error.getCause();
    }
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
