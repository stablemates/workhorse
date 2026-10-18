package dev.stablemates.workhorse;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import dev.stablemates.workhorse.internal.Json;
import dev.stablemates.workhorse.testing.ScratchDataSource;
import dev.stablemates.workhorse.testing.ScratchDatabase;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.BooleanSupplier;
import org.jspecify.annotations.Nullable;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.extension.ExtendWith;

/**
 * The Java worker against PostgreSQL: one or more tests for each worker runtime row of {@code
 * docs/parity.md} that SM-1386 owns. Every wait is bounded.
 */
@ExtendWith(ScratchDatabase.class)
@Timeout(value = 120, unit = TimeUnit.SECONDS)
class WorkerDatabaseTest {
  private static final Duration WAIT = Duration.ofSeconds(20);
  private static final String STATUS =
      "SELECT COALESCE(o.state, r.state) AS state, o.result::text AS result,"
          + " COALESCE(o.error, r.error)::text AS error,"
          + " COALESCE(o.current_attempt, r.current_attempt) AS attempt, r.worker_id"
          + " FROM workhorse.task t"
          + " LEFT JOIN workhorse.task_runtime r ON r.task_id = t.id"
          + " LEFT JOIN workhorse.task_outcome o ON o.task_id = t.id"
          + " WHERE t.id = ?::uuid";

  private final ScratchDataSource dataSource = new ScratchDataSource(true);
  private final Queue queue = new Queue(ConnectionSource.of(dataSource));
  private String queueName = "";

  @BeforeEach
  void name() {
    queueName = "jvm-worker-" + UUID.randomUUID();
  }

  private Worker.Builder worker() {
    return Worker.builder(dataSource)
        .queues(queueName)
        .pollingOnly(true)
        .pollInterval(Duration.ofMillis(10))
        .disableRegistry(true);
  }

  private UUID enqueue(String taskType, @Nullable Object payload) {
    return enqueue(taskType, payload, EnqueueOptions.builder());
  }

  private UUID enqueue(String taskType, @Nullable Object payload, EnqueueOptions.Builder options) {
    return queue.enqueue(taskType, payload, options.queue(queueName).build()).taskId();
  }

  private record Status(
      String state,
      @Nullable String result,
      @Nullable String error,
      int attempt,
      @Nullable String workerId) {}

  private static Status status(UUID taskId) throws SQLException {
    try (Connection connection = ScratchDatabase.connect();
        PreparedStatement statement = connection.prepareStatement(STATUS)) {
      statement.setString(1, taskId.toString());
      try (ResultSet result = statement.executeQuery()) {
        assertTrue(result.next(), "the task exists");
        return new Status(
            result.getString("state"),
            result.getString("result"),
            result.getString("error"),
            result.getInt("attempt"),
            result.getString("worker_id"));
      }
    }
  }

  private static void execute(String sql, String parameter) throws SQLException {
    try (Connection connection = ScratchDatabase.connect();
        PreparedStatement statement = connection.prepareStatement(sql)) {
      statement.setString(1, parameter);
      statement.execute();
    }
  }

  private static long count(String sql, String parameter) throws SQLException {
    try (Connection connection = ScratchDatabase.connect();
        PreparedStatement statement = connection.prepareStatement(sql)) {
      statement.setString(1, parameter);
      try (ResultSet result = statement.executeQuery()) {
        result.next();
        return result.getLong(1);
      }
    }
  }

  private static void waitUntil(String what, BooleanSupplier condition) {
    long deadline = System.nanoTime() + WAIT.toNanos();
    while (!condition.getAsBoolean()) {
      if (System.nanoTime() > deadline) {
        throw new AssertionError("timed out waiting until " + what);
      }
      try {
        Thread.sleep(10);
      } catch (InterruptedException interrupted) {
        Thread.currentThread().interrupt();
        throw new AssertionError("interrupted waiting until " + what, interrupted);
      }
    }
  }

  private static void waitForState(UUID taskId, String state) {
    waitUntil(
        taskId + " is " + state,
        () -> {
          try {
            return status(taskId).state().equals(state);
          } catch (SQLException error) {
            throw new IllegalStateException(error);
          }
        });
  }

  private static void await(CountDownLatch latch, String what) throws InterruptedException {
    assertTrue(latch.await(WAIT.toSeconds(), TimeUnit.SECONDS), "timed out waiting for " + what);
  }

  private static @Nullable Object json(@Nullable String text) {
    return text == null ? null : Json.parse(text);
  }

  // The run state.

