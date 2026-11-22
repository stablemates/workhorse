package run.workhorse;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import io.opentelemetry.api.common.AttributeKey;
import io.opentelemetry.api.logs.Severity;
import io.opentelemetry.sdk.OpenTelemetrySdk;
import io.opentelemetry.sdk.logs.SdkLoggerProvider;
import io.opentelemetry.sdk.logs.data.LogRecordData;
import io.opentelemetry.sdk.trace.data.SpanData;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;
import java.lang.reflect.Proxy;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.SQLException;
import java.time.Duration;
import java.util.List;
import java.util.Map;
import java.util.ResourceBundle;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.function.BooleanSupplier;
import org.jspecify.annotations.Nullable;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import run.workhorse.internal.Sql;
import run.workhorse.internal.SqlCatalogue;
import run.workhorse.internal.telemetry.Names;
import run.workhorse.internal.telemetry.Telemetry;
import run.workhorse.testing.RecordingOpenTelemetry;
import run.workhorse.testing.ScratchDataSource;
import run.workhorse.testing.ScratchDatabase;

/**
 * The log records that the worker and the queue emit through the OpenTelemetry Logs API, with the
 * event names and the attributes of the TypeScript runtime (SM-1438).
 */
@ExtendWith(ScratchDatabase.class)
class WorkerLogsDatabaseTest {
  private static final Duration WAIT = Duration.ofSeconds(30);

  private final ScratchDataSource dataSource = new ScratchDataSource(true);
  private final RecordingOpenTelemetry recording = new RecordingOpenTelemetry();
  private final WorkhorseTelemetry telemetry = WorkhorseTelemetry.of(recording.sdk());
  private final Queue queue =
      new Queue(
          ConnectionSource.of(dataSource), QueueOptions.builder().telemetry(telemetry).build());
  private final String queueName = "worker-logs-" + UUID.randomUUID();

