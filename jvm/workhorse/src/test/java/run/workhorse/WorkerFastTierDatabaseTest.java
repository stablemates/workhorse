package run.workhorse;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertInstanceOf;
import static org.junit.jupiter.api.Assertions.assertNotSame;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.time.Duration;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.function.BooleanSupplier;
import org.jspecify.annotations.Nullable;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.extension.ExtendWith;
import run.workhorse.internal.Json;
import run.workhorse.internal.Sql;
import run.workhorse.internal.SqlCatalogue;
import run.workhorse.testing.ScratchDataSource;
import run.workhorse.testing.ScratchDatabase;

/**
 * The fast task tier (ADR 0077), slot cohorts with fused completion and refill (ADR 0076), and
 * batch delivery, against PostgreSQL. The counterpart of Ruby's {@code worker_fast_tier_spec.rb}.
 * Every wait is bounded.
 */
@ExtendWith(ScratchDatabase.class)
@Timeout(value = 120, unit = TimeUnit.SECONDS)
class WorkerFastTierDatabaseTest {
  private static final Duration WAIT = Duration.ofSeconds(20);

  private final ScratchDataSource dataSource = new ScratchDataSource(true);
  private final Queue queue = new Queue(ConnectionSource.of(dataSource));
  private String queueName = "";

  @BeforeEach
  void name() {
    queueName = "jvm-fast-" + UUID.randomUUID();
  }

  private Worker.Builder worker() {
    return Worker.builder(dataSource)
        .queues(queueName)
        .pollingOnly(true)
        .pollInterval(Duration.ofMillis(10))
        .disableRegistry(true);
  }

  private void makeFast() throws SQLException {
    try (Connection connection = ScratchDatabase.connect()) {
      Sql.rows(connection, SqlCatalogue.SET_QUEUE_TIER_V1, queueName, "fast", "jvm-test", "test");
    }
  }

  private UUID enqueue(String taskType, @Nullable Object payload, EnqueueOptions.Builder options) {
    return queue.enqueue(taskType, payload, options.queue(queueName).build()).taskId();
  }

  private UUID enqueue(String taskType, @Nullable Object payload) {
    return enqueue(taskType, payload, EnqueueOptions.builder());
  }

  /** The state of each task that has a fast-tier outcome row. */
  private static Map<UUID, String> fastOutcomes(List<UUID> taskIds) throws SQLException {
    return states(
        "SELECT task_id, state FROM workhorse.fast_task_outcome WHERE task_id = ANY(?::uuid[])",
        taskIds);
  }

  /** The state of each task on the full tier, from its outcome or its runtime row. */
  private static Map<UUID, String> fullStates(List<UUID> taskIds) throws SQLException {
    return states(
        "SELECT t.id, COALESCE(o.state, r.state) FROM workhorse.task t"
            + " LEFT JOIN workhorse.task_runtime r ON r.task_id = t.id"
            + " LEFT JOIN workhorse.task_outcome o ON o.task_id = t.id"
            + " WHERE t.id = ANY(?::uuid[])",
        taskIds);
  }

  private static Map<UUID, String> states(String sql, List<UUID> taskIds) throws SQLException {
    Map<UUID, String> states = new HashMap<>();
    try (Connection connection = ScratchDatabase.connect();
        PreparedStatement statement = connection.prepareStatement(sql)) {
      statement.setArray(
          1,
          connection.createArrayOf(
              "text", taskIds.stream().map(UUID::toString).toArray(String[]::new)));
      try (ResultSet result = statement.executeQuery()) {
        while (result.next()) {
          states.put(UUID.fromString(result.getString(1)), result.getString(2));
        }
      }
    }
    return states;
  }

  private static List<String> column(String sql, String parameter) throws SQLException {
    List<String> values = new ArrayList<>();
    try (Connection connection = ScratchDatabase.connect();
        PreparedStatement statement = connection.prepareStatement(sql)) {
      statement.setString(1, parameter);
      try (ResultSet result = statement.executeQuery()) {
        while (result.next()) {
          values.add(result.getString(1));
        }
      }
    }
    return values;
  }

