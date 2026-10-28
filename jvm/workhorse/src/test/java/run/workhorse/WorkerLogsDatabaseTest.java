package run.workhorse;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import io.opentelemetry.api.common.AttributeKey;
import io.opentelemetry.api.logs.Severity;
import io.opentelemetry.sdk.logs.data.LogRecordData;
import io.opentelemetry.sdk.trace.data.SpanData;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.SQLException;
import java.time.Duration;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.function.BooleanSupplier;
import org.jspecify.annotations.Nullable;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
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

  private void execute(String sql, String parameter) {
    try (Connection connection = dataSource.getConnection();
        PreparedStatement statement = connection.prepareStatement(sql)) {
      statement.setString(1, parameter);
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
    LogRecordData started = only("workhorse.worker.started");
    assertEquals(queues, value(started, Names.WORKER_QUEUES));
    assertEquals(5L, value(started, Names.WORKER_CONCURRENCY));
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
    assertEquals(0L, value(only("workhorse.worker.stopped"), Names.WORKER_ACTIVE_SLOTS));
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

  @Test
  void emitsThePollingOnlyWarningAndTheMaintenanceDrift() throws InterruptedException {
    // The listener's LISTEN stalls on a DataSource of unknown size, so the worker polls.
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
    LogRecordData polling = only("workhorse.worker.polling_only");
    assertEquals("unknown", value(polling, Names.WORKER_POOL_MAX_SIZE));
    assertEquals(List.of(queueName), value(polling, Names.WORKER_QUEUES));
    assertTrue(
        recording.metrics().stream()
            .filter(metric -> metric.getName().equals("workhorse.maintenance.drift"))
            .flatMap(metric -> metric.getData().getPoints().stream())
            .map(point -> point.getAttributes().get(AttributeKey.stringKey(Names.MAINTENANCE_LOOP)))
            .toList()
            .contains("tick"));
  }

  @Test
  void keepsAnEventThatOnlyTheJavaSdkWritesOutOfOpenTelemetry() {
    Worker subject =
        worker().handle("email.send", Object.class, (context, payload) -> null).build();
    subject.log(System.Logger.Level.WARNING, "workhorse.worker.claims_abandoned", "test", Map.of());
    assertEquals(List.of(), recording.logs("workhorse.worker.claims_abandoned"));
  }
}
