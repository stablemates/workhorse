package run.workhorse;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Proxy;
import java.math.BigDecimal;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Statement;
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
import java.util.concurrent.atomic.AtomicLong;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.BooleanSupplier;
import javax.sql.DataSource;
import org.jspecify.annotations.Nullable;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.extension.ExtendWith;
import run.workhorse.internal.Json;
import run.workhorse.testing.ScratchDataSource;
import run.workhorse.testing.ScratchDatabase;

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

  // SM-1537: a BigDecimal keeps every digit on the worker's write paths.

  private static final BigDecimal AMOUNT = new BigDecimal("12345678901234567.89");

  /** The text of the JSON value at {@code path} in the jsonb {@code column} of a task's row. */
  private static @Nullable String storedText(String table, String column, UUID taskId, String path)
      throws SQLException {
    try (Connection connection = ScratchDatabase.connect();
        PreparedStatement statement =
            connection.prepareStatement(
                "SELECT "
                    + column
                    + " #>> ?::text[] FROM workhorse."
                    + table
                    + " WHERE task_id = ?::uuid")) {
      statement.setString(1, "{" + path + "}");
      statement.setString(2, taskId.toString());
      try (ResultSet result = statement.executeQuery()) {
        assertTrue(result.next(), "the " + table + " row exists");
        return result.getString(1);
      }
    }
  }

  @Test
  void storesEveryDigitOfADecimalInAResult() throws SQLException {
    UUID taskId = enqueue("decimal", Map.of(), EnqueueOptions.builder().maxAttempts(1));

    assertTrue(
        worker()
            .handle(
                "decimal",
                Object.class,
                (ctx, p) ->
                    Map.of(
                        "amount",
                        AMOUNT,
                        "rate",
                        0.1,
                        "huge",
                        new BigDecimal("1E+400"),
                        "list",
                        List.of(AMOUNT)))
            .build()
            .runOnce());

    assertEquals("succeeded", status(taskId).state());
    assertEquals(AMOUNT.toPlainString(), storedText("task_outcome", "result", taskId, "amount"));
    assertEquals("0.1", storedText("task_outcome", "result", taskId, "rate"));
    assertEquals(AMOUNT.toPlainString(), storedText("task_outcome", "result", taskId, "list,0"));
    String huge = storedText("task_outcome", "result", taskId, "huge");
    assertNotNull(huge);
    assertEquals(0, new BigDecimal(huge).compareTo(new BigDecimal("1E+400")));
  }

  @Test
  void validatesAnExactDecimalResultAgainstAContract() throws SQLException {
    String taskType = "decimal-contract." + queueName;
    queue.syncContracts(
        Map.of(
            taskType,
            new TaskTypeContracts(
                "v1",
                Map.of(
                    "v1",
                    new TaskContractVersion(
                        Map.of(),
                        Map.of(
                            "type",
                            "object",
                            "properties",
                            Map.of("count", Map.of("type", "integer"))))))));
    UUID whole = enqueue(taskType, Map.of("count", "12345678901234567.00"));
    UUID fraction =
        enqueue(
            taskType,
            Map.of("count", "12345678901234567.01"),
            EnqueueOptions.builder().maxAttempts(1));

    assertTrue(
        worker()
            .handle(
                taskType,
                Map.class,
                (ctx, payload) -> Map.of("count", new BigDecimal((String) payload.get("count"))))
            .build()
            .runOnce());

    assertEquals("succeeded", status(whole).state());
    Status failed = status(fraction);
    assertEquals("failed", failed.state(), "a double would round the fraction to an integer");
    assertEquals("ContractValidationException", Json.object(json(failed.error())).get("name"));
  }

  @Test
  void storesEveryDigitOfADecimalInACheckpointValue() throws SQLException {
    UUID taskId = enqueue("decimal", Map.of());
    AtomicReference<@Nullable Object> returned = new AtomicReference<>();

    assertTrue(
        worker()
            .handle(
                "decimal",
                Object.class,
                (ctx, p) -> {
                  returned.set(
                      ctx.checkpoint(
                          "charge",
                          Object.class,
                          () -> Map.of("amount", AMOUNT, "huge", new BigDecimal("1E+400"))));
                  return null;
                })
            .build()
            .runOnce());

    assertEquals("succeeded", status(taskId).state());
    assertEquals(
        AMOUNT.toPlainString(),
        storedText("task_checkpoint", "checkpoint_value", taskId, "amount"));
    String huge = storedText("task_checkpoint", "checkpoint_value", taskId, "huge");
    assertNotNull(huge);
    assertEquals(0, new BigDecimal(huge).compareTo(new BigDecimal("1E+400")));
    Map<String, @Nullable Object> value = Json.object(returned.get());
    assertNotNull(value);
    assertEquals(
        AMOUNT.doubleValue(),
        value.get("amount"),
        "the default codec decodes a fraction as a Double");
  }

  @Test
  void storesEveryDigitOfADecimalInProgress() throws SQLException {
    UUID taskId = enqueue("decimal", Map.of());
    AtomicReference<@Nullable TaskProgress> saved = new AtomicReference<>();

    assertTrue(
        worker()
            .handle(
                "decimal",
                Object.class,
                (ctx, p) -> {
                  saved.set(ctx.setProgress(Map.of("amount", AMOUNT)));
                  return null;
                })
            .build()
            .runOnce());

    assertEquals("succeeded", status(taskId).state());
    assertEquals(
        AMOUNT.toPlainString(), storedText("task_progress", "progress_value", taskId, "amount"));
    assertNotNull(saved.get());
  }

  @Test
  void storesEveryDigitOfADecimalInAHumanWaitContext() throws SQLException {
    UUID taskId = enqueue("decimal", Map.of());

    assertTrue(
        worker()
            .handle(
                "decimal",
                Object.class,
                (ctx, p) ->
                    ctx.waitForHuman(
                        "review", Map.of("amount", AMOUNT), Object.class, Duration.ofHours(1)))
            .build()
            .runOnce());

    assertFalse(status(taskId).state().equals("succeeded"), "the task waits for the decision");
    assertEquals(
        AMOUNT.toPlainString(), storedText("task_human_wait", "context", taskId, "amount"));
  }

  @Test
  void refusesACheckpointFractionThatTheWorkerCannotReadBack() throws SQLException {
    UUID taskId = enqueue("decimal", Map.of(), EnqueueOptions.builder().maxAttempts(1));

    assertTrue(
        worker()
            .handle(
                "decimal",
                Object.class,
                (ctx, p) ->
                    ctx.checkpoint(
                        "charge",
                        Object.class,
                        () -> Map.of("amount", new BigDecimal("1E+400").setScale(2))))
            .build()
            .runOnce());

    Status failed = status(taskId);
    assertEquals("failed", failed.state(), "the attempt fails before PostgreSQL stores the value");
    assertEquals("IllegalArgumentException", Json.object(json(failed.error())).get("name"));
    assertEquals(
        0,
        count(
            "SELECT count(*) FROM workhorse.task_checkpoint WHERE task_id = ?::uuid",
            taskId.toString()));
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

  /**
   * A handler that runs longer than the lease keeps its task, because each accepted heartbeat round
   * renews the lease. The handler runs until it outlives the lease of its claim and a round has
   * renewed the stored lease, and not for a fixed time.
   *
   * <p>An earlier version used a lease of 300 ms and a round every 50 ms. On a loaded host, the
   * rounds failed or found the row busy for longer than the lease, so each attempt lost its lease,
   * and {@code runOnce} claimed the task again 20 times (SM-1554). A lease of 3 s and a round every
   * 500 ms give the rounds the margin of the SM-1479 tests. The test checks that one attempt did
   * all the work.
   */
  @Test
  void renewsTheLeaseOfAHandlerThatRunsLongerThanTheLease() throws SQLException {
    Duration lease = Duration.ofSeconds(3);
    UUID taskId = enqueue("long", Map.of());
    Worker worker =
        worker()
            .lease(lease)
            .heartbeat(Duration.ofMillis(500))
            .handle(
                "long",
                Object.class,
                (ctx, payload) -> {
                  long outlived = System.nanoTime() + lease.toNanos();
                  Instant claimed = expiresAt(taskId);
                  waitUntil(
                      "the handler outlived the lease of its claim",
                      () -> System.nanoTime() - outlived > 0 || ctx.isCancelled());
                  waitUntil(
                      "a round renewed the stored lease",
                      () -> expiresAt(taskId).isAfter(claimed) || ctx.isCancelled());
                  return Map.of("cancelled", ctx.isCancelled());
                })
            .build();

    assertTrue(worker.runOnce());
    Status status = status(taskId);
    assertEquals("succeeded", status.state());
    assertEquals(1, status.attempt(), "one attempt kept its lease to the end");
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
   * leave one more backend waiting on the same lock. PostgreSQL now ends the round's transaction by
   * the round's deadline. {@code heartbeat_many_v2} skips a locked row, so the test holds a table
   * lock that the heartbeat waits on ({@link #blockHeartbeats}).
   */
  @Test
  void endsAHeartbeatStatementThatWaitsOnALockOnTheServerByItsDeadline() throws Exception {
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
      blockHeartbeats(blocker);
      long until = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(8 * intervalMs);
      try (PreparedStatement active =
          observer.prepareStatement(
              "SELECT extract(epoch FROM clock_timestamp() - query_start) * 1000"
                  + " FROM pg_stat_activity WHERE datname = current_database()"
                  + " AND pid <> pg_backend_pid() AND state = 'active'"
                  + " AND query LIKE '%workhorse.heartbeat_many_v2%'")) {
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

  /**
   * SM-1444: a round falls due one interval after the previous round started, also after a failed
   * round replaces the connection. So one timed-out round does not move the next round toward the
   * end of the lease. The lease is 2.3 intervals, shorter than the default of 3. The table lock
   * makes the first round end on the server at about 1.4 intervals. The fixed schedule sends the
   * next round at 2 intervals, inside the lease. A schedule that starts again after the failed
   * round sends it at about 2.5 intervals, after the lease.
   *
   * <p>The lease starts when the claim leaves, so the claim, the start of the handler, and the
   * second round must end in 0.3 intervals. The delays of a loaded host are absolute, so the
   * interval is 4 s, which gives them 1.2 s. A trace of the TypeScript test ran at a 1-minute load
   * of 46 on 32 cores. The delay from the claim to the handler was up to 654 ms, and the second
   * round took up to 221 ms (SM-1479).
   */
  @Test
  void keepsARenewalMarginAfterOneTimedOutHeartbeatRound() throws Exception {
    long intervalMs = 4_000;
    UUID taskId = enqueue("margin", Map.of());
    CountDownLatch started = new CountDownLatch(1);
    CountDownLatch release = new CountDownLatch(1);
    AtomicReference<Boolean> cancelled = new AtomicReference<>();
    Worker worker =
        worker()
            .lease(Duration.ofMillis(9_200))
            .heartbeat(Duration.ofMillis(intervalMs))
            .handle(
                "margin",
                Object.class,
                (ctx, payload) -> {
                  started.countDown();
                  release.await(30, TimeUnit.SECONDS);
                  cancelled.set(ctx.isCancelled());
                  return Map.of();
                })
            .build();
    ExecutorService runner = Executors.newSingleThreadExecutor();
    List<Boolean> lapsed = new ArrayList<>();
    try (Connection blocker = ScratchDatabase.connect();
        Connection observer = ScratchDatabase.connect()) {
      int blockerPid = backendPid(blocker);
      var run = runner.submit(worker::runOnce);
      assertTrue(started.await(20, TimeUnit.SECONDS), "the handler started");
      long handlerStarted = System.nanoTime();
      blockHeartbeats(blocker);
      // The first round falls due one interval after the lease registered, just before the handler
      // started. A lock that comes later than half an interval can miss that round.
      long heldMs = TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - handlerStarted);
      assertTrue(
          heldMs <= intervalMs / 2,
          "precondition not met: the table lock came " + heldMs + " ms after the handler started");
      // Hold the lock until the first round waits on it and then stops. While the lock is held,
      // the statement stops only when its round times out. Then release the lock before the second
      // round.
      assertTrue(
          heartbeatsReach(
              observer,
              blockerPid,
              true,
              handlerStarted + TimeUnit.MILLISECONDS.toNanos(intervalMs * 3 / 2)),
          "precondition not met: the first round did not wait on the table lock");
      assertTrue(
          heartbeatsReach(
              observer,
              blockerPid,
              false,
              handlerStarted + TimeUnit.MILLISECONDS.toNanos(intervalMs * 19 / 10)),
          "precondition not met: the first round did not time out");
      blocker.commit();
      long releasedMs = TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - handlerStarted);
      assertTrue(
          releasedMs <= intervalMs * 19 / 10,
          "precondition not met: the table lock ended "
              + releasedMs
              + " ms after the handler started");
      blocker.setAutoCommit(true);
      // Run past the end of the lease from the claim, so only a renewal keeps the task. The stored
      // lease must not lapse before that renewal.
      long until = handlerStarted + TimeUnit.MILLISECONDS.toNanos(intervalMs * 26 / 10);
      try (PreparedStatement expired =
          blocker.prepareStatement(
              "SELECT expires_at <= clock_timestamp() FROM workhorse.task_runtime"
                  + " WHERE task_id = ?::uuid")) {
        expired.setString(1, taskId.toString());
        while (System.nanoTime() - until < 0) {
          try (ResultSet result = expired.executeQuery()) {
            assertTrue(result.next(), "the task has a runtime row");
            lapsed.add(result.getBoolean(1));
          }
          Thread.sleep(20);
        }
      }
      release.countDown();
      assertTrue(run.get(20, TimeUnit.SECONDS), "the worker ran the task");
    } finally {
      release.countDown();
      runner.shutdownNow();
    }
    assertFalse(lapsed.isEmpty(), "the lease was sampled");
    assertFalse(lapsed.contains(true), "the stored lease lapsed: " + lapsed);
    assertEquals(false, cancelled.get(), "the handler lost its lease");
    assertEquals("succeeded", status(taskId).state());
  }

  /**
   * SM-1444: a round that ends after its next slot starts one overdue round at once, also when it
   * replaces its connection. The interval is 40 ms, so the round bound equals the interval. Each of
   * the first five heartbeat rounds commits only after its deadline, so it fails after its next
   * slot. The worker then checks out a new connection at once, and starts the overdue round on it
   * at once.
   *
   * <p>The test measures that gap without the time of the connect. The old loop waited 100 ms
   * before the new connection, so each of its gaps is at least 100 ms. The limit is 90 ms for the
   * shortest of the five gaps. One gap can be longer on a loaded host, because the heartbeat thread
   * can wait for a CPU (SM-1543). The handler runs until the overdue round after the last failed
   * round starts, and not for a fixed time. The lease is 30 s, so the delay from the claim to the
   * handler on a loaded host does not change the result (SM-1479).
   */
  @Test
  void startsAnOverdueRoundAtOnceAfterAFailedRoundReplacesItsConnection() throws Exception {
    long intervalMs = 40;
    int failures = 5;
    UUID taskId = enqueue("overdue", Map.of());
    CountDownLatch started = new CountDownLatch(1);
    List<Long> failedAt = new CopyOnWriteArrayList<>();
    List<HeartbeatSend> sends = new CopyOnWriteArrayList<>();
    Worker worker =
        Worker.builder(delayingHeartbeatCommits(dataSource, intervalMs, failures, failedAt, sends))
            .queues(queueName)
            .pollingOnly(true)
            .pollInterval(Duration.ofMillis(10))
            .disableRegistry(true)
            .lease(Duration.ofSeconds(30))
            .heartbeat(Duration.ofMillis(intervalMs))
            .handle(
                "overdue",
                Object.class,
                (ctx, payload) -> {
                  started.countDown();
                  waitUntil(
                      "a round started after the last failed round",
                      () ->
                          failedAt.size() == failures
                              && overdueRound(sends, failedAt.get(failures - 1)) != null);
                  return Map.of();
                })
            .build();
    assertTrue(worker.runOnce(), "the worker ran the task");
    assertTrue(started.await(1, TimeUnit.SECONDS), "the handler started");
    assertEquals("succeeded", status(taskId).state());
    assertEquals(failures, failedAt.size(), "precondition not met: a heartbeat round did not fail");
    List<Long> gapsMs = new ArrayList<>();
    for (long failed : failedAt) {
      HeartbeatSend overdue = overdueRound(sends, failed);
      assertNotNull(overdue, "no round started after a failed round");
      gapsMs.add(
          TimeUnit.NANOSECONDS.toMillis(
              (overdue.connectStartedAt() - failed) + (overdue.sentAt() - overdue.connectedAt())));
    }
    assertTrue(
        gapsMs.stream().anyMatch(gapMs -> gapMs < 90),
        "each overdue round started at least 90 ms after its failed round: " + gapsMs);
  }

  /** The first heartbeat statement whose connection was requested at {@code failed} or later. */
  private static @Nullable HeartbeatSend overdueRound(List<HeartbeatSend> sends, long failed) {
    for (HeartbeatSend send : sends) {
      if (send.connectStartedAt() - failed >= 0) {
        return send;
      }
    }
    return null;
  }

  /**
   * SM-1443: a busy round renews nothing and gives no verdict. While another transaction holds the
   * task's row, every round is busy, so the lease watchdog ends the attempt with a lost lease at
   * the end of its local window, and not earlier. The window ends one lease after the last accepted
   * round left.
   *
   * <p>The test reads the time of that round from the worker, at the cancellation. An earlier
   * version measured from the time after the lock, and allowed two intervals for the last accepted
   * round. Under load, the heartbeat thread sent that round late, or the test recorded the lock
   * late, and the attempt seemed to end early (SM-1543).
   *
   * <p>The task has one attempt. Before it claims again, {@code runOnce} runs a maintenance pass.
   * If the test commits its lock before that pass, the pass recovers the expired lease. With more
   * attempts, the task then went back to the queue, {@code runOnce} claimed it again, and the new
   * handler waited 20 s for a cancellation. On a loaded host, {@code runOnce} thus did not return
   * in 20 s (SM-1562). With one attempt, the recovery ends the task, and the next claim finds no
   * task.
   *
   * <p>The attempt must hold its lease until the lock. On a loaded host, the rounds can fail for
   * one lease before the lock, and the attempt loses its lease with no busy round. The test then
   * waited 20 s for a renewal that never came (SM-1563). Now a run counts only if the test took the
   * lock before the local window ended, and the worker logged a busy round. Only a round under the
   * lock is busy. Otherwise the test runs the scenario again with a new task, up to five times.
   */
  @Test
  void endsAnAttemptWhoseLeaseStaysBusyAtTheEndOfItsLeaseWindow() throws Exception {
    for (int tries = 1; !holdsTheRowUntilTheLeaseWindowEnds(); tries++) {
      assertTrue(tries < 5, "precondition not met: each attempt lost its lease before the lock");
    }
  }

  /**
   * One run of the busy-lease scenario. Returns false, and asserts nothing about the lease window,
   * if no round was busy, or if the test took the lock after the local window ended.
   */
  private boolean holdsTheRowUntilTheLeaseWindowEnds() throws Exception {
    long leaseMs = 800;
    long intervalMs = 100;
    UUID taskId = enqueue("held", Map.of(), EnqueueOptions.builder().maxAttempts(1));
    CountDownLatch started = new CountDownLatch(1);
    AtomicLong cancelledAt = new AtomicLong();
    AtomicLong renewedAt = new AtomicLong();
    AtomicReference<@Nullable CancellationReason> reason = new AtomicReference<>();
    AtomicReference<@Nullable Worker> self = new AtomicReference<>();
    BusyRounds busyRounds = new BusyRounds();
    Worker worker =
        worker()
            .logger(busyRounds)
            .lease(Duration.ofMillis(leaseMs))
            .heartbeat(Duration.ofMillis(intervalMs))
            .handle(
                "held",
                Object.class,
                (ctx, payload) -> {
                  started.countDown();
                  ctx.cancellation().await(WAIT);
                  long now = System.nanoTime();
                  Worker running = self.get();
                  assertNotNull(running);
                  renewedAt.set(running.leaseRenewedAt(ctx.task().id()));
                  reason.set(ctx.cancellation().reason());
                  // Last, because the test thread waits for it.
                  cancelledAt.set(now);
                  return Map.of();
                })
            .build();
    self.set(worker);
    ExecutorService runner = Executors.newSingleThreadExecutor();
    long lockedAt;
    try (Connection blocker = ScratchDatabase.connect()) {
      var run = runner.submit(worker::runOnce);
      assertTrue(started.await(20, TimeUnit.SECONDS), "the handler started");
      @Nullable Instant claimed = leaseExpiry(taskId);
      waitUntil(
          "a round renewed the lease, or the attempt ended",
          () -> {
            if (cancelledAt.get() != 0) {
              return true;
            }
            @Nullable Instant now = leaseExpiry(taskId);
            return now == null || (claimed != null && now.isAfter(claimed));
          });
      blocker.setAutoCommit(false);
      try (PreparedStatement lock =
          blocker.prepareStatement(
              "SELECT FROM workhorse.task_runtime WHERE task_id = ?::uuid FOR UPDATE")) {
        lock.setString(1, taskId.toString());
        lock.execute();
      }
      lockedAt = System.nanoTime();
      @Nullable Instant locked = leaseExpiry(taskId);
      waitUntil("the handler was cancelled", () -> cancelledAt.get() != 0);
      @Nullable Instant busy = leaseExpiry(taskId);
      blocker.commit();
      assertTrue(run.get(20, TimeUnit.SECONDS), "the worker ran the task");
      assertEquals(1, status(taskId).attempt(), "one attempt ran");
      if (busyRounds.count.get() == 0
          || lockedAt - (renewedAt.get() + TimeUnit.MILLISECONDS.toNanos(leaseMs)) >= 0) {
        // The local window ended before the lock, so the scenario did not run.
        return false;
      }
      assertNotNull(locked, "the task held a lease at the lock");
      assertEquals(locked, busy, "a busy round renewed the stored lease");
    } finally {
      runner.shutdownNow();
    }
    assertEquals(CancellationReason.LEASE_LOST, reason.get());
    // Each round that leaves after the lock is busy. So an accepted round left before it.
    assertTrue(
        renewedAt.get() - lockedAt < 0,
        "a round that left "
            + (renewedAt.get() - lockedAt) / 1e6
            + " ms after the lock renewed the local window");
    double elapsedMs = (cancelledAt.get() - renewedAt.get()) / 1e6;
    assertTrue(
        elapsedMs >= leaseMs,
        "the attempt ended " + elapsedMs + " ms after the last accepted round");
    // The check above finds a busy round that renews the window. This bound shows only that the
    // watchdog acts. Its slack is for the watchdog and the handler threads, which can wake late on
    // a loaded host (SM-1543).
    assertTrue(
        elapsedMs < leaseMs + 2_000,
        "the attempt ended " + elapsedMs + " ms after the last accepted round");
    return true;
  }

  /**
   * A logger that counts the heartbeat rounds that found the task's row busy. It passes each record
   * on to the logger of the worker.
   */
  private static final class BusyRounds implements System.Logger {
    final AtomicInteger count = new AtomicInteger();
    private final System.Logger next = System.getLogger(Worker.class.getName());

    @Override
    public String getName() {
      return next.getName();
    }

    @Override
    public boolean isLoggable(Level level) {
      return true;
    }

    @Override
    public void log(
        Level level,
        java.util.@Nullable ResourceBundle bundle,
        @Nullable String message,
        @Nullable Throwable thrown) {
      countBusy(message);
      next.log(level, bundle, message, thrown);
    }

    // The worker logs through log(Level, String), which reaches this method.
    @Override
    public void log(
        Level level,
        java.util.@Nullable ResourceBundle bundle,
        @Nullable String format,
        @Nullable Object... parameters) {
      countBusy(format);
      next.log(level, bundle, format, parameters);
    }

    private void countBusy(@Nullable String message) {
      String text = String.valueOf(message);
      if (text.contains("event.name=workhorse.task.heartbeat_rejected")
          && text.contains("workhorse.heartbeat.status=busy")) {
        count.incrementAndGet();
      }
    }
  }

  /** The stored lease expiry of {@code taskId}, or null after the task left its runtime row. */
  private static @Nullable Instant leaseExpiry(UUID taskId) {
    try (Connection connection = ScratchDatabase.connect();
        PreparedStatement statement =
            connection.prepareStatement(
                "SELECT expires_at FROM workhorse.task_runtime WHERE task_id = ?::uuid")) {
      statement.setString(1, taskId.toString());
      try (ResultSet result = statement.executeQuery()) {
        return result.next() ? result.getTimestamp(1).toInstant() : null;
      }
    } catch (SQLException error) {
      throw new AssertionError(error);
    }
  }

  private static Instant expiresAt(UUID taskId) {
    try (Connection connection = ScratchDatabase.connect();
        PreparedStatement statement =
            connection.prepareStatement(
                "SELECT expires_at FROM workhorse.task_runtime WHERE task_id = ?::uuid")) {
      statement.setString(1, taskId.toString());
      try (ResultSet result = statement.executeQuery()) {
        assertTrue(result.next(), "the task holds a lease");
        return result.getTimestamp(1).toInstant();
      }
    } catch (SQLException error) {
      throw new AssertionError(error);
    }
  }

  /** One heartbeat statement: when its connection was requested and given, and when it was sent. */
  private record HeartbeatSend(long connectStartedAt, long connectedAt, long sentAt) {}

  /**
   * A source over {@code source} that adds each value bound to run_maintenance_v1 to {@code bound}.
   */
  private static DataSource recordingMaintenanceTime(DataSource source, List<Object> bound) {
    return (DataSource)
        Proxy.newProxyInstance(
            DataSource.class.getClassLoader(),
            new Class<?>[] {DataSource.class},
            (proxy, method, arguments) -> {
              Object result;
              try {
                result = method.invoke(source, arguments);
              } catch (InvocationTargetException error) {
                throw error.getCause();
              }
              if (!method.getName().equals("getConnection")) {
                return result;
              }
              Connection connection = (Connection) result;
              return Proxy.newProxyInstance(
                  Connection.class.getClassLoader(),
                  new Class<?>[] {Connection.class},
                  (inner, call, values) -> {
                    Object answer;
                    try {
                      answer = call.invoke(connection, values);
                    } catch (InvocationTargetException error) {
                      throw error.getCause();
                    }
                    if (!call.getName().equals("prepareStatement")
                        || !String.valueOf(values[0]).contains("run_maintenance_v1")) {
                      return answer;
                    }
                    PreparedStatement prepared = (PreparedStatement) answer;
                    return Proxy.newProxyInstance(
                        PreparedStatement.class.getClassLoader(),
                        new Class<?>[] {PreparedStatement.class},
                        (statement, set, parameters) -> {
                          if (set.getName().startsWith("set")
                              && parameters != null
                              && parameters.length >= 2) {
                            bound.add(parameters[1]);
                          }
                          try {
                            return set.invoke(prepared, parameters);
                          } catch (InvocationTargetException error) {
                            throw error.getCause();
                          }
                        });
                  });
            });
  }

  /**
   * A source over {@code source} whose first {@code count} {@code COMMIT}s after a heartbeat
   * statement return {@code delayMs} late, so each of those heartbeat rounds ends after its
   * deadline. It adds to {@code failedAt} when each of those commits returns, and adds each
   * heartbeat statement to {@code sends}.
   */
  private static DataSource delayingHeartbeatCommits(
      DataSource source, long delayMs, int count, List<Long> failedAt, List<HeartbeatSend> sends) {
    AtomicInteger delayed = new AtomicInteger();
    return (DataSource)
        Proxy.newProxyInstance(
            DataSource.class.getClassLoader(),
            new Class<?>[] {DataSource.class},
            (proxy, method, arguments) -> {
              long connectStartedAt = System.nanoTime();
              Object result;
              try {
                result = method.invoke(source, arguments);
              } catch (InvocationTargetException error) {
                throw error.getCause();
              }
              if (!method.getName().equals("getConnection")) {
                return result;
              }
              long connectedAt = System.nanoTime();
              Connection connection = (Connection) result;
              AtomicBoolean heartbeat = new AtomicBoolean();
              return Proxy.newProxyInstance(
                  Connection.class.getClassLoader(),
                  new Class<?>[] {Connection.class},
                  (inner, call, values) -> {
                    if (call.getName().equals("prepareStatement")
                        && String.valueOf(values[0]).contains("heartbeat_many_v2")) {
                      heartbeat.set(true);
                      sends.add(
                          new HeartbeatSend(connectStartedAt, connectedAt, System.nanoTime()));
                    }
                    boolean heartbeatCommit =
                        call.getName().equals("commit") && heartbeat.getAndSet(false);
                    Object answer;
                    try {
                      answer = call.invoke(connection, values);
                    } catch (InvocationTargetException error) {
                      throw error.getCause();
                    }
                    // Only a COMMIT that succeeded counts. A COMMIT can also fail on its own, for
                    // example after the server ended a session whose round had no time left. That
                    // COMMIT must not use one of the delays, or the test never sees its last
                    // failure.
                    boolean delay =
                        heartbeatCommit && delayed.getAndUpdate(n -> n < count ? n + 1 : n) < count;
                    if (delay) {
                      // After the commit, so no idle gap ends the session first.
                      Thread.sleep(delayMs);
                      failedAt.add(System.nanoTime());
                    }
                    return answer;
                  });
            });
  }

  /**
   * Makes every heartbeat statement wait until {@code blocker} commits. {@code heartbeat_many_v2}
   * skips a locked row and reports it busy, so a row lock no longer slows it. It always locks its
   * fast-tier rows first, so an {@code EXCLUSIVE} lock on {@code fast_task_runtime} makes it wait
   * on that table. Enqueue and claim of full-tier tasks do not need that lock.
   */
  private static void blockHeartbeats(Connection blocker) throws SQLException {
    blocker.setAutoCommit(false);
    try (PreparedStatement lock =
        blocker.prepareStatement("LOCK TABLE workhorse.fast_task_runtime IN EXCLUSIVE MODE")) {
      lock.execute();
    }
  }

  private static int backendPid(Connection connection) throws SQLException {
    try (PreparedStatement query = connection.prepareStatement("SELECT pg_backend_pid()");
        ResultSet result = query.executeQuery()) {
      assertTrue(result.next(), "the backend has a process id");
      return result.getInt(1);
    }
  }

  /**
   * Whether a heartbeat statement waits on the lock of the backend {@code blockerPid} ({@code
   * waits} true), or no statement waits on it ({@code waits} false). An answer after {@code
   * deadline}, a {@link System#nanoTime()} value, does not count.
   */
  private static boolean heartbeatsReach(
      Connection observer, int blockerPid, boolean waits, long deadline)
      throws SQLException, InterruptedException {
    try (PreparedStatement query =
        observer.prepareStatement(
            "SELECT count(*) FROM pg_stat_activity WHERE ? = ANY(pg_blocking_pids(pid))"
                + " AND query LIKE '%heartbeat_many%'")) {
      query.setInt(1, blockerPid);
      while (true) {
        try (ResultSet result = query.executeQuery()) {
          assertTrue(result.next(), "the count has a row");
          if (System.nanoTime() - deadline > 0) {
            return false;
          }
          if ((result.getLong(1) > 0) == waits) {
            return true;
          }
        }
        Thread.sleep(10);
      }
    }
  }

  /** The {@code Error} that {@link #failingTicks} throws. */
  private static final class InjectedError extends Error {
    private static final long serialVersionUID = 1L;

    InjectedError() {
      super("injected maintenance error");
    }
  }

  /** A source over {@code source} that throws {@link InjectedError} for each maintenance tick. */
  private static DataSource failingTicks(DataSource source) {
    return (DataSource)
        Proxy.newProxyInstance(
            DataSource.class.getClassLoader(),
            new Class<?>[] {DataSource.class},
            (proxy, method, arguments) -> {
              Object result;
              try {
                result = method.invoke(source, arguments);
              } catch (InvocationTargetException error) {
                throw error.getCause();
              }
              if (!method.getName().equals("getConnection")) {
                return result;
              }
              Connection connection = (Connection) result;
              return Proxy.newProxyInstance(
                  Connection.class.getClassLoader(),
                  new Class<?>[] {Connection.class},
                  (inner, call, values) -> {
                    if (call.getName().equals("prepareStatement")
                        && String.valueOf(values[0]).contains("tick_v1")) {
                      throw new InjectedError();
                    }
                    try {
                      return call.invoke(connection, values);
                    } catch (InvocationTargetException error) {
                      throw error.getCause();
                    }
                  });
            });
  }

  /** A logger that keeps each record at {@code ERROR}, with its message and its error. */
  private static final class ErrorRecords implements System.Logger {
    final List<String> messages = new CopyOnWriteArrayList<>();
    final List<@Nullable Throwable> errors = new CopyOnWriteArrayList<>();

    @Override
    public String getName() {
      return "errors";
    }

    @Override
    public boolean isLoggable(Level level) {
      return true;
    }

    @Override
    public void log(
        Level level,
        java.util.@Nullable ResourceBundle bundle,
        @Nullable String message,
        @Nullable Throwable thrown) {
      if (level == Level.ERROR) {
        errors.add(thrown);
        messages.add(String.valueOf(message));
      }
    }

    @Override
    public void log(
        Level level,
        java.util.@Nullable ResourceBundle bundle,
        @Nullable String format,
        @Nullable Object... parameters) {
      log(level, bundle, format, (Throwable) null);
    }
  }

  // SM-1517: the owner of a started worker learns of a failed run only at close, so the worker
  // logs the error at once.
  @Test
  void logsAStartedRunThatEndsWithoutAStopAtErrorAtOnce() throws Exception {
    ErrorRecords records = new ErrorRecords();
    Worker worker =
        Worker.builder(failingTicks(dataSource))
            .queues(queueName)
            .pollingOnly(true)
            .pollInterval(Duration.ofMillis(10))
            .maintenanceInterval(Duration.ofMillis(100))
            .disableRegistry(true)
            .logger(records)
            .build();
    worker.start();
    waitUntil("the run ends", () -> !worker.isRunning());

    assertEquals(1, records.errors.size(), "one ERROR record before close: " + records.messages);
    assertTrue(records.errors.get(0) instanceof InjectedError, "the record carries the error");
    assertTrue(records.messages.get(0).contains("event.name=workhorse.worker.run_failed"));
    assertThrows(InjectedError.class, worker::close);
    assertEquals(1, records.errors.size(), "close does not log the error again");
  }

  @Test
  void logsAStartedRunThatAHandlerErrorEndsAtErrorAtOnce() {
    // A handler Error also changes the stop version inside the worker, but it is not a stop.
    ErrorRecords records = new ErrorRecords();
    Worker worker =
        worker()
            .logger(records)
            .handle(
                "fatal",
                Object.class,
                (ctx, payload) -> {
                  throw new InjectedError();
                })
            .build();
    worker.start();
    enqueue("fatal", null);
    waitUntil("the run ends", () -> !worker.isRunning());

    assertEquals(1, records.errors.size(), "one ERROR record before close: " + records.messages);
    assertTrue(records.errors.get(0) instanceof InjectedError, "the record carries the error");
    assertThrows(InjectedError.class, worker::close);
  }

  @Test
  void logsNoRunFailureForAStartedRunThatAStopEnds() {
    ErrorRecords records = new ErrorRecords();
    Worker worker = worker().logger(records).build();
    worker.start();
    worker.close();

    assertEquals(List.of(), records.messages, "a stopped run logs nothing at ERROR");
  }

  // ADR 0078 rule 4: a failed maintenance pass ends the run, also for an Error (SM-1458).
  @Test
  void endsTheRunWhenAMaintenancePassThrowsAnError() throws Exception {
    Worker worker =
        Worker.builder(failingTicks(dataSource))
            .queues(queueName)
            .pollingOnly(true)
            .pollInterval(Duration.ofMillis(10))
            .maintenanceInterval(Duration.ofMillis(100))
            .disableRegistry(true)
            .build();
    AtomicReference<@Nullable Throwable> failure = new AtomicReference<>();
    Thread runner =
        Thread.ofPlatform()
            .start(
                () -> {
                  try {
                    worker.run();
                  } catch (Throwable error) {
                    failure.set(error);
                  }
                });
    runner.join(Duration.ofSeconds(10));
    boolean ended = !runner.isAlive();
    worker.stop();
    runner.join(WAIT);
    assertTrue(ended, "the run ended after the failed maintenance pass");
    assertTrue(
        failure.get() instanceof InjectedError, "run threw the pass's Error: " + failure.get());
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

  /**
   * The worker clock runs ahead of PostgreSQL by more than one lease. The handler moves the stored
   * attempt timeout 2.5 s later, and the lease is 2 s. The local timer fires first, and PostgreSQL
   * answers {@code not_due} until its clock reaches the stored value. The heartbeats must renew the
   * lease in that time, so the attempt ends on its execution timeout, not on a lost lease.
   *
   * <p>A wrapper counts each call of {@code workhorse.expire_owned_v1}. The retry starts at 5 ms
   * and doubles up to 1 s, so the worker asks about 11 times. A fixed 5 ms retry asks hundreds of
   * times, and each request locks the task row against the heartbeat (SM-1701). The maintenance
   * interval of one hour lets only the worker's own request settle the timeout. The timeout of 1.5
   * s gives the handler time to move the stored value before the local timer fires.
   */
  @Test
  void backsOffItsExpiryRequestsWhilePostgresqlAnswersNotDue() throws Exception {
    try (Connection setup = ScratchDatabase.connect();
        Statement statement = setup.createStatement()) {
      statement.execute("CREATE SEQUENCE workhorse_test_expiry_asks");
      statement.execute(
          "ALTER FUNCTION workhorse.expire_owned_v1(uuid, text, bigint)"
              + " RENAME TO expire_owned_v1__counted");
      statement.execute(
          "CREATE FUNCTION workhorse.expire_owned_v1("
              + "p_task_id uuid, p_worker_id text, p_fence_token bigint) RETURNS text"
              + " LANGUAGE plpgsql AS $$ BEGIN PERFORM nextval('workhorse_test_expiry_asks');"
              + " RETURN workhorse.expire_owned_v1__counted(p_task_id, p_worker_id, p_fence_token);"
              + " END $$");
    }
    ExecutorService runner = Executors.newSingleThreadExecutor();
    try {
      UUID taskId =
          enqueue(
              "skewed",
              Map.of(),
              EnqueueOptions.builder().executionTimeout(Duration.ofMillis(1500)).maxAttempts(1));
      AtomicReference<@Nullable CancellationReason> reason = new AtomicReference<>();
      AtomicBoolean afterDatabaseExpiry = new AtomicBoolean();
      Worker worker =
          worker()
              .lease(Duration.ofSeconds(2))
              .heartbeat(Duration.ofMillis(200))
              .maintenanceInterval(Duration.ofHours(1))
              .handle(
                  "skewed",
                  Object.class,
                  (ctx, payload) -> {
                    String expiry;
                    try (Connection connection = ScratchDatabase.connect();
                        PreparedStatement move =
                            connection.prepareStatement(
                                "UPDATE workhorse.task_runtime SET attempt_timeout_at ="
                                    + " attempt_timeout_at + interval '2500 milliseconds'"
                                    + " WHERE task_id = ?::uuid AND attempt_timeout_at > clock_timestamp()"
                                    + " RETURNING attempt_timeout_at::text")) {
                      move.setString(1, taskId.toString());
                      try (ResultSet moved = move.executeQuery()) {
                        assertTrue(moved.next(), "the handler moves the stored attempt timeout");
                        expiry = moved.getString(1);
                      }
                    }
                    ctx.cancellation().await(WAIT);
                    try (Connection connection = ScratchDatabase.connect();
                        PreparedStatement passed =
                            connection.prepareStatement(
                                "SELECT clock_timestamp() >= ?::timestamptz")) {
                      passed.setString(1, expiry);
                      try (ResultSet row = passed.executeQuery()) {
                        row.next();
                        afterDatabaseExpiry.set(row.getBoolean(1));
                      }
                    }
                    reason.set(ctx.cancellation().reason());
                    return null;
                  })
              .build();

      assertTrue(runner.submit(worker::runOnce).get(30, TimeUnit.SECONDS));

      assertEquals(CancellationReason.EXECUTION_TIMEOUT, reason.get(), "the lease stays renewed");
      assertTrue(afterDatabaseExpiry.get(), "the cancellation comes after the database expiry");
      assertEquals("failed", status(taskId).state());
      long asks;
      try (Connection connection = ScratchDatabase.connect();
          Statement statement = connection.createStatement();
          ResultSet row =
              statement.executeQuery("SELECT last_value FROM workhorse_test_expiry_asks")) {
        row.next();
        asks = row.getLong(1);
      }
      assertTrue(asks <= 20, "the worker asks " + asks + " times, more than 20");
    } finally {
      runner.shutdownNow();
      try (Connection teardown = ScratchDatabase.connect();
          Statement statement = teardown.createStatement()) {
        statement.execute("DROP FUNCTION workhorse.expire_owned_v1(uuid, text, bigint)");
        statement.execute(
            "ALTER FUNCTION workhorse.expire_owned_v1__counted(uuid, text, bigint)"
                + " RENAME TO expire_owned_v1");
        statement.execute("DROP SEQUENCE workhorse_test_expiry_asks");
      }
    }
  }

  /**
   * The deadline passes while the handler runs, so the worker cancels the attempt. A claim skips a
   * task whose deadline has passed. On a loaded host, the claim came more than 400 ms after the
   * enqueue, and {@code runOnce} found no task (SM-1554). So if no task ran and the deadline has
   * passed, the test enqueues a new task with a deadline four times as far away.
   */
  @Test
  void cancelsAnAttemptThatPassesItsDeadline() throws Exception {
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

    for (long windowMs = 400; ; windowMs *= 4) {
      Instant deadline = Instant.now().plusMillis(windowMs);
      UUID taskId = enqueue("late", Map.of(), EnqueueOptions.builder().deadline(deadline));
      if (worker.runOnce()) {
        assertEquals(CancellationReason.DEADLINE_EXCEEDED, reason.get());
        assertFalse(List.of("active", "succeeded").contains(status(taskId).state()));
        return;
      }
      assertTrue(
          Instant.now().isAfter(deadline),
          "the worker claimed no task before its deadline of " + windowMs + " ms");
      assertTrue(windowMs < 6_400, "precondition not met: each claim came after the deadline");
    }
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
      // A claim that started before the pause still sends its statement, and its tasks run
      // (SM-1547). After the loop sees the pause once, it starts no claim, so the test waits for
      // that pass and then for each earlier claim to answer.
      long observed = worker.pauseObservations();
      waitUntil("the dispatch loop sees the pause", () -> worker.pauseObservations() > observed);
      waitUntil("no claim is in flight", () -> worker.claimsInFlight() == 0);
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
  void registersTheTrainVersionAsItsSdkVersion() throws Exception {
    String train = System.getProperty("workhorse.version");
    assertNotNull(train, "the build sets the workhorse.version system property");
    Worker worker =
        worker().disableRegistry(false).registryInterval(Duration.ofMillis(100)).build();
    worker.start();
    try {
      waitUntil(
          "the worker registers",
          () -> {
            try {
              return count(
                      "SELECT count(*) FROM workhorse.worker_registry WHERE worker_id = ?",
                      worker.workerId())
                  == 1;
            } catch (SQLException error) {
              throw new IllegalStateException(error);
            }
          });
      try (Connection connection = ScratchDatabase.connect();
          PreparedStatement statement =
              connection.prepareStatement(
                  "SELECT sdk_language, sdk_version FROM workhorse.worker_registry"
                      + " WHERE worker_id = ?")) {
        statement.setString(1, worker.workerId());
        try (ResultSet result = statement.executeQuery()) {
          assertTrue(result.next(), "the worker has a registry row");
          assertEquals("java", result.getString("sdk_language"));
          assertEquals(train, result.getString("sdk_version"));
        }
      }
    } finally {
      worker.close();
    }
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
                    // The reason first, so a test that sees the interrupt also sees the reason.
                    reason.set(ctx.cancellation().reason());
                    interrupted.set(true);
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
    try {
      worker.close();
    } catch (ShutdownIncompleteException slow) {
      // After the interrupt, the stuck attempt has one unwind window of 250 ms to release its
      // task. Under load, the release can take longer, and close throws while the attempt still
      // ends (SM-1543, as SM-1534). The test waits below for the release itself.
    }
    Duration drained = Duration.ofNanos(System.nanoTime() - stoppedAt);

    assertEquals("succeeded", status(quick).state(), "the drain let the quick task finish");
    assertEquals(Map.of("cancelled", false), json(status(quick).result()));
    waitUntil("the deadline interrupted the stuck handler", interrupted::get);
    assertEquals(CancellationReason.SHUTDOWN, reason.get());
    waitForState(stuck, "ready");
    Status released = status(stuck);
    assertEquals("ready", released.state(), "an interrupted handler releases its task");
    assertNull(released.error(), "the release charges no attempt");
    assertTrue(drained.compareTo(Duration.ofMillis(1_900)) >= 0, "the drain waited the grace");
    assertTrue(drained.compareTo(Duration.ofSeconds(10)) < 0, "the drain ended: " + drained);
  }

  /**
   * The handler fails with its own error after the drain cancels it. The worker then charges the
   * attempt, and does not release the task.
   *
   * <p>The handler throws only after the cancellation at the end of the grace. Its failure write
   * thus runs in the unwind window of 250 ms. On a loaded host, the write can take longer, and
   * {@code close} throws {@link ShutdownIncompleteException} while the write still ends (SM-1686,
   * as SM-1543). The drain stops only the lease renewal of an attempt that it abandons. The
   * duration of the drain is not what this test checks, so it waits for the outcome of the task.
   */
  @Test
  void stillChargesTheAttemptWhenAHandlerFailsOnItsOwnAfterTheStop() throws Exception {
    UUID taskId = enqueue("own", Map.of(), EnqueueOptions.builder().maxAttempts(1));
    CountDownLatch started = new CountDownLatch(1);
    AtomicReference<@Nullable CancellationReason> reason = new AtomicReference<>();
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
                  reason.set(ctx.cancellation().reason());
                  throw new IllegalStateException("own failure");
                })
            .build();
    worker.start();
    await(started, "the handler");
    try {
      worker.close();
    } catch (ShutdownIncompleteException slow) {
      assertEquals(1, slow.abandoned(), "only the failing attempt was still in flight");
    }

    // The handler records the reason before it throws, and the task leaves the active state only
    // after the throw. Even if the handler starts late, it records the reason before this wait
    // ends.
    waitUntil(
        taskId + " left the active state",
        () -> {
          try {
            return !status(taskId).state().equals("active");
          } catch (SQLException error) {
            throw new IllegalStateException(error);
          }
        });
    assertEquals(CancellationReason.SHUTDOWN, reason.get(), "the handler failed after the stop");
    Status charged = status(taskId);
    assertEquals("failed", charged.state(), "the own failure charged the only attempt");
    assertEquals(1, charged.attempt());
    assertTrue(
        String.valueOf(charged.error()).contains("own failure"),
        "the failure is the handler's own: " + charged.error());
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

  /**
   * Maintenance writes shared due times and retention cutoffs, so the worker binds the text {@code
   * now} and PostgreSQL chooses the time. A host clock that runs fast or slow cannot move them.
   */
  @Test
  void bindsTheDatabaseClockToMaintenance() throws Exception {
    List<Object> bound = new CopyOnWriteArrayList<>();
    Worker subject =
        Worker.builder(recordingMaintenanceTime(dataSource, bound))
            .queues(queueName)
            .pollingOnly(true)
            .pollInterval(Duration.ofMillis(10))
            .disableRegistry(true)
            .build();

    assertFalse(subject.runOnce());
    assertEquals(List.of("now"), bound);
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

  // SM-1540: the result path checks the numeric scale before the value becomes a double.
  @Test
  void refusesAResultWithMoreFractionDigitsThanPostgreSqlStores() throws SQLException {
    UUID taskId = enqueue("scale", Map.of(), EnqueueOptions.builder().maxAttempts(1));
    BigDecimal half = new BigDecimal("0.5" + "0".repeat(16_383));

    assertTrue(
        worker().handle("scale", Object.class, (ctx, p) -> Map.of("rate", half)).build().runOnce());

    Status failed = status(taskId);
    assertEquals("failed", failed.state(), "the attempt fails before PostgreSQL sees the value");
    Map<String, @Nullable Object> error = Json.object(json(failed.error()));
    assertNotNull(error);
    assertEquals("IllegalArgumentException", error.get("name"));
    assertTrue(
        String.valueOf(error.get("message")).endsWith("a number outside the numeric range"),
        String.valueOf(error.get("message")));
  }

  // SM-1512: a durable replay conflict inside a wrapper is terminal, as in Go and Rust.
  @Test
  void failsAWrappedReplayConflictAtOnce() throws SQLException {
    UUID taskId = enqueue("wrapped", Map.of(), EnqueueOptions.builder().maxAttempts(5));
    AtomicInteger delays = new AtomicInteger();

    assertTrue(
        worker()
            .retryDelay(
                (attempt, task) -> {
                  delays.incrementAndGet();
                  return Duration.ofSeconds(60);
                })
            .handle(
                "wrapped",
                Object.class,
                (ctx, p) -> {
                  throw new java.util.concurrent.CompletionException(
                      new ConflictException("checkpoint", "charge"));
                })
            .build()
            .runOnce());

    Status failed = status(taskId);
    assertEquals("failed", failed.state());
    assertEquals(1, failed.attempt());
    assertEquals(0, delays.get(), "a terminal conflict asks for no retry delay");
    assertEquals("ConflictException", Json.object(json(failed.error())).get("name"));
  }

  // SM-1709: a cancellation or a lease loss removes a batch member that waits for its linger. The
  // handler never gets it, and the other members keep their order and dispatch.
  @Test
  void removesACanceledWaitingBatchMemberAndKeepsTheOrderOfItsPeers() throws Exception {
    UUID first =
        enqueue("lingering", Map.of("name", "first"), EnqueueOptions.builder().priority(3));
    UUID canceled =
        enqueue("lingering", Map.of("name", "canceled"), EnqueueOptions.builder().priority(2));
    UUID last = enqueue("lingering", Map.of("name", "last"), EnqueueOptions.builder().priority(1));
    List<List<@Nullable Object>> batches = new CopyOnWriteArrayList<>();
    Worker worker = lingeringBatchWorker(Duration.ofSeconds(5), batches);
    worker.start();
    try {
      for (UUID taskId : List.of(first, canceled, last)) {
        waitForState(taskId, "active");
      }
      queue.cancel(canceled, "test", "member canceled");
      waitForState(canceled, "canceled");
      assertEquals(List.of(), batches, "the member left before the linger ended");
      waitForState(first, "succeeded");
      waitForState(last, "succeeded");
    } finally {
      worker.close();
    }
    assertEquals(List.of(List.of("first", "last")), batches);
    assertEquals("first", json(status(first).result()));
    assertEquals("last", json(status(last).result()));
  }

  // SM-1709: when the last waiting member leaves, its linger ends. It does not wait 60 s.
  @Test
  void endsTheLingerWhenTheLastWaitingBatchMemberIsCanceled() throws Exception {
    UUID only = enqueue("lingering", Map.of("name", "only"));
    List<List<@Nullable Object>> batches = new CopyOnWriteArrayList<>();
    Worker worker = lingeringBatchWorker(Duration.ofSeconds(60), batches);
    worker.start();
    try {
      waitForState(only, "active");
      queue.cancel(only, "test", "member canceled");
      waitForState(only, "canceled");
    } finally {
      worker.close();
    }
    assertEquals(List.of(), batches);
  }

  private Worker lingeringBatchWorker(Duration linger, List<List<@Nullable Object>> batches) {
    return worker()
        .concurrency(4)
        .lease(Duration.ofSeconds(30))
        .heartbeat(Duration.ofMillis(100))
        .handleBatch(
            "lingering",
            Object.class,
            new BatchOptions(4, linger),
            items -> {
              List<@Nullable Object> names =
                  items.stream()
                      .<@Nullable Object>map(item -> ((Map<?, ?>) item.payload()).get("name"))
                      .toList();
              batches.add(names);
              return names.stream().<BatchHandlerOutcome>map(BatchSucceeded::new).toList();
            })
        .build();
  }

  // SM-1525 (m3): a logger that throws before the batch handler fails each member, and no member
  // on another thread waits forever.
  @Test
  void failsEveryBatchMemberWhenTheDispatchThrowsBeforeTheHandler() throws Exception {
    List<UUID> taskIds =
        List.of(
            enqueue("batched", Map.of(), EnqueueOptions.builder().maxAttempts(1)),
            enqueue("batched", Map.of(), EnqueueOptions.builder().maxAttempts(1)));
    AtomicInteger handled = new AtomicInteger();
    System.Logger throwing =
        new System.Logger() {
          @Override
          public String getName() {
            return "throwing";
          }

          @Override
          public boolean isLoggable(Level level) {
            return true;
          }

          @Override
          public void log(
              Level level,
              java.util.@Nullable ResourceBundle bundle,
              @Nullable String message,
              @Nullable Throwable thrown) {
            if (message != null && message.startsWith("Task batch dispatched")) {
              throw new IllegalStateException("the logger failed");
            }
          }

          @Override
          public void log(
              Level level,
              java.util.@Nullable ResourceBundle bundle,
              @Nullable String format,
              @Nullable Object... parameters) {
            log(level, bundle, format, (Throwable) null);
          }
        };
    Worker worker =
        worker()
            .concurrency(2)
            .logger(throwing)
            .handleBatch(
                "batched",
                Object.class,
                new BatchOptions(2, Duration.ofSeconds(5)),
                items -> {
                  handled.incrementAndGet();
                  return items.stream()
                      .<BatchHandlerOutcome>map(item -> new BatchSucceeded("done"))
                      .toList();
                })
            .build();
    worker.start();
    try {
      for (UUID taskId : taskIds) {
        waitUntil("each member fails", () -> "failed".equals(statusUnchecked(taskId).state()));
      }
    } finally {
      worker.close();
    }
    assertEquals(0, handled.get(), "the handler did not run");
    for (UUID taskId : taskIds) {
      assertEquals("IllegalStateException", Json.object(json(status(taskId).error())).get("name"));
    }
  }

  private static Status statusUnchecked(UUID taskId) {
    try {
      return status(taskId);
    } catch (SQLException error) {
      throw new AssertionError(error);
    }
  }

  // SM-1525 (m16): a task that the caller's executor never started goes back to its queue at the
  // drain deadline, and the drain does not count it as an abandoned handler. The stop waits for the
  // release until its total stop time ends, the grace plus the 250 ms unwind window (SM-1569). On a
  // loaded host the release can end later, so the test waits for it after the close.
  @Test
  void releasesATaskThatTheCallerExecutorNeverStarted() throws Exception {
    UUID taskId = enqueue("unstarted", Map.of());
    List<Runnable> held = new CopyOnWriteArrayList<>();
    ExecutorService holding =
        new java.util.concurrent.AbstractExecutorService() {
          @Override
          public void execute(Runnable command) {
            held.add(command);
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
        };
    AtomicInteger handled = new AtomicInteger();
    Worker worker =
        worker()
            .executor(holding)
            .shutdownGrace(Duration.ZERO)
            .handle(
                "unstarted",
                Object.class,
                (ctx, p) -> {
                  handled.incrementAndGet();
                  return null;
                })
            .build();
    worker.start();
    waitUntil("the executor holds the task", () -> !held.isEmpty());
    worker.close();

    waitUntil(
        "the task is back in its queue",
        () -> {
          try {
            return "ready".equals(status(taskId).state());
          } catch (SQLException error) {
            throw new AssertionError(error);
          }
        });
    Status released = status(taskId);
    assertEquals("ready", released.state(), "the task is back in its queue");
    assertNull(released.workerId(), "no worker holds the lease");
    assertEquals(
        1,
        count(
            "SELECT count(*) FROM workhorse.task_event WHERE event_type = 'released'"
                + " AND task_id = ?::uuid",
            taskId.toString()),
        "the worker released the lease");
    held.forEach(Runnable::run);
    assertEquals(0, handled.get(), "a late runnable does not start the handler");
  }

  // SM-1547: a claim that started before a pause sends its statement after the pause, and the task
  // that it claims runs, as in the TypeScript reference and docs/architecture/lifecycle.md.
  @Test
  void runsATaskThatAClaimFromBeforeThePauseTakes() throws Exception {
    CountDownLatch holding = new CountDownLatch(1);
    CountDownLatch release = new CountDownLatch(1);
    AtomicBoolean armed = new AtomicBoolean(true);
    DataSource held =
        (DataSource)
            Proxy.newProxyInstance(
                DataSource.class.getClassLoader(),
                new Class<?>[] {DataSource.class},
                (proxy, method, arguments) -> {
                  Object result;
                  try {
                    result = method.invoke(dataSource, arguments);
                  } catch (InvocationTargetException error) {
                    throw error.getCause();
                  }
                  if (!method.getName().equals("getConnection")) {
                    return result;
                  }
                  Connection connection = (Connection) result;
                  return Proxy.newProxyInstance(
                      Connection.class.getClassLoader(),
                      new Class<?>[] {Connection.class},
                      (inner, call, values) -> {
                        if (call.getName().equals("prepareStatement")
                            && String.valueOf(values[0]).contains("claim_many_v1")
                            && armed.compareAndSet(true, false)) {
                          holding.countDown();
                          assertTrue(release.await(WAIT.toSeconds(), TimeUnit.SECONDS));
                        }
                        try {
                          return call.invoke(connection, values);
                        } catch (InvocationTargetException error) {
                          throw error.getCause();
                        }
                      });
                });
    Worker worker =
        Worker.builder(held)
            .queues(queueName)
            .pollingOnly(true)
            .pollInterval(Duration.ofMillis(10))
            .disableRegistry(true)
            .handle("echo", Object.class, (ctx, payload) -> payload)
            .build();
    worker.start();
    try {
      await(holding, "the claim holds before its statement");
      worker.pause();
      assertTrue(worker.isPaused());
      UUID taskId = enqueue("echo", "late");
      release.countDown();

      waitForState(taskId, "succeeded");
      assertTrue(worker.isPaused(), "the worker is still paused");
      waitUntil("the claim answered", () -> worker.claimsInFlight() == 0);
    } finally {
      release.countDown();
      worker.close();
    }
  }
}