  @Test
  void isRunningCoversAStartedRunAndItsDrain() throws Exception {
    CountDownLatch entered = new CountDownLatch(1);
    CountDownLatch release = new CountDownLatch(1);
    Worker worker =
        worker()
            .shutdownGrace(Duration.ofSeconds(30))
            .handle(
                "held",
                Object.class,
                (ctx, payload) -> {
                  entered.countDown();
                  release.await();
                  return null;
                })
            .build();
    assertFalse(worker.isRunning(), "a worker that never started does not run");
    worker.start();
    assertTrue(worker.isRunning(), "a started worker runs");
    enqueue("held", null);
    await(entered, "the handler");
    worker.stop();
    assertTrue(worker.isRunning(), "a stopped worker runs until its drain ends");
    release.countDown();
    worker.close();
    assertFalse(worker.isRunning(), "a closed worker does not run");
  }

  @Test
  void isRunningIsFalseAfterARunThatEndsWithAnError() throws Exception {
    Worker worker =
        worker()
            .executor(
                new java.util.concurrent.AbstractExecutorService() {
                  @Override
                  public void execute(Runnable command) {
                    throw new java.util.concurrent.RejectedExecutionException("refused");
                  }

                  @Override
                  public void shutdown() {}

                  @Override
                  public List<Runnable> shutdownNow() {
                    return List.of();
                  }

                  @Override
                  public boolean isShutdown() {
                    return false;
                  }

                  @Override
                  public boolean isTerminated() {
                    return false;
                  }

                  @Override
                  public boolean awaitTermination(long timeout, TimeUnit unit) {
                    return false;
                  }
                })
            .handle("refused", Object.class, (ctx, payload) -> null)
            .build();
    worker.start();
    enqueue("refused", null);
    waitUntil("the run ends", () -> !worker.isRunning());
    assertThrows(RuntimeException.class, worker::close);
    assertFalse(worker.isRunning());
  }

  // Claiming and handler execution.

  @Test
  void completesATaskAndStoresItsResult() throws SQLException {
    UUID taskId = enqueue("double", Map.of("n", 21L));
    AtomicReference<@Nullable ClaimedTask> seen = new AtomicReference<>();
    Worker worker =
        worker()
            .handle(
                "double",
                Map.class,
                (ctx, payload) -> {
                  seen.set(ctx.task());
                  return Map.of("doubled", (Long) payload.get("n") * 2);
                })
            .build();

    assertTrue(worker.runOnce());

    Status status = status(taskId);
    assertEquals("succeeded", status.state());
    assertEquals(Map.of("doubled", 42L), json(status.result()));
    ClaimedTask task = seen.get();
    assertNotNull(task);
    assertEquals(taskId, task.id());
    assertEquals(queueName, task.queue());
    assertEquals(1, task.attempt());
    assertTrue(task.fenceToken() > 0);
  }

  @Test
  void passesANullPayloadAndStoresANullResult() throws SQLException {
    UUID taskId = enqueue("nothing", null);
    AtomicBoolean sawNull = new AtomicBoolean();
    Worker worker =
        worker()
            .handle(
                "nothing",
                Object.class,
                (ctx, payload) -> {
                  sawNull.set(payload == null);
                  return null;
                })
            .build();

    assertTrue(worker.runOnce());
    assertTrue(sawNull.get());
    assertEquals("succeeded", status(taskId).state());
  }

  @Test
  void registersATaskHandlerUnderItsOwnTypes() throws SQLException {
    UUID taskId = enqueue("typed", List.of(1L, 2L));
    TaskHandler<List<?>> handler =
        new TaskHandler<>() {
          @Override
          public String taskType() {
            return "typed";
          }

          @Override
          public java.lang.reflect.Type payloadType() {
            return List.class;
          }

          @Override
          public Object handle(HandlerContext ctx, List<?> payload) {
            return payload.size();
          }
        };

    assertTrue(worker().handle(handler).build().runOnce());
    assertEquals(2L, json(status(taskId).result()));
  }

  @Test
  void claimsInAutocommitAndRestoresAPoolConnectionThatStartsWithItOff() throws SQLException {
    ScratchDataSource manual = new ScratchDataSource(false);
    UUID taskId =
        queue.enqueue("echo", "x", EnqueueOptions.builder().queue(queueName).build()).taskId();
    Worker worker =
        Worker.builder(manual)
            .queues(queueName)
            .pollingOnly(true)
            .disableRegistry(true)
            .sharedHeartbeats(true)
            .handle("echo", String.class, (ctx, payload) -> payload)
            .build();

    assertTrue(worker.runOnce());
    assertEquals("succeeded", status(taskId).state());
    assertFalse(manual.autoCommitAtClose().contains(true), "every connection goes back as it came");
  }