  @AfterEach
  void close() {
    recording.assertGoverned(Telemetry.TRACE_ATTRIBUTE_COUNT_LIMIT);
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

  private UUID enqueue(String taskType, EnqueueOptions.Builder options) {
    return queue.enqueue(taskType, Map.of(), options.queue(queueName).build()).taskId();
  }

  private LogRecordData only(String event) {
    List<LogRecordData> logs = recording.logs(event);
    assertEquals(1, logs.size(), event + " records");
    return logs.get(0);
  }

  private static @Nullable Object value(LogRecordData log, String key) {
    return log.getAttributes().asMap().entrySet().stream()
        .filter(entry -> entry.getKey().getKey().equals(key))
        .map(Map.Entry::getValue)
        .findFirst()
        .orElse(null);
  }

  /** Runs one claim at a time until {@code done} holds. */
  private static void drive(Worker worker, BooleanSupplier done) throws InterruptedException {
    long deadline = System.nanoTime() + WAIT.toNanos();
    while (!done.getAsBoolean()) {
      assertTrue(System.nanoTime() < deadline, "the task did not finish");
      if (!worker.runOnce()) {
        TimeUnit.MILLISECONDS.sleep(10);
      }
    }
  }

  private static void waitUntil(BooleanSupplier condition) throws InterruptedException {
    long deadline = System.nanoTime() + WAIT.toNanos();
    while (!condition.getAsBoolean()) {
      assertTrue(System.nanoTime() < deadline, "the condition did not hold");
      TimeUnit.MILLISECONDS.sleep(10);
    }
  }

  private void execute(String sql, @Nullable String parameter) {
    try (Connection connection = dataSource.getConnection();
        PreparedStatement statement = connection.prepareStatement(sql)) {
      if (parameter != null) {
        statement.setString(1, parameter);
      }
      statement.executeUpdate();
    } catch (SQLException error) {
      throw new IllegalStateException(error);
    }
  }

  @Test
  void emitsTheRegistrationAndHandlerLogsInsideTheHandlerSpan() {
    UUID taskId = enqueue("email.send", EnqueueOptions.builder());
    Worker subject =
        worker()
            .disableRegistry(false)
            .workerId("logs-worker")
            .concurrency(5)
            .handle("email.send", Object.class, (context, payload) -> null)
            .handleBatch(
                "digest",
                Object.class,
                new BatchOptions(5, Duration.ofMillis(50)),
                items -> List.of())
            .build();
    subject.pause();
    subject.resume();
    assertTrue(subject.runOnce());
    subject.stop();

    List<LogRecordData> registered = recording.logs("workhorse.handler.registered");
    assertEquals(2, registered.size());
    LogRecordData batch = registered.get(0);
    assertEquals("digest", value(batch, Names.TASK_TYPE));
    assertEquals(5L, value(batch, Names.HANDLER_BATCH_MAX_SIZE));
    assertEquals(50L, value(batch, Names.HANDLER_BATCH_LINGER_MS));
    assertEquals("logs-worker", value(batch, Names.WORKER_ID));
    assertEquals(Severity.DEBUG, batch.getSeverity());
    assertEquals("DEBUG", batch.getSeverityText());
    assertEquals("Batch task handler registered", batch.getBodyValue().asString());
    assertEquals("email.send", value(registered.get(1), Names.TASK_TYPE));

    List<String> queues = List.of(queueName);
    for (String event : List.of("workhorse.worker.paused", "workhorse.worker.resumed")) {
      LogRecordData log = only(event);
      assertEquals(queues, value(log, Names.WORKER_QUEUES));
      assertEquals(Severity.INFO, log.getSeverity());
    }
    // A one-pass call is not a run, so it writes no start and no stop record, as in TypeScript.
    assertEquals(List.of(), recording.logs("workhorse.worker.started"));
    assertEquals(List.of(), recording.logs("workhorse.worker.stopped"));
    LogRecordData registration = recording.logs("workhorse.worker.registered").get(0);
    assertEquals(queues, value(registration, Names.WORKER_QUEUES));
    assertEquals(5L, value(registration, Names.WORKER_CONCURRENCY));
    assertEquals(0L, value(registration, Names.WORKER_ACTIVE_SLOTS));
    assertEquals(false, value(registration, Names.WORKER_DRAINING));
    assertEquals(false, value(registration, Names.WORKER_PAUSED));
    // The draining registration of the stop changes the state, so it logs again.
    assertTrue(
        recording.logs("workhorse.worker.registered").stream()
            .anyMatch(log -> Boolean.TRUE.equals(value(log, Names.WORKER_DRAINING))),
        "a draining registration record");
    assertEquals(true, value(only("workhorse.worker.deregistered"), Names.WORKER_DEREGISTERED));
    LogRecordData stop = only("workhorse.worker.stop_requested");
    assertEquals(queues, value(stop, Names.WORKER_QUEUES));
    assertEquals(0L, value(stop, Names.WORKER_ACTIVE_SLOTS));

    SpanData handler = recording.spans(Names.SPAN_HANDLER).get(0);
    for (String event :
        List.of(
            "workhorse.handler.started",
            "workhorse.task.execution_finished",
            "workhorse.handler.finished")) {
      LogRecordData log = only(event);
      assertEquals(taskId.toString(), value(log, Names.TASK_ID));
      assertEquals(handler.getSpanId(), log.getSpanContext().getSpanId(), event);
    }
    Object duration = value(only("workhorse.handler.finished"), Names.HANDLER_DURATION_MS);
    assertTrue(duration instanceof Double milliseconds && milliseconds >= 0, "duration");
  }

  @Test
  void emitsTheCheckpointProgressAndWaitLogs() throws InterruptedException {
    UUID taskId = enqueue("durable", EnqueueOptions.builder());
    CountDownLatch finished = new CountDownLatch(1);
    Worker subject =
        worker()
            .handle(
                "durable",
                Object.class,
                (context, payload) -> {
                  context.checkpoint("step", Long.class, () -> 1L);
                  context.setProgress(Map.of("done", 1L));
                  context.sleep("pause", Duration.ofMillis(10));
                  finished.countDown();
                  return null;
                })
            .build();
    drive(subject, () -> finished.getCount() == 0);

    LogRecordData checkpoint = recording.logs("workhorse.task.checkpoint_saved").get(0);
    assertEquals("step", value(checkpoint, Names.CHECKPOINT_NAME));
    assertEquals("saved", value(checkpoint, Names.CHECKPOINT_STATUS));
    assertEquals(taskId.toString(), value(checkpoint, Names.TASK_ID));
    assertEquals(
        "updated",
        value(recording.logs("workhorse.task.progress_updated").get(0), Names.PROGRESS_STATUS));
    LogRecordData wait = recording.logs("workhorse.task.wait_processed").get(0);
    assertEquals("pause", value(wait, Names.WAIT_NAME));
    assertEquals("scheduled", value(wait, Names.WAIT_STATUS));
  }

  @Test
  void emitsTheSignalAndHumanWaitLogs() throws InterruptedException {
    UUID taskId = enqueue("approval", EnqueueOptions.builder());
    CountDownLatch finished = new CountDownLatch(1);
    Worker subject =
        worker()
            .handle(
                "approval",
                Object.class,
                (context, payload) -> {
                  context.waitForSignal("approved", Object.class, Duration.ofHours(1));
                  context.waitForHuman("review", null, Object.class, Duration.ofHours(1));
                  finished.countDown();
                  return null;
                })
            .build();
    assertTrue(subject.runOnce());
    queue.sendSignal(taskId, "approved", Map.of(), "signal-1", "test");
    assertTrue(subject.runOnce());
    queue.completeHumanWait(taskId, "review", Map.of(), "decision-1", "reviewer");
    drive(subject, () -> finished.getCount() == 0);

    LogRecordData signal = only("workhorse.task.signal_processed");
    assertEquals(taskId.toString(), value(signal, Names.TASK_ID));
    assertEquals("approved", value(signal, Names.SIGNAL_NAME));
    assertEquals("delivered", value(signal, Names.SIGNAL_STATUS));
    assertEquals(Severity.INFO, signal.getSeverity());
    assertEquals(null, value(signal, "workhorse.signal.payload"));
    LogRecordData human = only("workhorse.task.human_wait_processed");
    assertEquals("review", value(human, Names.HUMAN_WAIT_NAME));
    assertEquals("completed", value(human, Names.HUMAN_WAIT_STATUS));
  }

  @Test
  void emitsTheChildLogs() throws InterruptedException {
    enqueue("parent", EnqueueOptions.builder());
    enqueue("fan-out", EnqueueOptions.builder());
    CountDownLatch finished = new CountDownLatch(2);
    Worker subject =
        worker()
            .handle(
                "parent",
                Object.class,
                (context, payload) -> {
                  context.runChild("one", "child", 1L, EnqueueOptions.defaults(), Long.class);
                  finished.countDown();
                  return null;
                })
            .handle(
                "fan-out",
                Object.class,
                (context, payload) -> {
                  context.runChildren(
                      List.of(
                          ChildRequest.of("two", "child", 2L),
                          ChildRequest.of("three", "child", 3L)));
                  finished.countDown();
                  return null;
                })
            .handle("child", Long.class, (context, payload) -> payload)
            .build();
    drive(subject, () -> finished.getCount() == 0);

    LogRecordData child =
        recording.logs("workhorse.task.child_processed").stream()
            .filter(log -> value(log, Names.CHILD_NAME) != null)
            .findFirst()
            .orElseThrow();
    assertEquals("one", value(child, Names.CHILD_NAME));
    assertEquals("created", value(child, Names.CHILD_STATUS));
    LogRecordData children =
        recording.logs("workhorse.task.child_processed").stream()
            .filter(log -> value(log, Names.CHILD_COUNT) != null)
            .findFirst()
            .orElseThrow();
    assertEquals(2L, value(children, Names.CHILD_COUNT));
    assertEquals("created", value(children, Names.CHILD_STATUS));
  }

  @Test
  void emitsTheReleaseAndExpirationLogs() {
    UUID slow =
        enqueue(
            "slow",
            EnqueueOptions.builder().executionTimeout(Duration.ofMillis(300)).maxAttempts(1));
    Worker subject =
        worker()
            .handle(
                "slow",
                Object.class,
                (context, payload) -> {
                  context.cancellation().await(WAIT);
                  return null;
                })
            .build();
    assertTrue(subject.runOnce());
    // The worker has no handler for this type, so it gives the claim back.
    enqueue("unhandled", EnqueueOptions.builder());
    subject.runOnce();

    LogRecordData release = only("workhorse.task.release_processed");
    assertEquals("released", value(release, Names.RELEASE_STATUS));
    LogRecordData expired = only("workhorse.task.ownership_expired");
    assertEquals(slow.toString(), value(expired, Names.TASK_ID));
    assertEquals("timeout_exceeded", value(expired, Names.EXPIRATION_STATUS));
  }

  @Test
  void emitsTheCancellationAcknowledgement() throws InterruptedException {
    UUID taskId = enqueue("cancellable", EnqueueOptions.builder());
    CountDownLatch started = new CountDownLatch(1);
    Worker subject =
        worker()
            .lease(Duration.ofSeconds(5))
            .heartbeat(Duration.ofMillis(100))
            .handle(
                "cancellable",
                Object.class,
                (context, payload) -> {
                  started.countDown();
                  context.cancellation().await(WAIT);
                  context.cancellation().throwIfCancelled();
                  return null;
                })
            .build();
    subject.start();
    try {
      assertTrue(started.await(WAIT.toMillis(), TimeUnit.MILLISECONDS));
      queue.cancel(taskId, "test", "no longer needed");
      waitUntil(() -> !recording.logs("workhorse.task.cancellation_acknowledged").isEmpty());
    } finally {
      subject.close();
    }
    LogRecordData acknowledged = only("workhorse.task.cancellation_acknowledged");
    assertEquals(taskId.toString(), value(acknowledged, Names.TASK_ID));
    assertEquals(true, value(acknowledged, Names.CANCEL_ACCEPTED));
  }

  @Test
  void emitsTheBatchDispatchAndAFailedEvidenceWrite() {
    UUID taskId = enqueue("digest", EnqueueOptions.builder().maxAttempts(1));
    Worker subject =
        worker()
            .concurrency(5)
            .handleBatch(
                "digest",
                Object.class,
                new BatchOptions(5, Duration.ofMillis(20)),
                items -> {
                  // Without the retained claim, PostgreSQL refuses the failure evidence.
                  execute(
                      "DELETE FROM workhorse.task_event WHERE task_id = ?::uuid"
                          + " AND event_type = 'claimed'",
                      taskId.toString());
                  throw new IllegalStateException("batch fails");
                })
            .build();
    assertTrue(subject.runOnce());

    LogRecordData dispatched = only("workhorse.handler.batch_dispatched");
    assertTrue(value(dispatched, Names.HANDLER_BATCH_LINGER_MS) instanceof Long);
    LogRecordData failed = only("workhorse.handler.batch_evidence_failed");
    assertEquals("failure", value(failed, Names.HANDLER_BATCH_EVIDENCE_PHASE));
    assertEquals(Severity.WARN, failed.getSeverity());
    assertEquals("WARN", failed.getSeverityText());
  }

  /**
   * As in TypeScript, the polling warning reads whether the run has a notification subscription.
   * Here the LISTEN of the subscription stalls, so the worker polls, but it does not warn.
   */
  @Test
  void emitsTheMaintenanceDriftAndNoPollingWarningWhileTheListenStalls()
      throws InterruptedException {
    CountDownLatch listen = new CountDownLatch(1);
    Worker subject =
        Worker.builder(WorkerPoolDatabaseTest.stallingListen(dataSource, listen))
            .queues(queueName)
            .pollInterval(Duration.ofMillis(10))
            .disableRegistry(true)
            .telemetry(telemetry)
            .maintenanceInterval(Duration.ofMillis(100))
            .handle("email.send", Object.class, (context, payload) -> null)
            .build();
    subject.start();
    try {
      waitUntil(
          () ->
              recording.metrics().stream()
                  .anyMatch(metric -> metric.getName().equals("workhorse.maintenance.drift")));
    } finally {
      listen.countDown();
      subject.close();
    }
    assertEquals(1, recording.logs("workhorse.worker.started").size());
    assertEquals(List.of(), recording.logs("workhorse.worker.polling_only"));
    assertTrue(
        recording.metrics().stream()
            .filter(metric -> metric.getName().equals("workhorse.maintenance.drift"))
            .flatMap(metric -> metric.getData().getPoints().stream())
            .map(point -> point.getAttributes().get(AttributeKey.stringKey(Names.MAINTENANCE_LOOP)))
            .toList()
            .contains("tick"));
  }

  @Test
  void writesTheStartTheStopAndThePollingWarningOnlyForARun() throws InterruptedException {
    Worker subject =
        worker()
            .workerId("lifecycle-worker")
            .concurrency(3)
            .handle("email.send", Object.class, (context, payload) -> null)
            .build();
    assertFalse(subject.runOnce());
    assertEquals(List.of(), recording.logs("workhorse.worker.started"));
    assertEquals(List.of(), recording.logs("workhorse.worker.polling_only"));

    subject.start();
    try {
      waitUntil(() -> !recording.logs("workhorse.worker.polling_only").isEmpty());
    } finally {
      subject.close();
    }

    List<String> queues = List.of(queueName);
    LogRecordData started = only("workhorse.worker.started");
    assertLog(started, Severity.INFO, "Worker started");
    assertEquals(queues, value(started, Names.WORKER_QUEUES));
    assertEquals(3L, value(started, Names.WORKER_CONCURRENCY));
    // The worker is configured to poll, and TypeScript still warns once after the start.
    LogRecordData polling = only("workhorse.worker.polling_only");
    assertLog(
        polling, Severity.WARN, "Worker has no notification listener and dispatches by polling");
    assertEquals(queues, value(polling, Names.WORKER_QUEUES));
    assertEquals("unknown", value(polling, Names.WORKER_POOL_MAX_SIZE));
    List<LogRecordData> logs = recording.logs();
    assertTrue(logs.indexOf(started) < logs.indexOf(polling), "the warning follows the start");
    LogRecordData stopped = only("workhorse.worker.stopped");
    assertEquals(0L, value(stopped, Names.WORKER_ACTIVE_SLOTS));
    assertEquals(queues, value(stopped, Names.WORKER_QUEUES));
  }

  /**
   * Each run writes its first registration record, also when the deregistration of the run before
   * did not clear the saved state, for example because it passed its stop deadline.
   */
  @Test
  void eachRunWritesItsFirstRegistrationRecord() throws Exception {
    Worker subject =
        worker()
            .disableRegistry(false)
            .workerId("registration-runs-worker")
            .handle("email.send", Object.class, (context, payload) -> null)
            .build();
    java.lang.reflect.Field saved = Worker.class.getDeclaredField("loggedRegistration");
    saved.setAccessible(true);
    subject.start();
    Object first;
    try {
      waitUntil(() -> !recording.logs("workhorse.worker.registered").isEmpty());
      first = saved.get(subject);
    } finally {
      subject.close();
    }
    // As if the deregistration did not run: the saved state is still the first registration.
    saved.set(subject, first);
    int before = recording.logs("workhorse.worker.registered").size();
    subject.start();
    try {
      waitUntil(() -> recording.logs("workhorse.worker.registered").size() > before);
    } finally {
      subject.close();
    }
  }

  /**
   * As in TypeScript, a run that ends with an error, here an incomplete stop, writes no stop
   * record.
   */
  @Test
  void writesNoStopRecordForARunThatFails() throws InterruptedException {
    enqueue("email.send", EnqueueOptions.builder());
    CountDownLatch started = new CountDownLatch(1);
    CountDownLatch release = new CountDownLatch(1);
    Worker subject =
        worker()
            .shutdownGrace(Duration.ZERO)
            .handle(
                "email.send",
                Object.class,
                (context, payload) -> {
                  started.countDown();
                  // The handler ignores the stop, so the run abandons it.
                  while (true) {
                    try {
                      if (release.await(WAIT.toMillis(), TimeUnit.MILLISECONDS)) {
                        return null;
                      }
                    } catch (InterruptedException ignored) {
                      // Keep the handler running past the stop.
                    }
                  }
                })
            .build();
    subject.start();
    try {
      assertTrue(started.await(WAIT.toMillis(), TimeUnit.MILLISECONDS));
      assertThrows(ShutdownIncompleteException.class, subject::close);
    } finally {
      release.countDown();
    }
    assertEquals(1, recording.logs("workhorse.worker.started").size());
    assertEquals(List.of(), recording.logs("workhorse.worker.stopped"));
  }

  @Test
  void writesNoExecutionRecordWhenTheSettlementFails() {
    UUID taskId = enqueue("email.send", EnqueueOptions.builder());
    Worker subject =
        Worker.builder(failingSettlement(dataSource))
            .queues(queueName)
            .pollingOnly(true)
            .pollInterval(Duration.ofMillis(10))
            .disableRegistry(true)
            .telemetry(telemetry)
            .handle(
                "email.send",
                Object.class,
                (context, payload) -> {
                  throw new IllegalStateException("the handler failed");
                })
            .build();
    try {
      subject.runOnce();
    } catch (RuntimeException expected) {
      // The failed settlement can end the pass.
    }

    LogRecordData finished = only("workhorse.handler.finished");
    assertEquals(taskId.toString(), value(finished, Names.TASK_ID));
    assertEquals(List.of(), recording.logs("workhorse.task.execution_finished"));
  }

  /**
   * As in TypeScript, run() writes its start record first: before the readiness check and before
   * the first registration. A failed readiness check thus still has a start record.
   */
  @Test
  void writesTheStartRecordBeforeTheReadinessCheckAndTheRegistration() throws InterruptedException {
    Worker refused =
        Worker.builder(refusing(dataSource))
            .queues(queueName)
            .pollingOnly(true)
            .disableRegistry(true)
            .telemetry(telemetry)
            .handle("email.send", Object.class, (context, payload) -> null)
            .build();
    assertThrows(WorkhorseException.class, refused::run);
    assertEquals(1, recording.logs("workhorse.worker.started").size());
    assertEquals(List.of(), recording.logs("workhorse.worker.stopped"));

    Worker subject =
        worker()
            .disableRegistry(false)
            .workerId("start-order-worker")
            .handle("email.send", Object.class, (context, payload) -> null)
            .build();
    subject.start();
    try {
      waitUntil(() -> !recording.logs("workhorse.worker.registered").isEmpty());
    } finally {
      subject.close();
    }
    List<LogRecordData> logs = recording.logs();
    LogRecordData started = recording.logs("workhorse.worker.started").get(1);
    LogRecordData registered = recording.logs("workhorse.worker.registered").get(0);
    assertTrue(
        logs.indexOf(started) < logs.indexOf(registered),
        "the start record comes before the first registration record");
  }

  /**
   * TypeScript writes the canceled outcome only after PostgreSQL accepts the acknowledgement. The
   * heartbeat submits the cancellation first. If acknowledge_cancel_v1 then fails or PostgreSQL
   * refuses it, the worker settled nothing, so it writes no execution record.
   */
  @ParameterizedTest
  @ValueSource(strings = {"fails", "refused"})
  void writesNoExecutionRecordForAnUnacknowledgedCancellation(String acknowledgement) {
    UUID taskId = enqueue("cancellable", EnqueueOptions.builder());
    Worker subject =
        Worker.builder(unacknowledgedCancellation(dataSource, acknowledgement.equals("fails")))
            .queues(queueName)
            .pollingOnly(true)
            .pollInterval(Duration.ofMillis(10))
            .disableRegistry(true)
            .lease(Duration.ofSeconds(5))
            .heartbeat(Duration.ofMillis(100))
            .telemetry(telemetry)
            .handle(
                "cancellable",
                Object.class,
                (context, payload) -> {
                  queue.cancel(taskId, "test", "no longer needed");
                  assertTrue(context.cancellation().await(WAIT), "the heartbeat cancels");
                  throw new IllegalStateException("the handler stopped for the cancellation");
                })
            .build();
    try {
      subject.runOnce();
    } catch (RuntimeException expected) {
      // The failed acknowledgement can end the pass.
    }

    LogRecordData finished = only("workhorse.handler.finished");
    assertEquals(taskId.toString(), value(finished, Names.TASK_ID));
    assertEquals(List.of(), recording.logs("workhorse.task.execution_finished"));
  }

  /** {@code source}, which refuses every connection. */
  private static javax.sql.DataSource refusing(javax.sql.DataSource source) {
    return (javax.sql.DataSource)
        Proxy.newProxyInstance(
            javax.sql.DataSource.class.getClassLoader(),
            new Class<?>[] {javax.sql.DataSource.class},
            (proxy, method, arguments) -> {
              if (method.getName().equals("getConnection")) {
                throw new SQLException("the test refuses every connection", "08001");
              }
              return invoke(method, source, arguments);
            });
  }

  /**
   * {@code source}, whose connections fail each {@code acknowledge_cancel_v1} statement if {@code
   * fail} is true. Otherwise they answer it with {@code false}, as PostgreSQL does when it refuses
   * the acknowledgement.
   */
  private static javax.sql.DataSource unacknowledgedCancellation(
      javax.sql.DataSource source, boolean fail) {
    String call = "workhorse.acknowledge_cancel_v1(?::uuid, ?::text, ?::bigint)";
    return (javax.sql.DataSource)
        Proxy.newProxyInstance(
            javax.sql.DataSource.class.getClassLoader(),
            new Class<?>[] {javax.sql.DataSource.class},
            (proxy, method, arguments) -> {
              Object result = invoke(method, source, arguments);
              if (!method.getName().equals("getConnection")) {
                return result;
              }
              Connection connection = (Connection) result;
              return Proxy.newProxyInstance(
                  Connection.class.getClassLoader(),
                  new Class<?>[] {Connection.class},
                  (inner, statement, values) -> {
                    if (statement.getName().equals("prepareStatement")
                        && String.valueOf(values[0]).contains(call)) {
                      if (fail) {
                        throw new SQLException("injected acknowledgement failure", "XX000");
                      }
                      Object[] refused = values.clone();
                      refused[0] =
                          String.valueOf(values[0])
                              .replace(
                                  call,
                                  "(?::uuid IS NULL AND ?::text IS NULL AND ?::bigint IS NULL)");
                      return invoke(statement, connection, refused);
                    }
                    return invoke(statement, connection, values);
                  });
            });
  }

  /** {@code source}, whose connections refuse each {@code fail_v2} statement. */
  private static javax.sql.DataSource failingSettlement(javax.sql.DataSource source) {
    return (javax.sql.DataSource)
        Proxy.newProxyInstance(
            javax.sql.DataSource.class.getClassLoader(),
            new Class<?>[] {javax.sql.DataSource.class},
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
                        && String.valueOf(values[0]).contains("workhorse.fail_v2(")) {
                      throw new SQLException("injected settlement failure", "XX000");
                    }
                    return invoke(call, connection, values);
                  });
            });
  }

  private static @Nullable Object invoke(Method method, Object target, @Nullable Object[] arguments)
      throws Throwable {
    try {
      return method.invoke(target, arguments);
    } catch (InvocationTargetException error) {
      throw error.getCause();
    }
  }

  @Test
  void aFailingLoggerChangesNoQueueOrWorkerResult() {
    AtomicInteger emitted = new AtomicInteger();
    try (OpenTelemetrySdk failing =
        OpenTelemetrySdk.builder()
            .setLoggerProvider(
                SdkLoggerProvider.builder()
                    .addLogRecordProcessor(
                        (context, log) -> {
                          emitted.incrementAndGet();
                          throw new IllegalStateException("the logger failed");
                        })
                    .build())
            .build()) {
      WorkhorseTelemetry failingTelemetry = WorkhorseTelemetry.of(failing);
      Queue failingQueue =
          new Queue(
              ConnectionSource.of(dataSource),
              QueueOptions.builder().telemetry(failingTelemetry).build());
      UUID canceled =
          failingQueue
              .enqueue("email.send", Map.of(), EnqueueOptions.builder().queue(queueName).build())
              .taskId();
      assertEquals(CancelStatus.CANCELED, failingQueue.cancel(canceled, null, null).status());
      UUID handled =
          failingQueue
              .enqueue("email.send", Map.of(), EnqueueOptions.builder().queue(queueName).build())
              .taskId();

      List<UUID> ran = new java.util.concurrent.CopyOnWriteArrayList<>();
      Worker subject =
          worker()
              .telemetry(failingTelemetry)
              .logger(new FailingLogger())
              .handle(
                  "email.send",
                  Object.class,
                  (context, payload) -> {
                    ran.add(context.task().id());
                    return null;
                  })
              .build();
      assertTrue(subject.runOnce());
      subject.stop();

      assertEquals(List.of(handled), ran);
      assertTrue(emitted.get() > 0, "the logger got records");
    }
  }

  @Test
  void aDisabledLoggerGetsNoQueueRecord() {
    AtomicInteger built = new AtomicInteger();
    io.opentelemetry.api.logs.Logger disabled =
        new io.opentelemetry.api.logs.Logger() {
          @Override
          public boolean isEnabled(Severity severity, io.opentelemetry.context.Context context) {
            return false;
          }

          @Override
          public io.opentelemetry.api.logs.LogRecordBuilder logRecordBuilder() {
            built.incrementAndGet();
            return io.opentelemetry.api.logs.LoggerProvider.noop()
                .get("workhorse")
                .logRecordBuilder();
          }
        };
    io.opentelemetry.api.OpenTelemetry openTelemetry =
        new io.opentelemetry.api.OpenTelemetry() {
          @Override
          public io.opentelemetry.api.trace.TracerProvider getTracerProvider() {
            return io.opentelemetry.api.trace.TracerProvider.noop();
          }

          @Override
          public io.opentelemetry.context.propagation.ContextPropagators getPropagators() {
            return io.opentelemetry.context.propagation.ContextPropagators.noop();
          }

          @Override
          public io.opentelemetry.api.logs.LoggerProvider getLogsBridge() {
            return name ->
                new io.opentelemetry.api.logs.LoggerBuilder() {
                  @Override
                  public io.opentelemetry.api.logs.LoggerBuilder setSchemaUrl(String url) {
                    return this;
                  }

                  @Override
                  public io.opentelemetry.api.logs.LoggerBuilder setInstrumentationVersion(
                      String version) {
                    return this;
                  }

                  @Override
                  public io.opentelemetry.api.logs.Logger build() {
                    return disabled;
                  }
                };
          }
        };
    Queue quiet =
        new Queue(
            ConnectionSource.of(dataSource),
            QueueOptions.builder().telemetry(WorkhorseTelemetry.of(openTelemetry)).build());
    UUID taskId =
        quiet
            .enqueue("email.send", Map.of(), EnqueueOptions.builder().queue(queueName).build())
            .taskId();
    assertEquals(CancelStatus.CANCELED, quiet.cancel(taskId, null, null).status());
    quiet.syncSchedules("disabled-logger-" + UUID.randomUUID(), List.of());

    assertEquals(0, built.get());
  }

  /** A {@code System.Logger} that accepts every level and throws for each record. */
  private static final class FailingLogger implements System.Logger {
    @Override
    public String getName() {
      return "failing";
    }

    @Override
    public boolean isLoggable(Level level) {
      return true;
    }

    @Override
    public void log(
        Level level,
        @Nullable ResourceBundle bundle,
        @Nullable String message,
        @Nullable Throwable thrown) {
      throw new IllegalStateException("the logger failed");
    }

    @Override
    public void log(
        Level level,
        @Nullable ResourceBundle bundle,
        @Nullable String format,
        @Nullable Object... params) {
      throw new IllegalStateException("the logger failed");
    }
  }

  private static void assertLog(LogRecordData log, Severity severity, String body) {
    assertEquals(severity, log.getSeverity());
    assertEquals(severity.name(), log.getSeverityText());
    assertEquals(body, log.getBodyValue().asString());
  }

  private static String wire(Enum<?> value) {
    return value.name().toLowerCase(java.util.Locale.ROOT);
  }

  @Test
  void emitsAnEnqueueLogForEachOutcome() {
    EnqueueOptions replay =
        EnqueueOptions.builder()
            .queue(queueName)
            .idempotency(new Idempotency("replay-" + UUID.randomUUID()))
            .build();
    EnqueueOptions debounce =
        EnqueueOptions.builder()
            .queue(queueName)
            .debounce(new Debounce("debounce-" + UUID.randomUUID(), Duration.ofMinutes(1)))
            .build();
    EnqueueOptions throttle =
        EnqueueOptions.builder()
            .queue(queueName)
            .throttle(new Throttle("throttle-" + UUID.randomUUID(), Duration.ofMinutes(1)))
            .build();
    UUID accepted = queue.enqueue("replay", Map.of(), replay).taskId();
    queue.enqueue("replay", Map.of(), replay);
    UUID debounced = queue.enqueue("debounce", Map.of(), debounce).taskId();
    queue.enqueue("debounce", Map.of(), debounce);
    queue.cancel(debounced, "test", null);
    UUID rejected = queue.enqueue("debounce", Map.of(), debounce).taskId();
    UUID throttled = queue.enqueue("throttle", Map.of(), throttle).taskId();
    queue.enqueue("throttle", Map.of(), throttle);

    List<LogRecordData> enqueued = recording.logs("workhorse.task.enqueued");
    assertEquals(3, enqueued.size());
    LogRecordData first = enqueued.get(0);
    assertLog(first, Severity.DEBUG, "Task enqueued");
    assertEquals(accepted.toString(), value(first, Names.TASK_ID));
    assertEquals("replay", value(first, Names.TASK_TYPE));
    assertEquals(queueName, value(first, Names.QUEUE_NAME));
    assertEquals(
        Map.of(
            "workhorse.task.enqueue_replayed", List.of("Idempotent enqueue replayed", accepted),
            "workhorse.task.debounced", List.of("Pending task replaced", debounced),
            "workhorse.task.debounce_rejected", List.of("Debounced task not replaceable", rejected),
            "workhorse.task.throttled", List.of("Throttled enqueue coalesced", throttled)),
        Map.of(
            "workhorse.task.enqueue_replayed", detail("workhorse.task.enqueue_replayed"),
            "workhorse.task.debounced", detail("workhorse.task.debounced"),
            "workhorse.task.debounce_rejected", detail("workhorse.task.debounce_rejected"),
            "workhorse.task.throttled", detail("workhorse.task.throttled")));
    for (String event :
        List.of(
            "workhorse.task.enqueue_replayed",
            "workhorse.task.debounced",
            "workhorse.task.debounce_rejected",
            "workhorse.task.throttled")) {
      LogRecordData log = only(event);
      assertEquals(Severity.DEBUG, log.getSeverity(), event);
      assertEquals(queueName, value(log, Names.QUEUE_NAME), event);
      assertEquals(3, log.getAttributes().size(), event);
    }
  }

  /** The body and the task ID of the one record of {@code event}. */
  private List<Object> detail(String event) {
    LogRecordData log = only(event);
    return List.of(
        log.getBodyValue().asString(), UUID.fromString((String) value(log, Names.TASK_ID)));
  }

  @Test
  void emitsAnEnqueueLogForEachTaskGroupMember() {
    EnqueueOptions options = EnqueueOptions.builder().queue(queueName).build();
    TaskGroupBlockResult block =
        queue.taskGroup(
            TaskGroupCallbacks.none(),
            group -> group.add(List.of(EnqueueRequest.of("member", Map.of(), options))));
    TaskGroup open = queue.createTaskGroup(TaskGroupCallbacks.none());
    UUID added =
        queue
            .addToTaskGroup(open.id(), List.of(EnqueueRequest.of("added", Map.of(), options)))
            .get(0)
            .taskId();

    List<LogRecordData> enqueued = recording.logs("workhorse.task.enqueued");
    assertEquals(
        List.of(block.tasks().get(0).taskId().toString(), added.toString()),
        enqueued.stream().map(log -> value(log, Names.TASK_ID)).toList());
    assertEquals(
        List.of("member", "added"),
        enqueued.stream().map(log -> value(log, Names.TASK_TYPE)).toList());
  }

  @Test
  void emitsTheCancellationLog() {
    UUID taskId = enqueue("cancel", EnqueueOptions.builder());
    CancelResult result = queue.cancel(taskId, "test", "no longer needed");
    UUID missing = UUID.randomUUID();
    queue.cancel(missing, "test", null);

    List<LogRecordData> logs = recording.logs("workhorse.task.cancellation_processed");
    assertEquals(2, logs.size());
    LogRecordData cancelled = logs.get(0);
    assertLog(cancelled, Severity.INFO, "Task cancellation processed");
    assertEquals(taskId.toString(), value(cancelled, Names.TASK_ID));
    assertEquals(
        wire(java.util.Objects.requireNonNull(result.state())),
        value(cancelled, "workhorse.task.state"));
    assertEquals(wire(result.status()), value(cancelled, "workhorse.operation.status"));
    assertEquals(3, cancelled.getAttributes().size());
    LogRecordData notFound = logs.get(1);
    assertEquals(missing.toString(), value(notFound, Names.TASK_ID));
    assertEquals("not_found", value(notFound, "workhorse.task.state"));
    assertEquals("not_found", value(notFound, "workhorse.operation.status"));
  }

  @Test
  void emitsTheScheduleSynchronizationLog() {
    String namespace = "schedules-" + UUID.randomUUID();
    queue.syncSchedules(
        namespace,
        List.of(
            new ScheduleDefinition("hourly", "0 * * * *", ScheduledTask.of("report", null)),
            new ScheduleDefinition("daily", "0 3 * * *", ScheduledTask.of("report", null))));

    LogRecordData log = only("workhorse.schedules.synchronized");
    assertLog(log, Severity.INFO, "Recurring schedules synchronized");
    assertEquals(namespace, value(log, Names.SCHEDULE_NAMESPACE));
    assertEquals(2L, value(log, "workhorse.schedule.count"));
    assertEquals(2, log.getAttributes().size());
  }

  @Test
  void emitsTheAdminQueueAndRedriveLogs() {
    Admin admin = new Admin(ConnectionSource.of(dataSource), telemetry);
    AdminAudit audit = new AdminAudit("operator", "investigating", UUID.randomUUID().toString());
    admin.pauseQueue(queueName, audit);
    admin.resumeQueue(queueName, new AdminAudit("operator", "done", UUID.randomUUID().toString()));
    admin.setQueueTier(queueName, QueueTier.FULL, audit);
    enqueue("purged", EnqueueOptions.builder());
    long purged =
        admin.purgeQueue(
            queueName, new AdminAudit("operator", "clean", UUID.randomUUID().toString()));
    UUID missing = UUID.randomUUID();
    RedriveResult redrive =
        admin.redrive(missing, new AdminAudit("operator", "retry", UUID.randomUUID().toString()));
    admin.redriveMany(
        RedriveFilter.builder().queue(queueName).dryRun(true).build(),
        new AdminAudit("operator", "retry", UUID.randomUUID().toString()));

    LogRecordData paused = only("workhorse.queue.paused");
    assertLog(paused, Severity.INFO, "Queue paused");
    assertEquals(queueName, value(paused, Names.QUEUE_NAME));
    assertEquals(1, paused.getAttributes().size());
    LogRecordData resumed = only("workhorse.queue.resumed");
    assertLog(resumed, Severity.INFO, "Queue resumed");
    assertEquals(queueName, value(resumed, Names.QUEUE_NAME));
    LogRecordData tier = only("workhorse.queue.tier_set");
    assertLog(tier, Severity.INFO, "Queue tier set");
    assertEquals(queueName, value(tier, Names.QUEUE_NAME));
    assertEquals("full", value(tier, Names.QUEUE_TIER));
    LogRecordData purge = only("workhorse.queue.purged");
    assertLog(purge, Severity.INFO, "Queue purged");
    assertEquals(queueName, value(purge, Names.QUEUE_NAME));
    assertEquals(1L, purged);
    assertEquals(purged, value(purge, "workhorse.task.count"));
    LogRecordData one = only("workhorse.task.redrive_processed");
    assertLog(one, Severity.INFO, "Dead-letter task redrive processed");
    assertEquals(missing.toString(), value(one, Names.TASK_ID));
    assertEquals("none", value(one, "workhorse.redrive.target_task_id"));
    assertEquals(wire(redrive.status()), value(one, "workhorse.operation.status"));
    assertEquals(3, one.getAttributes().size());
    LogRecordData many = only("workhorse.tasks.redrive_processed");
    assertLog(many, Severity.INFO, "Dead-letter task redrive batch processed");
    assertEquals(0L, value(many, "workhorse.task.count"));
    assertEquals(true, value(many, "workhorse.redrive.dry_run"));
    assertEquals(2, many.getAttributes().size());
  }

  @Test
  void emitsTheAdminWorkerPauseLogs() throws SQLException {
    try (Connection connection = dataSource.getConnection()) {
      Sql.rows(
          connection,
          SqlCatalogue.REGISTER_WORKER_V1,
          "paused-worker",
          UUID.randomUUID().toString(),
          "log-test-host",
          "42",
          new String[] {queueName},
          new String[] {},
          "1",
          "30000",
          "10000",
          "250",
          "1000",
          "60000",
          "5000",
          "0",
          "false",
          null,
          null,
          null);
    }
    Admin admin = new Admin(ConnectionSource.of(dataSource), telemetry);
    assertTrue(
        admin
            .setWorkerPaused(
                "paused-worker",
                true,
                new AdminAudit("operator", "pause", UUID.randomUUID().toString()))
            .isPresent());
    admin.setWorkerPaused(
        "paused-worker", false, new AdminAudit("operator", "resume", UUID.randomUUID().toString()));
    admin.setWorkerPaused(
        "missing-worker", true, new AdminAudit("operator", "pause", UUID.randomUUID().toString()));

    for (String event : List.of("workhorse.worker.paused", "workhorse.worker.resumed")) {
      List<LogRecordData> logs =
          recording.logs(event).stream()
              .filter(
                  log ->
                      log.getBodyValue()
                          .asString()
                          .equals(event.endsWith("paused") ? "Worker paused" : "Worker resumed"))
              .toList();
      assertEquals(1, logs.size(), event + " records");
      assertEquals(Severity.INFO, logs.get(0).getSeverity());
      assertEquals(
          Map.of(AttributeKey.stringKey(Names.WORKER_ID), "paused-worker"),
          logs.get(0).getAttributes().asMap());
    }
  }

  @Test
  void emitsTheBackgroundRoutineMaintenanceLogs() {
    execute(
        "CREATE OR REPLACE FUNCTION workhorse.run_maintenance_v1("
            + " p_now timestamptz DEFAULT clock_timestamp())"
            + " RETURNS TABLE (phase text, rows_affected integer, duration_ms integer,"
            + " skipped_lock boolean, error jsonb) LANGUAGE sql AS $body$"
            + " VALUES ('history_retention', 4, 1, false, NULL::jsonb),"
            + " ('stat_rollup', 0, 1, false, NULL::jsonb),"
            + " ('terminal_storage', 0, 1, false, '{\"message\": \"never-log-this\"}'::jsonb)"
            + " $body$",
        null);
    worker().handle("other", Object.class, (context, payload) -> null).build().runOnce();

    List<LogRecordData> routines =
        recording.logs("workhorse.maintenance.completed").stream()
            .filter(
                log -> "background_routines".equals(value(log, "workhorse.maintenance.operation")))
            .toList();
    assertEquals(2, routines.size(), "background routine records");
    assertEquals("history_retention", value(routines.get(0), Names.MAINTENANCE_PHASE));
    assertEquals(4L, value(routines.get(0), "workhorse.maintenance.rows_affected"));
    assertEquals("terminal_storage", value(routines.get(1), Names.MAINTENANCE_PHASE));
    assertEquals(0L, value(routines.get(1), "workhorse.maintenance.rows_affected"));
    for (LogRecordData log : routines) {
      assertLog(log, Severity.INFO, "Maintenance phase completed");
      assertEquals(false, value(log, Names.MAINTENANCE_SKIPPED_LOCK));
      assertEquals(null, value(log, "error.type"));
      assertTrue(!log.toString().contains("never-log-this"), log.toString());
    }
  }

  @Test
  void emitsTheAcceptedHeartbeatLog() {
    UUID taskId = enqueue("beating", EnqueueOptions.builder());
    Worker subject =
        worker()
            .workerId("heartbeat-worker")
            .lease(Duration.ofSeconds(5))
            .heartbeat(Duration.ofMillis(50))
            .handle(
                "beating",
                Object.class,
                (context, payload) -> {
                  waitUntil(() -> !recording.logs("workhorse.task.heartbeat_accepted").isEmpty());
                  return null;
                })
            .build();
    assertTrue(subject.runOnce());

    LogRecordData log = recording.logs("workhorse.task.heartbeat_accepted").get(0);
    assertLog(log, Severity.DEBUG, "Task heartbeat accepted");
    assertEquals(taskId.toString(), value(log, Names.TASK_ID));
    assertEquals("beating", value(log, Names.TASK_TYPE));
    assertEquals(1L, value(log, Names.TASK_ATTEMPT));
    assertEquals("heartbeat-worker", value(log, Names.WORKER_ID));
  }

  @Test
  void emitsTheRecoveredLeasesLog() {
    UUID taskId = enqueue("lapsed", EnqueueOptions.builder().maxAttempts(1));
    Worker recovering = worker().handle("other", Object.class, (context, payload) -> null).build();
    Worker subject =
        worker()
            .lease(Duration.ofSeconds(30))
            .heartbeat(Duration.ofSeconds(20))
            .handle(
                "lapsed",
                Object.class,
                (context, payload) -> {
                  execute(
                      "UPDATE workhorse.task_runtime SET expires_at = clock_timestamp()"
                          + " - interval '1 minute' WHERE task_id = ?::uuid",
                      taskId.toString());
                  // The maintenance pass of this run recovers the expired lease.
                  recovering.runOnce();
                  return null;
                })
            .build();
    assertTrue(subject.runOnce());

    LogRecordData log = only("workhorse.leases.recovered");
    assertLog(log, Severity.INFO, "Expired leases recovered");
    assertTrue((Long) value(log, Names.RECOVERY_ROWS_AFFECTED) >= 1L, "rows affected");
    assertEquals(1L, value(log, Names.RECOVERY_EXPIRED_LEASES));
    assertEquals(0L, value(log, Names.RECOVERY_RETRIED));
  }

  @Test
  void emitsTheShutdownSettlementFailure() throws InterruptedException {
    UUID taskId = enqueue("stopped", EnqueueOptions.builder());
    execute(
        "CREATE FUNCTION public.refuse_release() RETURNS trigger LANGUAGE plpgsql"
            + " AS $$ BEGIN RAISE EXCEPTION 'release refused'; END; $$",
        null);
    execute(
        "CREATE TRIGGER refuse_release BEFORE INSERT ON workhorse.task_event FOR EACH ROW"
            + " WHEN (NEW.event_type = 'released' AND NEW.task_id = '"
            + taskId
            + "') EXECUTE FUNCTION public.refuse_release()",
        null);
    CountDownLatch started = new CountDownLatch(1);
    Worker subject =
        worker()
            .workerId("settlement-worker")
            .shutdownGrace(Duration.ofMillis(100))
            .handle(
                "stopped",
                Object.class,
                (context, payload) -> {
                  started.countDown();
                  context.cancellation().await(WAIT);
                  context.cancellation().throwIfCancelled();
                  return null;
                })
            .build();
    subject.start();
    try {
      assertTrue(started.await(WAIT.toMillis(), TimeUnit.MILLISECONDS));
      try {
        subject.close();
      } catch (RuntimeException expected) {
        // The failed release ends the run with its error.
      }
      waitUntil(() -> !recording.logs("workhorse.worker.shutdown_settlement_failed").isEmpty());
    } finally {
      execute("DROP TRIGGER refuse_release ON workhorse.task_event", null);
      execute("DROP FUNCTION public.refuse_release()", null);
    }

    LogRecordData log = only("workhorse.worker.shutdown_settlement_failed");
    assertLog(log, Severity.WARN, "Worker could not settle a task after the shutdown abort");
    assertEquals(taskId.toString(), value(log, Names.TASK_ID));
    assertEquals("stopped", value(log, Names.TASK_TYPE));
    assertEquals(1L, value(log, Names.TASK_ATTEMPT));
    assertEquals(queueName, value(log, Names.QUEUE_NAME));
    assertEquals("settlement-worker", value(log, Names.WORKER_ID));
    assertTrue(value(log, "error.type") instanceof String, "error type");
  }

  @Test
  void keepsAnEventThatOnlyTheJavaSdkWritesOutOfOpenTelemetry() {
    Worker subject =
        worker().handle("email.send", Object.class, (context, payload) -> null).build();
    subject.log(System.Logger.Level.WARNING, "workhorse.worker.claims_abandoned", "test", Map.of());
    assertEquals(List.of(), recording.logs("workhorse.worker.claims_abandoned"));
  }
}