  private static String errorMessage(UUID taskId) throws SQLException {
    List<String> errors =
        column(
            "SELECT COALESCE(o.error, f.error)::text FROM workhorse.task t"
                + " LEFT JOIN workhorse.task_outcome o ON o.task_id = t.id"
                + " LEFT JOIN workhorse.fast_task_outcome f ON f.task_id = t.id"
                + " WHERE t.id = ?::uuid",
            taskId.toString());
    Object envelope = Json.parse(errors.get(0));
    return String.valueOf(((Map<?, ?>) envelope).get("message"));
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

  /**
   * Closes {@code worker} after a drain with a zero grace, and waits until no task of {@code
   * taskIds} is active. After the interrupt, a batch has one unwind window of 250 ms to settle. On
   * a loaded host, the settle can take longer, and close throws {@link ShutdownIncompleteException}
   * while the batch still settles (SM-1563, as SM-1543). The drain stops only the lease renewal of
   * an attempt that it abandons. Every other error of close still fails the test.
   */
  private static void closeAndWaitUntilSettled(Worker worker, List<UUID> taskIds) {
    try {
      worker.close();
    } catch (ShutdownIncompleteException slow) {
      // The batch settles after the unwind window. The wait below sees its outcome.
    }
    waitUntil(
        "every member settled",
        () -> {
          try {
            return !fullStates(taskIds).containsValue("active");
          } catch (SQLException error) {
            throw new IllegalStateException(error);
          }
        });
  }

  /** Runs the worker on its own thread until {@code condition} holds, then closes it. */
  private static void runUntil(Worker worker, String what, BooleanSupplier condition) {
    worker.start();
    try {
      waitUntil(what, condition);
    } finally {
      worker.close();
    }
  }

  private static BooleanSupplier allFast(List<UUID> taskIds) {
    return () -> {
      try {
        return fastOutcomes(taskIds).size() == taskIds.size();
      } catch (SQLException error) {
        throw new IllegalStateException(error);
      }
    };
  }

  private static int index(@Nullable Object payload) {
    return ((Number) ((Map<?, ?>) payload).get("index")).intValue();
  }

  // The fast tier.

  @Test
  void runsFastTierTasksAndRecordsOneFastOutcomeRowForEach() throws SQLException {
    makeFast();
    List<UUID> succeeding = new ArrayList<>();
    for (int index = 0; index < 12; index++) {
      succeeding.add(enqueue("fast", Map.of("index", index)));
    }
    UUID failing = enqueue("fast-failure", Map.of(), EnqueueOptions.builder().maxAttempts(1));
    List<UUID> taskIds = new ArrayList<>(succeeding);
    taskIds.add(failing);
    List<Worker.FusedStatement> statements = new CopyOnWriteArrayList<>();
    Worker worker =
        worker()
            .concurrency(4)
            .handle("fast", Object.class, (ctx, payload) -> Map.of("index", index(payload)))
            .handle(
                "fast-failure",
                Object.class,
                (ctx, payload) -> {
                  throw new IllegalStateException("fast failure");
                })
            .build();
    worker.fusedStatementHook = statements::add;

    runUntil(worker, "every fast task finished", allFast(taskIds));

    Map<UUID, String> expected = new HashMap<>();
    succeeding.forEach(taskId -> expected.put(taskId, "succeeded"));
    expected.put(failing, "failed");
    assertEquals(expected, fastOutcomes(taskIds));
    assertEquals(
        List.of("0"),
        column(
            "SELECT count(*) FROM workhorse.task_outcome WHERE task_id = ANY(string_to_array(?,"
                + " ',')::uuid[])",
            String.join(",", taskIds.stream().map(UUID::toString).toList())));
    int completed = statements.stream().mapToInt(Worker.FusedStatement::completions).sum();
    assertEquals(
        succeeding.size(), completed, "every success completes through the fused statement");
  }

  @Test
  void aFullTierQueueClaimsThroughClaimManyAfterTheFastProbeRejectsIt() throws SQLException {
    UUID taskId = enqueue("full", Map.of("index", 1));
    List<Worker.FusedStatement> statements = new CopyOnWriteArrayList<>();
    Worker worker = worker().handle("full", Object.class, (ctx, payload) -> index(payload)).build();
    worker.fusedStatementHook = statements::add;

    assertTrue(worker.runOnce());

    assertEquals(Map.of(taskId, "succeeded"), fullStates(List.of(taskId)));
    assertEquals(List.of(), statements, "a full-tier queue accepts no fused statement");
  }

  @Test
  void fusesEachCompletionWithARefillClaimBoundedByItsSlotCohort() throws SQLException {
    makeFast();
    List<UUID> taskIds = new ArrayList<>();
    for (int index = 0; index < 40; index++) {
      taskIds.add(enqueue("cohort", Map.of("index", index)));
    }
    AtomicInteger running = new AtomicInteger();
    AtomicInteger peak = new AtomicInteger();
    List<Worker.FusedStatement> statements = new CopyOnWriteArrayList<>();
    Worker worker =
        worker()
            .concurrency(8)
            .cohorts(2)
            .handle(
                "cohort",
                Object.class,
                (ctx, payload) -> {
                  peak.accumulateAndGet(running.incrementAndGet(), Math::max);
                  try {
                    Thread.sleep(10);
                    return Map.of();
                  } finally {
                    running.decrementAndGet();
                  }
                })
            .build();
    assertEquals(2, worker.cohorts());
    worker.fusedStatementHook = statements::add;

    runUntil(worker, "every cohort task finished", allFast(taskIds));

    assertEquals(List.of("succeeded"), fastOutcomes(taskIds).values().stream().distinct().toList());
    List<Worker.FusedStatement> completing =
        statements.stream().filter(statement -> statement.completions() > 0).toList();
    assertEquals(
        taskIds.size(), completing.stream().mapToInt(Worker.FusedStatement::completions).sum());
    // Each cohort's first claim fills its own four slots.
    assertEquals(
        List.of(new Worker.FusedStatement(0, 4, 4), new Worker.FusedStatement(0, 4, 4)),
        statements.stream().filter(statement -> statement.completions() == 0).limit(2).toList());
    // A statement carries only one cohort's completions and claims only into that cohort.
    for (Worker.FusedStatement statement : completing) {
      assertTrue(
          Math.max(statement.completions(), statement.claimLimit()) <= 4,
          "statement " + statement + " stays inside one cohort");
    }
    assertTrue(completing.stream().anyMatch(statement -> statement.claimed() > 0));
    assertTrue(peak.get() <= 8, "peak " + peak.get() + " stays within the concurrency");
  }

  @Test
  void cohortsDefaultFromTheConcurrencyAndStayWithinIt() {
    Map<Integer, Integer> defaults = new LinkedHashMap<>();
    for (int concurrency : new int[] {1, 7, 8, 9, 64}) {
      defaults.put(concurrency, worker().concurrency(concurrency).build().cohorts());
    }
    assertEquals(Map.of(1, 1, 7, 1, 8, 2, 9, 2, 64, 8), defaults);
    assertEquals(8, Worker.defaultCohorts(100, null));
    assertEquals(3, worker().concurrency(3).cohorts(3).build().cohorts());
    assertThrows(IllegalArgumentException.class, () -> worker().cohorts(0));
    assertThrows(IllegalArgumentException.class, () -> worker().concurrency(2).cohorts(3).build());
  }

  @Test
  void throttlesAFastTierEnqueueAndWritesNoThrottledEvent() throws SQLException {
    makeFast();
    Throttle throttle = new Throttle("digest", Duration.ofMinutes(1), queueName);
    EnqueueResult first =
        queue.enqueue(
            "digest",
            Map.of("n", 1),
            EnqueueOptions.builder().queue(queueName).throttle(throttle).build());
    EnqueueResult second =
        queue.enqueue(
            "digest",
            Map.of("n", 1),
            EnqueueOptions.builder().queue(queueName).throttle(throttle).build());

    assertEquals(EnqueueOutcome.ACCEPTED, first.outcome());
    assertEquals(new EnqueueResult(first.taskId(), EnqueueOutcome.COALESCED, null), second);
    assertEquals(
        List.of("0"),
        column(
            "SELECT count(*) FROM workhorse.task_event WHERE task_id = ?::uuid",
            first.taskId().toString()));

    // A member that runs alone reports a fast-tier rejection with its ordinal in the batch.
    FastTierUnsupportedException rejected =
        assertThrows(
            FastTierUnsupportedException.class,
            () ->
                queue.enqueueMany(
                    List.of(
                        EnqueueRequest.of(
                            "plain", Map.of(), EnqueueOptions.builder().queue(queueName).build()),
                        EnqueueRequest.of(
                            "keyed",
                            Map.of(),
                            EnqueueOptions.builder()
                                .queue(queueName)
                                .concurrencyKey("tenant-a")
                                .throttle(new Throttle("keyed", Duration.ofMinutes(1), queueName))
                                .build()))));
    assertEquals(queueName, rejected.queue());
    assertEquals("concurrency keys", rejected.feature());
    assertEquals(2L, rejected.ordinal());
  }

  // Batch delivery.

  @Test
  void deliversABatchInOneCallOnTheFastTierAndOneFailedMemberFailsOnlyItself() throws SQLException {
    makeFast();
    List<UUID> taskIds = new ArrayList<>();
    for (int index = 0; index < 3; index++) {
      taskIds.add(
          enqueue(
              "batch",
              Map.of("index", index),
              EnqueueOptions.builder().priority(index).maxAttempts(1)));
    }
    List<List<Object>> calls = new CopyOnWriteArrayList<>();
    Worker worker =
        worker()
            .concurrency(3)
            .handleBatch(
                "batch",
                Object.class,
                new BatchOptions(3, Duration.ofSeconds(1)),
                items -> {
                  calls.add(
                      List.of(
                          items.stream().map(item -> index(item.payload())).toList(),
                          items.stream().map(item -> item.context().task().id()).toList(),
                          items.stream()
                              .map(item -> item.context().cancellation().isCancelled())
                              .toList()));
                  assertNotSame(
                      items.get(0).context().cancellation(), items.get(1).context().cancellation());
                  List<BatchHandlerOutcome> outcomes = new ArrayList<>();
                  for (BatchHandlerItem<Object> item : items) {
                    int index = index(item.payload());
                    outcomes.add(
                        index % 2 == 1
                            ? new BatchFailed(new IllegalArgumentException("odd"))
                            : new BatchSucceeded(Map.of("index", index)));
                  }
                  return outcomes;
                })
            .build();

    assertTrue(worker.runOnce());

    assertEquals(
        List.of(
            List.of(
                List.of(2, 1, 0), List.copyOf(taskIds.reversed()), List.of(false, false, false))),
        calls);
    assertEquals(
        Map.of(taskIds.get(0), "succeeded", taskIds.get(1), "failed", taskIds.get(2), "succeeded"),
        fastOutcomes(taskIds));
    assertEquals("odd", errorMessage(taskIds.get(1)));
  }

  @Test
  void failsEveryMemberWhenTheHandlerReturnsTheWrongNumberOfOutcomes() throws SQLException {
    List<UUID> taskIds =
        List.of(
            enqueue("short", Map.of(), EnqueueOptions.builder().maxAttempts(1)),
            enqueue("short", Map.of(), EnqueueOptions.builder().maxAttempts(1)));
    Worker worker =
        worker()
            .concurrency(2)
            .handleBatch(
                "short",
                Object.class,
                new BatchOptions(2, Duration.ofSeconds(1)),
                items -> List.of(new BatchSucceeded(null)))
            .build();

    assertTrue(worker.runOnce());

    assertEquals(Map.of(taskIds.get(0), "failed", taskIds.get(1), "failed"), fullStates(taskIds));
    for (UUID taskId : taskIds) {
      assertEquals("Batch handler for short returned 1 outcomes for 2 tasks", errorMessage(taskId));
    }
  }

  @Test
  void failsEveryMemberWhenTheHandlerReturnsNullOrANullOutcome() throws SQLException {
    UUID nullList = enqueue("null-list", Map.of(), EnqueueOptions.builder().maxAttempts(1));
    UUID nullOutcome = enqueue("null-outcome", Map.of(), EnqueueOptions.builder().maxAttempts(1));
    List<BatchHandlerOutcome> withNull = new ArrayList<>();
    withNull.add(null);
    Worker worker =
        worker()
            .concurrency(2)
            .handleBatch(
                "null-list", Object.class, new BatchOptions(1, Duration.ZERO), items -> null)
            .handleBatch(
                "null-outcome", Object.class, new BatchOptions(1, Duration.ZERO), items -> withNull)
            .build();

    assertTrue(worker.runOnce());

    assertEquals(
        Map.of(nullList, "failed", nullOutcome, "failed"),
        fullStates(List.of(nullList, nullOutcome)));
    assertEquals("Batch handler for null-list returned no outcome list", errorMessage(nullList));
    assertEquals(
        "Batch handler for null-outcome returned an invalid outcome at index 0",
        errorMessage(nullOutcome));
  }

  @Test
  void failsEveryMemberWithTheExceptionTheHandlerThrows() throws SQLException {
    List<UUID> taskIds =
        List.of(
            enqueue("throws", Map.of(), EnqueueOptions.builder().maxAttempts(1)),
            enqueue("throws", Map.of(), EnqueueOptions.builder().maxAttempts(1)));
    Worker worker =
        worker()
            .concurrency(2)
            .handleBatch(
                "throws",
                Object.class,
                new BatchOptions(2, Duration.ofSeconds(1)),
                items -> {
                  throw new IllegalStateException("whole batch");
                })
            .build();

    assertTrue(worker.runOnce());

    assertEquals(Map.of(taskIds.get(0), "failed", taskIds.get(1), "failed"), fullStates(taskIds));
    for (UUID taskId : taskIds) {
      assertEquals("whole batch", errorMessage(taskId));
    }
  }

  @Test
  void failsEveryMemberWithAWorkhorseExceptionWhenTheHandlerThrowsAnError() throws SQLException {
    List<UUID> taskIds =
        List.of(
            enqueue("error", Map.of(), EnqueueOptions.builder().maxAttempts(1)),
            enqueue("error", Map.of(), EnqueueOptions.builder().maxAttempts(1)));
    Worker worker =
        worker()
            .concurrency(2)
            .handleBatch(
                "error",
                Object.class,
                new BatchOptions(2, Duration.ofSeconds(1)),
                items -> {
                  throw new AssertionError("boom");
                })
            .build();

    assertTrue(worker.runOnce());

    assertEquals(Map.of(taskIds.get(0), "failed", taskIds.get(1), "failed"), fullStates(taskIds));
    for (UUID taskId : taskIds) {
      assertEquals("Batch handler for error raised AssertionError: boom", errorMessage(taskId));
    }
  }

  /**
   * The drain interrupts both members of a running batch. The member that waits for the batch keeps
   * its outcome, and does not give its task back.
   *
   * <p>The test waits for the settled states, and not for close ({@link
   * #closeAndWaitUntilSettled}).
   */
  @Test
  void aWaitingMemberKeepsItsOutcomeThroughTheDrainInterrupt() throws Exception {
    List<UUID> taskIds =
        List.of(
            enqueue("drained", Map.of(), EnqueueOptions.builder().maxAttempts(1)),
            enqueue("drained", Map.of(), EnqueueOptions.builder().maxAttempts(1)));
    CountDownLatch entered = new CountDownLatch(1);
    CountDownLatch never = new CountDownLatch(1);
    Worker worker =
        worker()
            .concurrency(2)
            .shutdownGrace(Duration.ZERO)
            .handleBatch(
                "drained",
                Object.class,
                new BatchOptions(2, Duration.ofSeconds(5)),
                items -> {
                  entered.countDown();
                  try {
                    never.await();
                  } catch (InterruptedException interrupted) {
                    // The drain interrupts this thread and the waiting member's thread.
                  }
                  return items.stream()
                      .<BatchHandlerOutcome>map(item -> new BatchSucceeded("done"))
                      .toList();
                })
            .build();
    worker.start();
    assertTrue(entered.await(WAIT.toSeconds(), TimeUnit.SECONDS), "the batch started");

    closeAndWaitUntilSettled(worker, taskIds);

    assertEquals(
        Map.of(taskIds.get(0), "succeeded", taskIds.get(1), "succeeded"), fullStates(taskIds));
  }

  /**
   * The drain interrupts a member that has not dispatched the batch yet. The member passes the
   * interrupt to the handler. The test waits for the settled states, and not for close ({@link
   * #closeAndWaitUntilSettled}).
   */
  @Test
  void aMemberThatTheDrainInterruptedBeforeItDispatchedPassesTheInterruptToTheHandler()
      throws Exception {
    List<UUID> taskIds =
        List.of(
            enqueue("lingered", Map.of("slow", false), EnqueueOptions.builder().maxAttempts(1)),
            enqueue("lingered", Map.of("slow", false), EnqueueOptions.builder().maxAttempts(1)),
            enqueue("lingered", Map.of("slow", true), EnqueueOptions.builder().maxAttempts(1)));
    CountDownLatch decoding = new CountDownLatch(1);
    CountDownLatch never = new CountDownLatch(1);
    JsonCodec standard = JsonCodec.standard();
    // The slow member blocks in its payload decode until the drain interrupts it. So the other two
    // members still linger, with the arrivals open, when the drain's interrupt reaches them.
    JsonCodec codec =
        new JsonCodec() {
          @Override
          public String encode(@Nullable Object value) {
            return standard.encode(value);
          }

          // JsonCodec fixes this signature: the type argument comes from the call site.
          @SuppressWarnings("TypeParameterUnusedInFormals")
          @Override
          public <T extends @Nullable Object> T decode(String json, java.lang.reflect.Type type) {
            if (json.contains("\"slow\": true") || json.contains("\"slow\":true")) {
              decoding.countDown();
              try {
                never.await();
              } catch (InterruptedException drained) {
                Thread.currentThread().interrupt();
              }
            }
            return standard.decode(json, type);
          }
        };
    List<Boolean> interrupted = new CopyOnWriteArrayList<>();
    Worker worker =
        worker()
            .concurrency(3)
            .codec(codec)
            .shutdownGrace(Duration.ZERO)
            .handleBatch(
                "lingered",
                Object.class,
                new BatchOptions(3, Duration.ofSeconds(30)),
                items -> {
                  try {
                    never.await();
                  } catch (InterruptedException drained) {
                    interrupted.add(true);
                  }
                  return items.stream()
                      .<BatchHandlerOutcome>map(item -> new BatchSucceeded("done"))
                      .toList();
                })
            .build();
    worker.start();
    assertTrue(decoding.await(WAIT.toSeconds(), TimeUnit.SECONDS), "the slow member decodes");
    Thread.sleep(200);

    closeAndWaitUntilSettled(worker, taskIds);

    assertEquals(List.of(true), interrupted, "the handler received the drain interrupt");
    assertEquals(List.of("succeeded"), fullStates(taskIds).values().stream().distinct().toList());
  }

  @Test
  void aHandlerThatAnIncompleteStopAbandonedKeepsItsSlotInTheNextRun() throws Exception {
    UUID stuck = enqueue("stuck", Map.of());
    CountDownLatch entered = new CountDownLatch(1);
    CountDownLatch release = new CountDownLatch(1);
    Worker worker =
        worker()
            .shutdownGrace(Duration.ZERO)
            .handle(
                "stuck",
                Object.class,
                (ctx, payload) -> {
                  entered.countDown();
                  while (true) {
                    try {
                      release.await();
                      return null;
                    } catch (InterruptedException ignored) {
                      // This handler ignores the drain, so the stop cannot complete.
                    }
                  }
                })
            .handle("next", Object.class, (ctx, payload) -> "next")
            .build();
    worker.start();
    assertTrue(entered.await(WAIT.toSeconds(), TimeUnit.SECONDS), "the stuck handler started");
    assertThrows(ShutdownIncompleteException.class, worker::close);
    UUID next = enqueue("next", Map.of());

    worker.start();
    try {
      Thread.sleep(500);
      assertEquals(
          "ready",
          fullStates(List.of(next)).get(next),
          "the abandoned handler still holds the only slot");
      release.countDown();
      waitUntil(
          "the next task finished",
          () -> {
            try {
              return "succeeded".equals(fullStates(List.of(next)).get(next));
            } catch (SQLException error) {
              throw new IllegalStateException(error);
            }
          });
    } finally {
      release.countDown();
      worker.close();
    }
    assertEquals("succeeded", fullStates(List.of(stuck)).get(stuck));
  }

  @Test
  void runsALingeringBatchAsSoonAsAStoppingWorkerDrains() throws SQLException {
    List<UUID> taskIds =
        List.of(
            enqueue("linger", Map.of(), EnqueueOptions.builder().maxAttempts(1)),
            enqueue("linger", Map.of(), EnqueueOptions.builder().maxAttempts(1)));
    List<Integer> calls = new CopyOnWriteArrayList<>();
    Worker worker =
        worker()
            .concurrency(3)
            .shutdownGrace(Duration.ofMillis(50))
            .handleBatch(
                "linger",
                Object.class,
                new BatchOptions(3, Duration.ofSeconds(30)),
                items -> {
                  calls.add(items.size());
                  return items.stream()
                      .<BatchHandlerOutcome>map(item -> new BatchSucceeded(null))
                      .toList();
                })
            .build();
    long started = System.nanoTime();

    assertTrue(worker.runOnce());

    assertTrue(System.nanoTime() - started < TimeUnit.SECONDS.toNanos(10));
    assertEquals(List.of(2), calls);
    assertEquals(
        Map.of(taskIds.get(0), "succeeded", taskIds.get(1), "succeeded"), fullStates(taskIds));
  }

  @Test
  void givesEachMemberItsOwnFencedCheckpointAndProgress() throws SQLException {
    List<UUID> taskIds = new ArrayList<>();
    for (int index = 0; index < 3; index++) {
      taskIds.add(
          enqueue(
              "fenced",
              Map.of("index", index),
              EnqueueOptions.builder().priority(3 - index).maxAttempts(1)));
    }
    UUID lost = taskIds.get(1);
    List<UUID> refused = new CopyOnWriteArrayList<>();
    Worker worker =
        worker()
            .concurrency(3)
            .handleBatch(
                "fenced",
                Object.class,
                new BatchOptions(3, Duration.ofSeconds(1)),
                items -> {
                  try (Connection connection = ScratchDatabase.connect();
                      PreparedStatement statement =
                          connection.prepareStatement(
                              "UPDATE workhorse.task_runtime SET fence_token = fence_token + 1"
                                  + " WHERE task_id = ?::uuid")) {
                    statement.setString(1, lost.toString());
                    statement.execute();
                  }
                  List<BatchHandlerOutcome> outcomes = new ArrayList<>();
                  for (BatchHandlerItem<Object> item : items) {
                    BatchHandlerContext context = item.context();
                    try {
                      context.setProgress(Map.of("index", index(item.payload())));
                      Object charge =
                          context.checkpoint("charge", Object.class, () -> index(item.payload()));
                      outcomes.add(new BatchSucceeded(Map.of("charge", charge)));
                    } catch (LeaseLostException error) {
                      refused.add(context.task().id());
                      outcomes.add(new BatchFailed(error));
                    }
                  }
                  return outcomes;
                })
            .build();

    assertTrue(worker.runOnce());

    assertEquals(List.of(lost), refused);
    assertEquals("succeeded", fullStates(List.of(taskIds.get(0))).get(taskIds.get(0)));
    assertEquals("succeeded", fullStates(List.of(taskIds.get(2))).get(taskIds.get(2)));
    for (int index : new int[] {0, 2}) {
      String taskId = taskIds.get(index).toString();
      assertEquals(
          List.of(Integer.toString(index)),
          column(
              "SELECT checkpoint_value::text FROM workhorse.task_checkpoint WHERE task_id = ?::uuid",
              taskId),
          "each member keeps its own checkpoint");
      assertEquals(
          List.of("{\"index\": " + index + "}"),
          column(
              "SELECT progress_value::text FROM workhorse.task_progress WHERE task_id = ?::uuid",
              taskId),
          "each member keeps its own progress");
    }
    assertEquals(
        List.of(),
        column(
            "SELECT checkpoint_name FROM workhorse.task_checkpoint WHERE task_id = ?::uuid",
            lost.toString()));
  }

  @Test
  void replaysAMemberCheckpointAfterItLandsInABatchOfDifferentComposition() throws SQLException {
    UUID retried =
        enqueue(
            "replay",
            Map.of("key", "retried"),
            EnqueueOptions.builder()
                .priority(9)
                .maxAttempts(2)
                .retryPolicy(Map.of("type", "fixed", "delayMs", 60_000)));
    enqueue("replay", Map.of("key", "first"), EnqueueOptions.builder().maxAttempts(1));
    List<String> runs = new CopyOnWriteArrayList<>();
    List<List<String>> seen = new CopyOnWriteArrayList<>();
    BatchHandler<Object> handler =
        items -> {
          seen.add(items.stream().map(item -> key(item.payload())).toList());
          List<BatchHandlerOutcome> outcomes = new ArrayList<>();
          for (BatchHandlerItem<Object> item : items) {
            BatchHandlerContext context = item.context();
            String key = key(item.payload());
            Object before = context.getCheckpoint("charge").map(TaskCheckpoint::value).orElse(null);
            Object charge =
                context.checkpoint(
                    "charge",
                    Object.class,
                    () -> {
                      runs.add(key);
                      return key + ":" + context.task().attempt();
                    });
            if (key.equals("retried") && context.task().attempt() == 1) {
              outcomes.add(new BatchFailed(new IllegalStateException("network")));
            } else {
              Map<String, @Nullable Object> result = new HashMap<>();
              result.put("before", before);
              result.put("charge", charge);
              outcomes.add(new BatchSucceeded(result));
            }
          }
          return outcomes;
        };
    // Each linger outlasts any claim round, so a batch dispatches only once it is full or the run
    // delivered every member it claimed.
    worker()
        .concurrency(2)
        .handleBatch("replay", Object.class, new BatchOptions(2, Duration.ofSeconds(60)), handler)
        .build()
        .runOnce();
    try (Connection connection = ScratchDatabase.connect()) {
      try (PreparedStatement statement =
          connection.prepareStatement(
              "UPDATE workhorse.task_runtime SET run_at = clock_timestamp() - interval '1"
                  + " millisecond' WHERE task_id = ?::uuid")) {
        statement.setString(1, retried.toString());
        statement.execute();
      }
      try (PreparedStatement statement =
          connection.prepareStatement("SELECT * FROM workhorse.tick_v1(100, 100)")) {
        statement.execute();
      }
    }
    enqueue("replay", Map.of("key", "later0"), EnqueueOptions.builder().maxAttempts(1));
    enqueue("replay", Map.of("key", "later1"), EnqueueOptions.builder().maxAttempts(1));
    worker()
        .concurrency(3)
        .handleBatch("replay", Object.class, new BatchOptions(3, Duration.ofSeconds(60)), handler)
        .build()
        .runOnce();

    assertEquals(
        List.of(List.of("retried", "first"), List.of("retried", "later0", "later1")), seen);
    assertEquals(List.of("retried", "first", "later0", "later1"), runs);
    assertEquals(
        List.of("succeeded|2|{\"before\": \"retried:1\", \"charge\": \"retried:1\"}"),
        column(
            "SELECT state || '|' || current_attempt || '|' || result::text"
                + " FROM workhorse.task_outcome WHERE task_id = ?::uuid",
            retried.toString()));
  }

  @Test
  void rejectsAFastTierMemberCheckpointAndProgressBeforeAnyWrite() throws SQLException {
    makeFast();
    List<UUID> taskIds =
        List.of(
            enqueue("fast.batch", Map.of("index", 0), EnqueueOptions.builder().maxAttempts(1)),
            enqueue("fast.batch", Map.of("index", 1), EnqueueOptions.builder().maxAttempts(1)));
    List<String> refused = new CopyOnWriteArrayList<>();
    Worker worker =
        worker()
            .concurrency(2)
            .handleBatch(
                "fast.batch",
                Object.class,
                new BatchOptions(2, Duration.ofSeconds(1)),
                items -> {
                  List<BatchHandlerOutcome> outcomes = new ArrayList<>();
                  for (BatchHandlerItem<Object> item : items) {
                    BatchHandlerContext context = item.context();
                    List<Runnable> calls =
                        List.of(
                            () ->
                                context.checkpoint(
                                    "charge",
                                    Object.class,
                                    () -> {
                                      throw new AssertionError("the checkpoint ran");
                                    }),
                            () -> context.setProgress(Map.of("done", 1)));
                    for (Runnable call : calls) {
                      FastTierUnsupportedException error =
                          assertThrows(FastTierUnsupportedException.class, call::run);
                      refused.add(error.feature());
                    }
                    outcomes.add(new BatchSucceeded(null));
                  }
                  return outcomes;
                })
            .build();

    assertTrue(worker.runOnce());

    assertEquals(
        Map.of("checkpoints", 2L, "progress", 2L),
        refused.stream()
            .collect(
                java.util.stream.Collectors.groupingBy(
                    feature -> feature, java.util.stream.Collectors.counting())));
    assertEquals(
        Map.of(taskIds.get(0), "succeeded", taskIds.get(1), "succeeded"), fastOutcomes(taskIds));
    for (UUID taskId : taskIds) {
      assertEquals(
          List.of("0"),
          column(
              "SELECT count(*) FROM workhorse.task_checkpoint WHERE task_id = ?::uuid",
              taskId.toString()));
    }
  }

  // Batch options.

  @Test
  void batchOptionsKeepTheBoundsOfEveryOtherSdk() {
    assertEquals(100, new BatchOptions(100, Duration.ofSeconds(60)).maxSize());
    assertEquals(Duration.ZERO, new BatchOptions(1, Duration.ZERO).linger());
    assertEquals(
        "maxSize must be between 1 and 100",
        assertThrows(IllegalArgumentException.class, () -> new BatchOptions(0, Duration.ZERO))
            .getMessage());
    assertThrows(IllegalArgumentException.class, () -> new BatchOptions(101, Duration.ZERO));
    assertThrows(IllegalArgumentException.class, () -> new BatchOptions(1, Duration.ofMillis(-1)));
    assertThrows(
        IllegalArgumentException.class, () -> new BatchOptions(1, Duration.ofMillis(60_001)));
    assertThrows(
        IllegalArgumentException.class, () -> new BatchOptions(1, Duration.ofNanos(1_500_000)));
    IllegalArgumentException tooLarge =
        assertThrows(
            IllegalArgumentException.class,
            () ->
                worker()
                    .concurrency(2)
                    .handleBatch(
                        "big", Object.class, new BatchOptions(3, Duration.ZERO), items -> List.of())
                    .build());
    assertEquals("maxSize must not exceed worker concurrency", tooLarge.getMessage());
    assertInstanceOf(
        NullPointerException.class,
        assertThrows(RuntimeException.class, () -> new BatchFailed(null)));
    assertFalse(new BatchSucceeded(null).equals(new BatchSucceeded(1)));
  }

  private static String key(@Nullable Object payload) {
    return String.valueOf(((Map<?, ?>) payload).get("key"));
  }
}