  @Test
  void recordsAFailureAndSchedulesTheRetryByTheTasksPolicy() throws SQLException {
    UUID taskId = enqueue("flaky", Map.of(), EnqueueOptions.builder().maxAttempts(2));
    Worker worker =
        worker()
            .handle(
                "flaky",
                Object.class,
                (ctx, payload) -> {
                  throw new IllegalStateException("card declined");
                })
            .build();

    assertTrue(worker.runOnce());

    Status retried = status(taskId);
    assertEquals("scheduled", retried.state(), "the persisted policy delays the retry");
    assertEquals(2, retried.attempt(), "the runtime row holds the next attempt");
    Map<String, @Nullable Object> error = Json.object(json(retried.error()));
    assertNotNull(error);
    assertEquals("IllegalStateException", error.get("name"));
    assertEquals("card declined", error.get("message"));
    assertTrue(String.valueOf(error.get("stack")).contains("WorkerDatabaseTest"));
  }

  @Test
  void aRetryDelayOverrideReplacesThePolicyUntilTheAttemptsRunOut() throws SQLException {
    UUID taskId = enqueue("flaky", Map.of(), EnqueueOptions.builder().maxAttempts(2));
    List<Integer> attempts = new CopyOnWriteArrayList<>();
    Worker worker =
        worker()
            .retryDelay((attempt, task) -> Duration.ZERO)
            .handle(
                "flaky",
                Object.class,
                (ctx, payload) -> {
                  attempts.add(ctx.task().attempt());
                  throw new IllegalStateException("card declined");
                })
            .build();

    // A zero delay makes the retry ready at once, so one pass runs both attempts.
    assertTrue(worker.runOnce());

    assertEquals(List.of(1, 2), attempts);
    Status failed = status(taskId);
    assertEquals("failed", failed.state());
    assertEquals(2, failed.attempt());
  }

  @Test
  void failsAnAttemptWhoseResultBreaksTheRegisteredContract() throws SQLException {
    String taskType = "contracted." + queueName;
    queue.syncContracts(
        Map.of(
            taskType,
            new TaskTypeContracts(
                "v1",
                Map.of(
                    "v1",
                    new TaskContractVersion(
                        Map.of(), Map.of("type", "object", "required", List.of("ok")))))));
    UUID taskId = enqueue(taskType, Map.of(), EnqueueOptions.builder().maxAttempts(1));

    assertTrue(
        worker()
            .handle(taskType, Object.class, (ctx, p) -> Map.of("wrong", true))
            .build()
            .runOnce());

    Status status = status(taskId);
    assertEquals("failed", status.state());
    Map<String, @Nullable Object> error = Json.object(json(status.error()));
    assertNotNull(error);
    assertEquals("ContractValidationException", error.get("name"));
  }

  @Test
  void failsAnAttemptWhoseResultPostgreSqlCannotStore() throws SQLException {
    UUID taskId = enqueue("nul", Map.of(), EnqueueOptions.builder().maxAttempts(1));

    assertTrue(worker().handle("nul", Object.class, (ctx, p) -> "a\0b").build().runOnce());

    Status status = status(taskId);
    assertEquals("failed", status.state(), "the attempt fails, and the worker keeps running");
    assertEquals("IllegalArgumentException", Json.object(json(status.error())).get("name"));
  }

  // Bounded worker concurrency.

  @Test
  void runsAtMostConcurrencyHandlersOnVirtualThreads() throws Exception {
    assertBounded(worker().concurrency(3), 3, true);
  }

  @Test
  void runsHandlersOnTheCallerExecutorWithinTheConcurrency() throws Exception {
    ExecutorService executor = Executors.newFixedThreadPool(8);
    try {
      assertBounded(worker().concurrency(2).executor(executor), 2, false);
    } finally {
      executor.shutdownNow();
    }
  }

