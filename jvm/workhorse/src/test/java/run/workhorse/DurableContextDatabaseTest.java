package run.workhorse;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertInstanceOf;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;
import org.jspecify.annotations.Nullable;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.extension.ExtendWith;
import run.workhorse.internal.Json;
import run.workhorse.internal.SqlCatalogue;
import run.workhorse.testing.ScratchDataSource;
import run.workhorse.testing.ScratchDatabase;

/**
 * The durable handler context against PostgreSQL: one or more tests for each durable context row of
 * {@code docs/parity.md}. Each test drives the worker with {@link Worker#runOnce}, so every wait is
 * bounded.
 */
@ExtendWith(ScratchDatabase.class)
@Timeout(value = 120, unit = TimeUnit.SECONDS)
class DurableContextDatabaseTest {
  private static final String STATE =
      "SELECT COALESCE(o.state, r.state) AS state,"
          + " COALESCE(o.current_attempt, r.current_attempt) AS attempt,"
          + " o.result::text AS result, COALESCE(o.error, r.error)::text AS error"
          + " FROM workhorse.task t"
          + " LEFT JOIN workhorse.task_runtime r ON r.task_id = t.id"
          + " LEFT JOIN workhorse.task_outcome o ON o.task_id = t.id"
          + " WHERE t.id = ?::uuid";

  private final ScratchDataSource dataSource = new ScratchDataSource(true);
  private final Queue queue = new Queue(ConnectionSource.of(dataSource));
  private String queueName = "";

  @BeforeEach
  void name() {
    queueName = "jvm-durable-" + UUID.randomUUID();
  }

  private Worker.Builder worker() {
    return worker("jvm-durable-worker");
  }