  private void assertBounded(Worker.Builder builder, int concurrency, boolean virtual)
      throws Exception {
    List<UUID> tasks = new ArrayList<>();
    for (int index = 0; index < 4 * concurrency; index++) {
      tasks.add(enqueue("busy", index));
    }
    AtomicInteger running = new AtomicInteger();
    AtomicInteger most = new AtomicInteger();
    // The first handlers wait here until `concurrency` of them run together.
    CountDownLatch together = new CountDownLatch(concurrency);
    List<Boolean> virtualThreads = new CopyOnWriteArrayList<>();
    Worker worker =
        builder
            .handle(
                "busy",
                Object.class,
                (ctx, payload) -> {
                  most.accumulateAndGet(running.incrementAndGet(), Math::max);
                  virtualThreads.add(Thread.currentThread().isVirtual());
                  together.countDown();
                  together.await(WAIT.toMillis(), TimeUnit.MILLISECONDS);
                  running.decrementAndGet();
                  return null;
                })
            .build();
    worker.start();
    try {
      for (UUID task : tasks) {
        waitForState(task, "succeeded");
      }
    } finally {
      worker.close();
    }
    assertTrue(most.get() <= concurrency, "at most " + concurrency + ", saw " + most.get());
    assertEquals(0, together.getCount(), concurrency + " handlers ran together");
    assertEquals(concurrency, most.get());
    assertFalse(virtualThreads.contains(!virtual));
  }

  // Unhandled task type released to its queue.

  @Test
  void releasesATaskWhoseTypeHasNoHandlerWithoutChargingTheAttempt() throws SQLException {
    UUID taskId = enqueue("unknown", Map.of());
    Worker worker = worker().handle("known", Object.class, (ctx, p) -> null).build();

    assertFalse(worker.runOnce(), "no handled task ran");

    Status status = status(taskId);
    assertEquals("ready", status.state());
    assertNull(status.workerId());
    assertNull(status.error());
  }

  // Heartbeats, lease recovery, fenced ownership.

  @Test
  void renewsTheLeaseOfAHandlerThatRunsLongerThanTheLease() throws SQLException {
    UUID taskId = enqueue("long", Map.of());
    Worker worker =
        worker()
            .lease(Duration.ofMillis(300))
            .heartbeat(Duration.ofMillis(50))
            .handle(
                "long",
                Object.class,
                (ctx, payload) -> {
                  Thread.sleep(1_000);
                  return Map.of("cancelled", ctx.isCancelled());
                })
            .build();

    assertTrue(worker.runOnce());
    Status status = status(taskId);
    assertEquals("succeeded", status.state());
    assertEquals(Map.of("cancelled", false), json(status.result()));
  }

  @Test
  void aStaleFenceTokenCannotCompleteTheTask() throws Exception {
    UUID taskId = enqueue("contested", Map.of());
    AtomicReference<@Nullable CancellationReason> reason = new AtomicReference<>();
    Worker worker =
        worker()
            .lease(Duration.ofSeconds(5))
            .heartbeat(Duration.ofMillis(100))
            .handle(
                "contested",
                Object.class,
                (ctx, payload) -> {
                  // Another attempt takes the task over: the stored fence token moves on.
                  execute(
                      "UPDATE workhorse.task_runtime SET fence_token = fence_token + 1"
                          + " WHERE task_id = ?::uuid",
                      taskId.toString());
                  ctx.cancellation().await(WAIT);
                  reason.set(ctx.cancellation().reason());
                  return Map.of("late", true);
                })
            .build();

    assertTrue(worker.runOnce());

    assertEquals(CancellationReason.LEASE_LOST, reason.get());
    Status status = status(taskId);
    assertEquals("active", status.state(), "the newer attempt still owns the task");
    assertNull(status.result(), "the stale attempt stored no result");
  }

  @Test
  void aStaleCompletionIsRejectedEvenBeforeTheHeartbeatNotices() throws Exception {
    UUID taskId = enqueue("raced", Map.of());
    Worker worker =
        worker()
            .lease(Duration.ofSeconds(60))
            .heartbeat(Duration.ofSeconds(30))
            .handle(
                "raced",
                Object.class,
                (ctx, payload) -> {
                  execute(
                      "UPDATE workhorse.task_runtime SET fence_token = fence_token + 1"
                          + " WHERE task_id = ?::uuid",
                      taskId.toString());
                  return Map.of("late", true);
                })
            .build();

    assertTrue(worker.runOnce(), "a rejected completion is not a worker error");

    Status status = status(taskId);
    assertEquals("active", status.state());
    assertNull(status.result());
  }

  /**
   * SM-1442: closing a connection does not stop its statement, so each round that timed out used to
   * leave one more backend waiting on the same row lock. PostgreSQL now ends the round's
   * transaction by the round's deadline.
   */
  @Test
  void endsAHeartbeatStatementThatWaitsOnARowLockOnTheServerByItsDeadline() throws Exception {
    long intervalMs = 200;
    UUID taskId = enqueue("bounded", Map.of());
    CountDownLatch started = new CountDownLatch(1);
    CountDownLatch release = new CountDownLatch(1);
    Worker worker =
        worker()
            .lease(Duration.ofSeconds(30))
            .heartbeat(Duration.ofMillis(intervalMs))
            .handle(
                "bounded",
                Object.class,
                (ctx, payload) -> {
                  started.countDown();
                  release.await(30, TimeUnit.SECONDS);
                  return Map.of();
                })
            .build();
    ExecutorService runner = Executors.newSingleThreadExecutor();
    List<List<Double>> samples = new ArrayList<>();
    try (Connection blocker = ScratchDatabase.connect();
        Connection observer = ScratchDatabase.connect()) {
      var run = runner.submit(worker::runOnce);
      assertTrue(started.await(20, TimeUnit.SECONDS), "the handler started");
      blocker.setAutoCommit(false);
      try (PreparedStatement lock =
          blocker.prepareStatement(
              "SELECT FROM workhorse.task_runtime WHERE task_id = ?::uuid FOR UPDATE")) {
        lock.setString(1, taskId.toString());
        lock.execute();
      }
      long until = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(8 * intervalMs);
      try (PreparedStatement active =
          observer.prepareStatement(
              "SELECT extract(epoch FROM clock_timestamp() - query_start) * 1000"
                  + " FROM pg_stat_activity WHERE datname = current_database()"
                  + " AND pid <> pg_backend_pid() AND state = 'active'"
                  + " AND query LIKE '%workhorse.heartbeat_many_v1%'")) {
        while (System.nanoTime() < until) {
          List<Double> sample = new ArrayList<>();
          try (ResultSet result = active.executeQuery()) {
            while (result.next()) {
              sample.add(result.getDouble(1));
            }
          }
          samples.add(sample);
          Thread.sleep(20);
        }
      }
      blocker.commit();
      release.countDown();
      assertTrue(run.get(20, TimeUnit.SECONDS), "the worker ran the task");
    } finally {
      release.countDown();
      runner.shutdownNow();
    }
    assertTrue(samples.stream().anyMatch(sample -> !sample.isEmpty()), "a heartbeat waited");
    assertTrue(
        samples.stream().mapToInt(List::size).max().orElse(0) <= 1,
        "at most one heartbeat statement at a time: " + samples);
    // A statement ends by its round's deadline. The slack allows for a slow host, and stays far
    // below the 1.6 s that the lock was held.
    double oldest = samples.stream().flatMap(List::stream).mapToDouble(age -> age).max().orElse(0);
    assertTrue(oldest < 5 * intervalMs, "a heartbeat statement ran for " + oldest + " ms");
    assertEquals("succeeded", status(taskId).state());
  }

  @Test
  void recoversAnExpiredLeaseInMaintenanceAndRunsTheTaskAgain() throws Exception {
    UUID taskId = enqueue("orphan", Map.of());
    try (Connection connection = ScratchDatabase.connect();
        PreparedStatement claim =
            connection.prepareStatement(
                "SELECT task_id FROM workhorse.claim_many_v1(?, 'gone-worker', 1, 100)")) {
      claim.setString(1, queueName);
      claim.execute();
    }
    assertEquals("gone-worker", status(taskId).workerId());
    waitUntil(
        "the lease of the gone worker expires",
        () -> {
          try {
            return count(
                    "SELECT count(*) FROM workhorse.task_runtime"
                        + " WHERE task_id = ?::uuid AND expires_at < clock_timestamp()",
                    taskId.toString())
                == 1;
          } catch (SQLException error) {
            throw new IllegalStateException(error);
          }
        });
    Worker worker =
        worker()
            .maintenanceInterval(Duration.ofMillis(100))
            .handle("orphan", Object.class, (ctx, payload) -> ctx.task().attempt())
            .build();
    worker.start();
    try {
      waitForState(taskId, "succeeded");
    } finally {
      worker.close();
    }
    assertEquals(2L, json(status(taskId).result()), "the recovered task ran as attempt 2");
  }

  // Cooperative cancellation delivery.