  private Worker.Builder worker(String workerId) {
    return Worker.builder(dataSource)
        .queues(queueName)
        .workerId(workerId)
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

  private record State(
      String state,
      int attempt,
      @Nullable Object result,
      @Nullable Map<String, @Nullable Object> error) {}

  private static State state(UUID taskId) throws SQLException {
    try (Connection connection = ScratchDatabase.connect();
        PreparedStatement statement = connection.prepareStatement(STATE)) {
      statement.setString(1, taskId.toString());
      try (ResultSet result = statement.executeQuery()) {
        assertTrue(result.next(), "the task exists");
        String text = result.getString("result");
        String error = result.getString("error");
        return new State(
            result.getString("state"),
            result.getInt("attempt"),
            text == null ? null : Json.parse(text),
            error == null ? null : Json.object(Json.parse(error)));
      }
    }
  }

  private static void execute(String sql, @Nullable String parameter) throws SQLException {
    try (Connection connection = ScratchDatabase.connect();
        PreparedStatement statement = connection.prepareStatement(sql)) {
      if (parameter != null) {
        statement.setString(1, parameter);
      }
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

  /**
   * Wakes a task that a durable timer suspended. The timer is long enough that it cannot elapse on
   * a slow runner, so the test rewinds it and promotes it, as the shared runtime fixture does.
   */
  private static void wake(UUID taskId) throws SQLException {
    execute(
        "UPDATE workhorse.task_runtime SET run_at = clock_timestamp() - interval '1 millisecond'"
            + " WHERE task_id = ?::uuid",
        taskId.toString());
    execute("SELECT * FROM workhorse.tick_v1(100, 100)", null);
  }

  /** Runs passes of {@code worker} until {@code taskId} reaches {@code expected}. */
  private static State drive(Worker worker, UUID taskId, String expected) throws SQLException {
    for (int pass = 0; pass < 20; pass++) {
      State current = state(taskId);
      if (current.state.equals(expected)) {
        return current;
      }
      execute("SELECT * FROM workhorse.tick_v1(100, 100)", null);
      worker.runOnce();
    }
    State last = state(taskId);
    assertEquals(expected, last.state, "the task did not reach " + expected + ": " + last.error);
    return last;
  }

  private static Map<String, @Nullable Object> object(@Nullable Object... members) {
    Map<String, @Nullable Object> object = new LinkedHashMap<>();
    for (int index = 0; index < members.length; index += 2) {
      object.put((String) members[index], members[index + 1]);
    }
    return object;
  }

  // Checkpoints and suspension.

  @Test
  void suspendsATaskAndResumesItOnASecondWorkerThatReadsTheCheckpoint() throws SQLException {
    UUID taskId = enqueue("prepare-then-wait", null);
    AtomicInteger operations = new AtomicInteger();
    AtomicReference<@Nullable TaskCheckpoint> seen = new AtomicReference<>();
    Handler<@Nullable Object> handler =
        (ctx, payload) -> {
          seen.set(ctx.getCheckpoint("prepare").orElse(null));
          Map<?, ?> prepared =
              ctx.checkpoint(
                  "prepare", Map.class, () -> object("operation", operations.incrementAndGet()));
          ctx.sleep("after-prepare", Duration.ofSeconds(30));
          return object("prepared", prepared);
        };

    Worker first =
        worker("jvm-durable-first").handle("prepare-then-wait", Object.class, handler).build();
    assertTrue(first.runOnce());
    State suspended = state(taskId);
    assertEquals("scheduled", suspended.state);
    assertNull(seen.get(), "the first attempt read no checkpoint");
    assertEquals(
        0,
        count(
            "SELECT count(*) FROM workhorse.attempt_history WHERE task_id = ?::uuid",
            taskId.toString()),
        "a suspension charges no attempt");

    wake(taskId);
    Worker second =
        worker("jvm-durable-second").handle("prepare-then-wait", Object.class, handler).build();
    State done = drive(second, taskId, "succeeded");
    assertEquals(1, done.attempt, "the resume runs the same attempt");
    assertEquals(object("prepared", object("operation", 1L)), done.result);
    assertEquals(1, operations.get(), "the checkpoint operation ran once");
    TaskCheckpoint checkpoint = seen.get();
    assertNotNull(checkpoint, "the second worker read the checkpoint");
    assertEquals("jvm-durable-first", checkpoint.workerId());
    assertEquals(object("operation", 1L), checkpoint.value());
    assertNull(checkpoint.inputFingerprint());
  }

  @Test
  void replaysACheckpointAndANullValueOnTheNextAttempt() throws SQLException {
    UUID taskId =
        enqueue(
            "checkpoint-retry",
            null,
            EnqueueOptions.builder()
                .maxAttempts(2)
                .retryPolicy(Map.of("type", "fixed", "delayMs", 0)));
    AtomicInteger operations = new AtomicInteger();
    Worker worker =
        worker()
            .handle(
                "checkpoint-retry",
                Object.class,
                (ctx, payload) -> {
                  Object empty =
                      ctx.checkpoint(
                          "empty",
                          Object.class,
                          () -> {
                            operations.incrementAndGet();
                            return null;
                          });
                  Long count =
                      ctx.checkpoint(
                          "count", Long.class, () -> (long) operations.incrementAndGet());
                  if (ctx.task().attempt() == 1) {
                    throw new IllegalStateException("first attempt fails after its checkpoints");
                  }
                  return object("empty", empty, "count", count);
                })
            .build();
    State done = drive(worker, taskId, "succeeded");
    assertEquals(2, done.attempt);
    assertEquals(object("empty", null, "count", 2L), done.result);
    assertEquals(2, operations.get(), "each operation ran in the first attempt only");
  }

  @Test
  void concurrentCallsWithOneNameShareOneOperation() throws SQLException {
    UUID taskId = enqueue("concurrent-checkpoint", null);
    AtomicInteger operations = new AtomicInteger();
    Worker worker =
        worker()
            .handle(
                "concurrent-checkpoint",
                Object.class,
                (ctx, payload) -> {
                  AtomicReference<@Nullable Object> other = new AtomicReference<>();
                  Thread second =
                      Thread.ofVirtual()
                          .unstarted(
                              () ->
                                  other.set(
                                      ctx.checkpoint(
                                          "shared",
                                          Long.class,
                                          () -> (long) operations.incrementAndGet())));
                  Long mine =
                      ctx.checkpoint(
                          "shared",
                          Long.class,
                          () -> {
                            // The second call starts while this operation runs, and waits for it.
                            second.start();
                            while (second.isAlive() && second.getState() != Thread.State.WAITING) {
                              Thread.sleep(1);
                            }
                            return (long) operations.incrementAndGet();
                          });
                  second.join();
                  return List.of(mine, other.get());
                })
            .build();
    assertTrue(worker.runOnce());
    assertEquals(List.of(1L, 1L), state(taskId).result);
    assertEquals(1, operations.get());
  }

  @Test
  void aDifferentCheckpointInputFailsTheTaskWithoutRunningTheOperation() throws SQLException {
    UUID taskId =
        enqueue(
            "checkpoint-input",
            null,
            EnqueueOptions.builder()
                .maxAttempts(3)
                .retryPolicy(Map.of("type", "fixed", "delayMs", 0)));
    AtomicInteger operations = new AtomicInteger();
    Worker worker =
        worker()
            .handle(
                "checkpoint-input",
                Object.class,
                (ctx, payload) -> {
                  // The first two attempts give the same input, and the third another one.
                  long cents = ctx.task().attempt() < 3 ? 1000 : 900;
                  ctx.checkpoint(
                      "charge-card",
                      Object.class,
                      CheckpointOptions.input(object("amountCents", cents)),
                      () -> object("chargedCents", operations.incrementAndGet()));
                  throw new IllegalStateException("attempt " + ctx.task().attempt() + " fails");
                })
            .build();
    State failed = drive(worker, taskId, "failed");
    assertEquals(3, failed.attempt);
    assertNotNull(failed.error);
    assertEquals("CheckpointInputConflictException", failed.error.get("name"));
    assertEquals(1, operations.get(), "only the first attempt ran the operation");
    List<TaskCheckpoint> stored = new ArrayList<>();
    try (Connection connection = ScratchDatabase.connect()) {
      for (var row :
          run.workhorse.internal.Sql.rows(
              connection, SqlCatalogue.LIST_CHECKPOINTS, taskId.toString())) {
        stored.add(
            new TaskCheckpoint(
                taskId,
                row.requiredText("checkpoint_name"),
                row.json("checkpoint_value"),
                row.requiredInteger("attempt"),
                row.requiredLong("fence_token"),
                row.requiredText("worker_id"),
                row.requiredInstant("created_at"),
                row.text("input_fingerprint")));
      }
    }
    assertEquals(1, stored.size());
    assertEquals(
        Checkpoints.inputFingerprint(object("amountCents", 1000L)),
        stored.get(0).inputFingerprint());
  }

  @Test
  void aHandlerThatCatchesTheSuspensionStillSuspends() throws SQLException {
    UUID taskId = enqueue("swallowing", null);
    AtomicReference<@Nullable Throwable> caught = new AtomicReference<>();
    Worker worker =
        worker()
            .handle(
                "swallowing",
                Object.class,
                (ctx, payload) -> {
                  try {
                    ctx.sleep("nap", Duration.ofSeconds(30));
                  } catch (Throwable error) {
                    caught.set(error);
                  }
                  assertThrows(CancelledException.class, () -> ctx.setProgress(1));
                  return "ignored";
                })
            .build();
    assertTrue(worker.runOnce());
    assertEquals("scheduled", state(taskId).state);
    assertInstanceOf(Error.class, caught.get());
  }

  /** A logger that throws an {@link AssertionError} for one event. */
  private static final class FailingLogger implements System.Logger {
    private final String event;

    FailingLogger(String event) {
      this.event = event;
    }

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
        java.util.@Nullable ResourceBundle bundle,
        @Nullable String message,
        @Nullable Throwable thrown) {
      if (message != null && message.contains("event.name=" + event)) {
        throw new AssertionError("the logger fails");
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

  @Test
  void aLoggerErrorAfterTheReleaseStillSuspendsTheTask() throws SQLException {
    // A JVM regression test from review round 2 of SM-1387: the release of a durable write must
    // suspend the handler even when the bookkeeping after it throws an Error.
    UUID taskId = enqueue("failing-log", null);
    AtomicReference<@Nullable CancellationReason> reason = new AtomicReference<>();
    Worker worker =
        worker()
            .logger(new FailingLogger("workhorse.task.wait_processed"))
            .handle(
                "failing-log",
                Object.class,
                (ctx, payload) -> {
                  try {
                    ctx.sleep("nap", Duration.ofSeconds(30));
                  } finally {
                    reason.set(ctx.cancellation().reason());
                  }
                  return "not reached";
                })
            .build();
    assertTrue(worker.runOnce());
    assertEquals("scheduled", state(taskId).state);
    assertEquals(CancellationReason.SUSPENDED, reason.get());
  }

  @Test
  void anInvalidNameThrowsBeforeAnyStatement() throws SQLException {
    UUID taskId = enqueue("invalid-names", null);
    List<Class<?>> thrown = new CopyOnWriteArrayList<>();
    Worker worker =
        worker()
            .handle(
                "invalid-names",
                Object.class,
                (ctx, payload) -> {
                  String tooLong = "x".repeat(201);
                  List<Runnable> calls =
                      List.of(
                          () -> ctx.checkpoint("", Object.class, () -> 1),
                          () -> ctx.checkpoint(tooLong, Object.class, () -> 1),
                          () -> ctx.sleep("", Duration.ofSeconds(1)),
                          () -> ctx.sleep("nap", Duration.ZERO),
                          () -> ctx.sleepUntil("nap", Instant.now().plus(Duration.ofDays(366))),
                          () -> ctx.waitForSignal(" padded", Object.class, null),
                          () -> ctx.waitForSignal("approved", Object.class, Duration.ofDays(8)),
                          () -> ctx.waitForHuman("review ", null, Object.class, null),
                          () ->
                              ctx.runChild(
                                  "", "child", null, EnqueueOptions.defaults(), Object.class),
                          () ->
                              ctx.runChildren(
                                  List.of(
                                      ChildRequest.of("same", "child", null),
                                      ChildRequest.of("same", "child", null))));
                  for (Runnable call : calls) {
                    try {
                      call.run();
                    } catch (IllegalArgumentException expected) {
                      thrown.add(expected.getClass());
                    }
                  }
                  return null;
                })
            .build();
    assertTrue(worker.runOnce());
    assertEquals(10, thrown.size());
    assertEquals("succeeded", state(taskId).state);
    assertEquals(
        0,
        count(
            "SELECT count(*) FROM workhorse.task_wait WHERE task_id = ?::uuid", taskId.toString()));
  }

  // Durable timers.

  @Test
  void aTimerThatElapsedReturnsAtOnce() throws SQLException {
    UUID taskId = enqueue("past-timer", null);
    Worker worker =
        worker()
            .handle(
                "past-timer",
                Object.class,
                (ctx, payload) -> {
                  ctx.sleepUntil("past", Instant.now().minusSeconds(1));
                  return "woke";
                })
            .build();
    assertTrue(worker.runOnce());
    State done = state(taskId);
    assertEquals("succeeded", done.state);
    assertEquals("woke", done.result);
  }

  @Test
  void anAbsoluteTimerSuspendsUntilItsTimeAndThenReturns() throws SQLException {
    UUID taskId = enqueue("future-timer", null);
    Instant wakeAt = Instant.now().plusSeconds(60);
    AtomicInteger runs = new AtomicInteger();
    Worker worker =
        worker()
            .handle(
                "future-timer",
                Object.class,
                (ctx, payload) -> {
                  runs.incrementAndGet();
                  ctx.sleepUntil("later", wakeAt);
                  return runs.get();
                })
            .build();
    assertTrue(worker.runOnce());
    assertEquals("scheduled", state(taskId).state);
    wake(taskId);
    assertEquals(2L, drive(worker, taskId, "succeeded").result);
  }

  // Signal and human-decision waits.

  @Test
  void aSignalWaitSuspendsAndReturnsTheDeliveredPayload() throws SQLException {
    UUID taskId = enqueue("await-signal", null);
    Worker worker =
        worker()
            .handle(
                "await-signal",
                Object.class,
                (ctx, payload) ->
                    object("signal", ctx.waitForSignal("approved", Map.class, Duration.ofHours(1))))
            .build();
    assertTrue(worker.runOnce());
    assertFalse(state(taskId).state.equals("succeeded"));
    queue.sendSignal(taskId, "approved", object("by", "ops"), "signal-1", "test");
    State done = drive(worker, taskId, "succeeded");
    assertEquals(object("signal", object("by", "ops")), done.result);
    assertEquals(1, done.attempt);
  }

  @Test
  void aHumanWaitSuspendsAndReturnsTheRecordedDecision() throws SQLException {
    UUID taskId = enqueue("await-human", null);
    Worker worker =
        worker()
            .handle(
                "await-human",
                Object.class,
                (ctx, payload) ->
                    ctx.waitForHuman(
                        "review", object("z", 1L, "a", "refund"), Map.class, Duration.ofHours(1)))
            .build();
    assertTrue(worker.runOnce());
    assertFalse(state(taskId).state.equals("succeeded"));
    queue.completeHumanWait(taskId, "review", object("approved", true), "decision-1", "reviewer");
    assertEquals(object("approved", true), drive(worker, taskId, "succeeded").result);
  }

  // Linked children.

  @Test
  void runChildCreatesTheChildAndReturnsItsResult() throws SQLException {
    UUID parentId = enqueue("parent", object("amount", 7L));
    AtomicInteger parentRuns = new AtomicInteger();
    Worker worker =
        worker()
            .handle(
                "parent",
                Map.class,
                (ctx, payload) -> {
                  parentRuns.incrementAndGet();
                  return object(
                      "child",
                      ctx.runChild(
                          "double", "double", payload, EnqueueOptions.defaults(), Map.class));
                })
            .handle(
                "double",
                Map.class,
                (ctx, payload) -> object("amount", ((Long) payload.get("amount")) * 2))
            .build();
    State done = drive(worker, parentId, "succeeded");
    assertEquals(object("child", object("amount", 14L)), done.result);
    assertEquals(2, parentRuns.get(), "the join suspended the parent, and the parent ran again");
    assertEquals(1, done.attempt);
    assertEquals(
        1,
        count(
            "SELECT count(*) FROM workhorse.task_child edge JOIN workhorse.task child"
                + " ON child.id = edge.child_task_id WHERE edge.parent_task_id = ?::uuid"
                + " AND child.queue_name = '"
                + queueName
                + "'",
            parentId.toString()),
        "the child runs on the queue of its parent");
  }

  @Test
  void runChildrenReturnsEachOutcomeByName() throws SQLException {
    UUID parentId = enqueue("fan-out", null);
    Worker worker =
        worker()
            .handle(
                "fan-out",
                Object.class,
                (ctx, payload) -> {
                  Map<String, ChildOutcome> outcomes =
                      ctx.runChildren(
                          List.of(
                              ChildRequest.of("good", "child-ok", 1L),
                              ChildRequest.of(
                                  "bad",
                                  "child-fails",
                                  2L,
                                  EnqueueOptions.builder().maxAttempts(1).build())));
                  ChildOutcome good = outcomes.get("good");
                  ChildOutcome bad = outcomes.get("bad");
                  return object(
                      "good", good.status().name(),
                      "goodResult", good.result(),
                      "bad", bad.status().name(),
                      "badError", Json.object(bad.error()).get("name"));
                })
            .handle("child-ok", Long.class, (ctx, payload) -> payload * 10)
            .handle(
                "child-fails",
                Object.class,
                (ctx, payload) -> {
                  throw new IllegalStateException("child fails");
                })
            .build();
    State done = drive(worker, parentId, "succeeded");
    assertEquals(
        object(
            "good", "SUCCEEDED",
            "goodResult", 10L,
            "bad", "FAILED",
            "badError", "IllegalStateException"),
        done.result);
  }

  @Test
  void runChildrenAllReturnsEachResultByName() throws SQLException {
    UUID parentId = enqueue("fan-out-all", null);
    Worker worker =
        worker()
            .handle(
                "fan-out-all",
                Object.class,
                (ctx, payload) ->
                    ctx.runChildrenAll(
                        List.of(
                            ChildRequest.of("one", "child-ok", 1L),
                            ChildRequest.of("two", "child-ok", 2L))))
            .handle("child-ok", Long.class, (ctx, payload) -> payload * 10)
            .build();
    assertEquals(object("one", 10L, "two", 20L), drive(worker, parentId, "succeeded").result);
  }

  @Test
  void durableReplayConflictsAreTerminal() throws SQLException {
    // The cases of the shared runtime fixture durable-replay-conflicts-are-terminal in
    // protocol/v1/runtime.json. The handler throws the error each case names; a conflict ends the
    // task, and another error retries it.
    record Case(String kind, String expectedState, int expectedAttempt, String expectedName) {}
    List<Case> cases =
        List.of(
            new Case("checkpoint", "failed", 1, "ConflictException"),
            new Case("wait", "failed", 1, "ConflictException"),
            new Case("child", "failed", 1, "ConflictException"),
            new Case("child-set", "failed", 1, "ConflictException"),
            new Case("human", "failed", 1, "ConflictException"),
            new Case("child-limit", "scheduled", 2, "LimitExceededException"),
            new Case("signal-wait", "scheduled", 2, "AlreadyWaitingException"),
            new Case("transient", "scheduled", 2, "Exception"),
            new Case("redacted-child", "failed", 1, "RedactedTaskError"));
    Map<String, String> operations =
        Map.of(
            "checkpoint", "checkpoint",
            "wait", "sleep",
            "child", "runChild",
            "child-set", "runChildren",
            "redacted-child", "runChild",
            "human", "waitForHuman");
    for (Case entry : cases) {
      queueName = "jvm-durable-conflict-" + entry.kind + "-" + UUID.randomUUID();
      UUID taskId =
          enqueue("protocol.replay-conflict", null, EnqueueOptions.builder().maxAttempts(5));
      if (entry.kind.equals("redacted-child")) {
        execute(
            "UPDATE workhorse.task SET payload_redact_keys = ARRAY['secret'] WHERE id = ?::uuid",
            taskId.toString());
      }
      AtomicInteger delays = new AtomicInteger();
      Worker worker =
          worker()
              .retryDelay(
                  (attempt, task) -> {
                    delays.incrementAndGet();
                    return Duration.ofSeconds(60);
                  })
              .handle(
                  "protocol.replay-conflict",
                  Object.class,
                  (ctx, payload) -> {
                    switch (entry.kind) {
                      case "child-limit" -> throw new LimitExceededException("runChild", "saved");
                      case "signal-wait" ->
                          throw new AlreadyWaitingException("waitForSignal", "saved");
                      case "transient" -> throw new Exception("transient");
                      default -> throw new ConflictException(operations.get(entry.kind), "saved");
                    }
                  })
              .build();
      assertTrue(worker.runOnce(), entry.kind);
      State after = state(taskId);
      assertEquals(entry.expectedState, after.state, entry.kind);
      assertEquals(entry.expectedAttempt, after.attempt, entry.kind);
      assertNotNull(after.error, entry.kind);
      assertEquals(entry.expectedName, after.error.get("name"), entry.kind);
      assertEquals(entry.expectedState.equals("failed") ? 0 : 1, delays.get(), entry.kind);
    }
  }

  // Task groups.

  @Test
  void aMemberTaskReadsItsGroupAndAddsATaskToIt() throws SQLException {
    TaskGroupBlockResult block =
        queue.taskGroup(
            TaskGroupCallbacks.none(),
            builder ->
                builder.enqueue("member", null, EnqueueOptions.builder().queue(queueName).build()));
    UUID memberId = block.tasks().get(0).taskId();
    AtomicReference<@Nullable TaskGroupLink> link = new AtomicReference<>();
    AtomicReference<@Nullable UUID> added = new AtomicReference<>();
    Worker worker =
        worker()
            .handle(
                "member",
                Object.class,
                (ctx, payload) -> {
                  link.set(ctx.taskGroup().get().orElse(null));
                  if (ctx.task().id().equals(memberId)) {
                    added.set(
                        ctx.taskGroup()
                            .add(List.of(EnqueueRequest.of("member", null)))
                            .get(0)
                            .taskId());
                  }
                  return null;
                })
            .build();
    drive(worker, memberId, "succeeded");
    TaskGroupLink seen = link.get();
    assertNotNull(seen);
    assertEquals(TaskGroupRole.MEMBER, seen.role());
    assertNull(seen.callback());
    assertEquals(block.group().id(), seen.group().id());
    UUID addedId = added.get();
    assertNotNull(addedId);
    drive(worker, addedId, "succeeded");
    assertEquals(
        2,
        queue.listTaskGroupMembers(block.group().id()).members().size(),
        "the added task joined the group on the member's queue");
  }

  @Test
  void aTaskWithNoGroupReadsNoneAndCannotAdd() throws SQLException {
    UUID taskId = enqueue("ungrouped", null);
    AtomicReference<@Nullable Throwable> refused = new AtomicReference<>();
    AtomicReference<Boolean> present = new AtomicReference<>(true);
    Worker worker =
        worker()
            .handle(
                "ungrouped",
                Object.class,
                (ctx, payload) -> {
                  present.set(ctx.taskGroup().get().isPresent());
                  try {
                    ctx.taskGroup().add(List.of(EnqueueRequest.of("ungrouped", null)));
                  } catch (IllegalArgumentException error) {
                    refused.set(error);
                  }
                  return null;
                })
            .build();
    assertTrue(worker.runOnce());
    assertEquals("succeeded", state(taskId).state);
    assertFalse(present.get());
    assertInstanceOf(IllegalArgumentException.class, refused.get());
  }

  // Progress.

  @Test
  void setProgressStoresTheLatestValueAndANewAttemptReadsIt() throws SQLException {
    UUID taskId =
        enqueue(
            "progress",
            null,
            EnqueueOptions.builder()
                .maxAttempts(2)
                .retryPolicy(Map.of("type", "fixed", "delayMs", 0)));
    List<@Nullable Object> reads = new CopyOnWriteArrayList<>();
    Worker worker =
        worker()
            .handle(
                "progress",
                Object.class,
                (ctx, payload) -> {
                  reads.add(ctx.getProgress().map(TaskProgress::value).orElse(null));
                  if (ctx.task().attempt() == 1) {
                    TaskProgress first = ctx.setProgress(object("done", 1L));
                    assertEquals(object("done", 1L), first.value());
                    assertEquals(first, ctx.getProgress().orElseThrow());
                    throw new IllegalStateException("retry");
                  }
                  return ctx.getProgress().orElseThrow().revision();
                })
            .build();
    State done = drive(worker, taskId, "succeeded");
    assertEquals(java.util.Arrays.asList(null, object("done", 1L)), reads);
    assertEquals(1L, done.result);
  }

  // The fast tier.

  @Test
  void aFastTierTaskRefusesEachDurableCallBeforeAnyWrite() throws SQLException {
    try (Connection connection = ScratchDatabase.connect()) {
      run.workhorse.internal.Sql.rows(
          connection, SqlCatalogue.SET_QUEUE_TIER_V1, queueName, "fast", "operator", "test");
    }
    UUID taskId = enqueue("fast", null);
    List<String> features = new CopyOnWriteArrayList<>();
    Worker worker =
        worker()
            .handle(
                "fast",
                Object.class,
                (ctx, payload) -> {
                  List<Runnable> calls =
                      List.of(
                          () -> ctx.checkpoint("step", Object.class, () -> 1),
                          () -> ctx.setProgress(1),
                          () -> ctx.sleep("nap", Duration.ofSeconds(1)),
                          () -> ctx.waitForSignal("approved", Object.class, null));
                  for (Runnable call : calls) {
                    try {
                      call.run();
                    } catch (FastTierUnsupportedException refused) {
                      features.add(refused.feature());
                    }
                  }
                  return null;
                })
            .build();
    assertTrue(worker.runOnce());
    assertEquals(List.of("checkpoints", "progress", "durable waits", "signal waits"), features);
    assertEquals(
        0,
        count(
            "SELECT count(*) FROM workhorse.task_checkpoint WHERE task_id = ?::uuid",
            taskId.toString()));
  }
}