  @Test
  void deliversACancelRequestThroughTheTokenAndTheCallback() throws Exception {
    UUID taskId = enqueue("cancellable", Map.of());
    CountDownLatch started = new CountDownLatch(1);
    AtomicReference<@Nullable CancellationReason> reason = new AtomicReference<>();
    AtomicInteger callbacks = new AtomicInteger();
    Worker worker =
        worker()
            .lease(Duration.ofSeconds(5))
            .heartbeat(Duration.ofMillis(100))
            .handle(
                "cancellable",
                Object.class,
                (ctx, payload) -> {
                  AutoCloseable callback = ctx.cancellation().onCancel(callbacks::incrementAndGet);
                  try {
                    started.countDown();
                    ctx.cancellation().await(WAIT);
                    reason.set(ctx.cancellation().reason());
                    ctx.cancellation().throwIfCancelled();
                  } finally {
                    callback.close();
                  }
                  return null;
                })
            .build();
    worker.start();
    try {
      await(started, "the handler");
      queue.cancel(taskId, "test", "no longer needed");
      waitForState(taskId, "canceled");
    } finally {
      worker.close();
    }
    assertEquals(CancellationReason.REQUESTED, reason.get());
    waitUntil("the callback runs", () -> callbacks.get() == 1);
    assertEquals(1, callbacks.get(), "the callback runs once");
  }

  @Test
  void cancelsAnAttemptThatPassesItsExecutionTimeout() throws Exception {
    UUID taskId =
        enqueue(
            "slow",
            Map.of(),
            EnqueueOptions.builder().executionTimeout(Duration.ofMillis(300)).maxAttempts(1));
    AtomicReference<@Nullable CancellationReason> reason = new AtomicReference<>();
    Worker worker =
        worker()
            .handle(
                "slow",
                Object.class,
                (ctx, payload) -> {
                  ctx.cancellation().await(WAIT);
                  reason.set(ctx.cancellation().reason());
                  return null;
                })
            .build();

    assertTrue(worker.runOnce());

    assertEquals(CancellationReason.EXECUTION_TIMEOUT, reason.get());
    assertEquals("failed", status(taskId).state());
  }

  @Test
  void cancelsAnAttemptThatPassesItsDeadline() throws Exception {
    UUID taskId =
        enqueue("late", Map.of(), EnqueueOptions.builder().deadline(Instant.now().plusMillis(400)));
    AtomicReference<@Nullable CancellationReason> reason = new AtomicReference<>();
    Worker worker =
        worker()
            .handle(
                "late",
                Object.class,
                (ctx, payload) -> {
                  ctx.cancellation().await(WAIT);
                  reason.set(ctx.cancellation().reason());
                  return null;
                })
            .build();

    assertTrue(worker.runOnce());

    assertEquals(CancellationReason.DEADLINE_EXCEEDED, reason.get());
    assertFalse(List.of("active", "succeeded").contains(status(taskId).state()));
  }

  // Notification-assisted dispatch with polling.

  @Test
  void wakesAnIdleWorkerOnANotificationWellBeforeItsFallbackPoll() throws Exception {
    Worker worker =
        worker()
            .pollingOnly(false)
            .pollInterval(Duration.ofSeconds(60))
            .handle("woken", Object.class, (ctx, payload) -> null)
            .build();
    String listening =
        "SELECT count(*) FROM pg_stat_activity WHERE datname = current_database()"
            + " AND state = 'idle' AND query = 'LISTEN workhorse_tasks' AND ? <> ''";
    worker.start();
    try {
      waitUntil(
          "PostgreSQL holds the LISTEN",
          () -> {
            try {
              return count(listening, "x") == 1;
            } catch (SQLException error) {
              throw new IllegalStateException(error);
            }
          });
      long enqueuedAt = System.nanoTime();
      UUID taskId = enqueue("woken", Map.of());
      waitForState(taskId, "succeeded");
      Duration elapsed = Duration.ofNanos(System.nanoTime() - enqueuedAt);
      assertTrue(
          elapsed.compareTo(Duration.ofSeconds(5)) < 0,
          "a notification woke the worker, not its 60 s poll: " + elapsed);
    } finally {
      worker.close();
    }
  }

  @Test
  void aPollingOnlyWorkerFindsWorkWithoutAListener() throws Exception {
    Worker worker =
        Worker.builder(dataSource)
            .queues(queueName)
            .pollingOnly(true)
            .disableRegistry(true)
            .handle("polled", Object.class, (ctx, payload) -> null)
            .build();
    worker.start();
    try {
      UUID taskId = enqueue("polled", Map.of());
      waitForState(taskId, "succeeded");
    } finally {
      worker.close();
    }
  }

  // Schedule firing (database cron evaluation).

  @Test
  void firesDueSchedulesInItsNamespacesDuringMaintenance() throws Exception {
    String namespace = "jvm-" + UUID.randomUUID();
    queue.syncSchedules(
        namespace,
        List.of(
            new ScheduleDefinition(
                "every-minute",
                "* * * * *",
                new ScheduledTask("cron", Map.of(), queueName, 0, null, null, null),
                "UTC",
                CatchupPolicy.LATEST,
                true)));
    execute(
        "UPDATE workhorse.schedule_definition"
            + " SET last_evaluated_at = clock_timestamp() - interval '2 minutes'"
            + " WHERE namespace = ?",
        namespace);

    Worker worker =
        worker()
            .scheduleNamespaces(namespace)
            .handle("cron", Object.class, (ctx, payload) -> Map.of("fired", true))
            .build();

    assertTrue(worker.runOnce());
    assertTrue(
        count("SELECT count(*) FROM workhorse.schedule_occurrence WHERE namespace = ?", namespace)
            >= 1);
  }

  // Worker fleet registration and remote pause.

  @Test
  void registersTheWorkerAndStopsClaimingWhileAnOperatorPausesIt() throws Exception {
    Admin admin = new Admin(ConnectionSource.of(dataSource));
    AdminAudit audit = new AdminAudit("test", "pause for the test", UUID.randomUUID().toString());
    Worker worker =
        worker()
            .disableRegistry(false)
            .registryInterval(Duration.ofMillis(100))
            .handle("echo", Object.class, (ctx, payload) -> payload)
            .build();
    worker.start();
    try {
      waitUntil(
          "the worker registers",
          () -> admin.listWorkers().stream().anyMatch(w -> w.workerId().equals(worker.workerId())));
      WorkerInfo info =
          admin.listWorkers().stream()
              .filter(w -> w.workerId().equals(worker.workerId()))
              .findFirst()
              .orElseThrow();
      assertEquals(List.of(queueName), info.queues());
      assertEquals(1, info.concurrency());

      assertTrue(admin.setWorkerPaused(worker.workerId(), true, audit).isPresent());
      waitUntil("the worker sees the pause", worker::isPaused);
      UUID taskId = enqueue("echo", "held");
      // A negative check: the window cannot hide a claim, because a claim would change the state.
      Thread.sleep(300);
      assertEquals("ready", status(taskId).state(), "a paused worker claims nothing");

      admin.setWorkerPaused(worker.workerId(), false, audit);
      waitForState(taskId, "succeeded");
    } finally {
      worker.close();
    }
    assertTrue(
        admin.listWorkers().stream().noneMatch(w -> w.workerId().equals(worker.workerId())),
        "a stopped worker deregisters");
  }

  @Test
  void pausesAndResumesLocally() throws Exception {
    Worker worker = worker().handle("echo", Object.class, (ctx, payload) -> payload).build();
    worker.pause();
    assertTrue(worker.isPaused());
    worker.start();
    try {
      UUID taskId = enqueue("echo", "held");
      // A negative check over a polling window of 10 ms intervals.
      Thread.sleep(200);
      assertEquals("ready", status(taskId).state());
      worker.resume();
      waitForState(taskId, "succeeded");
    } finally {
      worker.close();
    }
  }

  // Graceful stop and signal drain.

  @Test
  void drainFinishesRunningTasksAndInterruptsTheRestAtTheDeadline() throws Exception {
    UUID quick = enqueue("quick", Map.of());
    UUID stuck = enqueue("stuck", Map.of());
    CountDownLatch started = new CountDownLatch(2);
    CountDownLatch finish = new CountDownLatch(1);
    AtomicBoolean interrupted = new AtomicBoolean();
    AtomicReference<@Nullable CancellationReason> reason = new AtomicReference<>();
    Worker worker =
        worker()
            .concurrency(2)
            .shutdownGrace(Duration.ofSeconds(2))
            .handle(
                "quick",
                Object.class,
                (ctx, payload) -> {
                  started.countDown();
                  // Finishes within the grace, after the stop.
                  assertTrue(finish.await(WAIT.toMillis(), TimeUnit.MILLISECONDS));
                  return Map.of("cancelled", ctx.isCancelled());
                })
            .handle(
                "stuck",
                Object.class,
                (ctx, payload) -> {
                  started.countDown();
                  try {
                    Thread.sleep(WAIT.toMillis());
                  } catch (InterruptedException error) {
                    interrupted.set(true);
                    reason.set(ctx.cancellation().reason());
                    throw error;
                  }
                  return null;
                })
            .build();
    worker.start();
    await(started, "both handlers");
    long stoppedAt = System.nanoTime();
    worker.stop();
    finish.countDown();
    worker.close();
    Duration drained = Duration.ofNanos(System.nanoTime() - stoppedAt);

    assertEquals("succeeded", status(quick).state(), "the drain let the quick task finish");
    assertEquals(Map.of("cancelled", false), json(status(quick).result()));
    assertTrue(interrupted.get(), "the deadline interrupted the stuck handler");
    assertEquals(CancellationReason.SHUTDOWN, reason.get());
    Status released = status(stuck);
    assertEquals("ready", released.state(), "an interrupted handler releases its task");
    assertNull(released.error(), "the release charges no attempt");
    assertTrue(drained.compareTo(Duration.ofMillis(1_900)) >= 0, "the drain waited the grace");
    assertTrue(drained.compareTo(Duration.ofSeconds(10)) < 0, "the drain ended: " + drained);
  }

  @Test
  void stillChargesTheAttemptWhenAHandlerFailsOnItsOwnAfterTheStop() throws Exception {
    UUID taskId = enqueue("own", Map.of(), EnqueueOptions.builder().maxAttempts(1));
    CountDownLatch started = new CountDownLatch(1);
    Worker worker =
        worker()
            .shutdownGrace(Duration.ofMillis(100))
            .handle(
                "own",
                Object.class,
                (ctx, payload) -> {
                  started.countDown();
                  long deadline = System.nanoTime() + WAIT.toNanos();
                  while (!ctx.isCancelled() && System.nanoTime() < deadline) {
                    try {
                      ctx.cancellation().await(WAIT);
                    } catch (InterruptedException ignored) {
                      // Waits for the token, not for the interrupt.
                    }
                  }
                  throw new IllegalStateException("own failure");
                })
            .build();
    worker.start();
    await(started, "the handler");
    worker.close();

    assertEquals("failed", status(taskId).state());
  }

  @Test
  void throwsShutdownIncompleteWhenAHandlerOutlivesTheUnwindWindow() throws Exception {
    UUID taskId = enqueue("stubborn", Map.of());
    CountDownLatch started = new CountDownLatch(1);
    CountDownLatch release = new CountDownLatch(1);
    Worker worker =
        worker()
            .shutdownGrace(Duration.ZERO)
            .handle(
                "stubborn",
                Object.class,
                (ctx, payload) -> {
                  started.countDown();
                  // Ignores the token and every interrupt until the test lets it go.
                  long deadline = System.nanoTime() + WAIT.toNanos();
                  while (System.nanoTime() < deadline) {
                    try {
                      if (release.await(WAIT.toMillis(), TimeUnit.MILLISECONDS)) {
                        return null;
                      }
                    } catch (InterruptedException ignored) {
                      // Keeps running.
                    }
                  }
                  return null;
                })
            .build();
    worker.start();
    try {
      await(started, "the handler");

      ShutdownIncompleteException error =
          assertThrows(ShutdownIncompleteException.class, worker::close);
      assertEquals(1, error.abandoned());
      assertEquals(
          "active", status(taskId).state(), "an abandoned task keeps its lease until it expires");
    } finally {
      release.countDown();
    }
  }

  // Retention maintenance participation.

  @Test
  void runsTerminalStorageMaintenance() throws Exception {
    String completed =
        "SELECT count(*) FROM workhorse.maintenance_state"
            + " WHERE routine_name = ? AND last_completed_at IS NOT NULL";
    execute(
        "UPDATE workhorse.maintenance_state SET last_completed_at = NULL WHERE routine_name = ?",
        "terminal_storage");

    assertFalse(worker().build().runOnce());
    assertEquals(1, count(completed, "terminal_storage"));
  }

  // Options.

  @Test
  void refusesInvalidOptionsBeforeAnyStatementRuns() {
    assertThrows(IllegalArgumentException.class, () -> worker().concurrency(0));
    assertThrows(IllegalArgumentException.class, () -> worker().concurrency(101));
    assertThrows(IllegalArgumentException.class, () -> worker().lease(Duration.ofMillis(99)));
    assertThrows(IllegalArgumentException.class, () -> worker().queues());
    assertThrows(IllegalArgumentException.class, () -> worker().queues(""));
    assertThrows(IllegalArgumentException.class, () -> worker().scheduleCatchupLimit(0));
    assertThrows(IllegalArgumentException.class, () -> worker().shutdownGrace(Duration.ofDays(2)));
    assertThrows(
        IllegalArgumentException.class,
        () -> worker().lease(Duration.ofSeconds(1)).heartbeat(Duration.ofSeconds(1)).build());
  }

  @Test
  void reportsItsConfiguration() {
    Worker worker = worker().queues("b", "a", "b").concurrency(7).workerId("named").build();
    assertEquals(List.of("b", "a"), worker.queues());
    assertEquals(7, worker.concurrency());
    assertEquals("named", worker.workerId());
    assertFalse(worker.isPaused());
  }
}
