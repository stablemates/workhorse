package run.workhorse.conformance;

import static run.workhorse.conformance.Failure.check;

import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.time.Duration;
import java.time.Instant;
import java.time.OffsetDateTime;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import org.jspecify.annotations.Nullable;
import run.workhorse.CheckpointOptions;
import run.workhorse.ChildOutcome;
import run.workhorse.ChildRequest;
import run.workhorse.ChildStatus;
import run.workhorse.EnqueueOptions;
import run.workhorse.Handler;
import run.workhorse.HandlerContext;
import run.workhorse.Queue;
import run.workhorse.Worker;
import run.workhorse.internal.Json;

/**
 * Runs the {@code durable-script} fixtures of {@code protocol/v1/runtime.json} (SM-1950).
 *
 * <p>A handler runs the fixture's script through its handler context, and the runner drives the
 * task through the fixture's steps. {@code protocol/README.md} describes the operations and the
 * steps. The phase {@code suspend} runs the steps before {@code handOff}, and {@code replay} runs
 * the steps after it, so two SDKs can share one task. {@code all} runs every step and resets the
 * counters at {@code handOff}.
 */
final class DurableScript {
  /**
   * A bound on the claims of one run step, so a defect cannot loop for ever. The {@code runOnce} of
   * each SDK can claim more than one task, so a step names the work that ends, not a count of
   * claims.
   */
  private static final int MAXIMUM_DRAIN_PASSES = 20;

  private final Connections.Opener opener;
  private final Connection connection;
  private final AtomicInteger handlerRuns = new AtomicInteger();
  private final AtomicInteger checkpointOperations = new AtomicInteger();
  private final AtomicInteger caughtSuspensions = new AtomicInteger();

  /** Handler runs that reached the end of the script. A run that suspends never does. */
  private final AtomicInteger completedScripts = new AtomicInteger();

  /** Timer, wait, and child calls that returned. A call that suspends never returns. */
  private final AtomicInteger returnedSuspendingCalls = new AtomicInteger();

  /** The operations that can suspend the task. */
  private static final java.util.Set<String> SUSPENDING =
      java.util.Set.of("sleep", "sleepUntil", "waitForSignal", "waitForHuman", "runChild");

  DurableScript(Connections.Opener opener, Connection connection) {
    this.opener = opener;
    this.connection = connection;
  }

  void run(Map<String, @Nullable Object> fixture, String phase) throws Exception {
    String id = String.valueOf(fixture.get("id"));
    List<Map<String, @Nullable Object>> steps = steps(fixture, phase);
    String taskType = String.valueOf(fixture.get("taskType"));
    UUID taskId = prepareTask(fixture, phase, taskType);
    try (Intercept taskPool = new Intercept(opener, new Intercept.Hook() {});
        Intercept childPool = new Intercept(opener, new Intercept.Hook() {})) {
      Handler<Object> handler = (context, payload) -> runScript(fixture, payload, context);
      Map<String, Worker> workers = new LinkedHashMap<>();
      workers.put(
          "task",
          worker(taskPool, "runtime-" + id, "jvm-" + id)
              .handle(taskType, Object.class, handler)
              .build());
      if (fixture.get("childQueue") instanceof String childQueue) {
        Handler<Object> child = (context, payload) -> Map.of("echo", payload);
        workers.put(
            "child",
            worker(childPool, childQueue, "jvm-" + id + "-children")
                .handle(String.valueOf(fixture.get("childTaskType")), Object.class, child)
                .build());
      }
      for (int index = 0; index < steps.size(); index++) {
        Map<String, @Nullable Object> step = steps.get(index);
        String action = String.valueOf(step.get("action"));
        String where = id + " step " + (index + 1) + " (" + action + ")";
        switch (action) {
          case "run" -> {
            Object name = step.get("worker");
            Worker selected = workers.get(name == null ? "task" : String.valueOf(name));
            check(selected != null, where + ": the fixture has no " + name + " worker");
            drain(Objects.requireNonNull(selected), where);
          }
          case "sql" -> {
            synchronized (connection) {
              try (PreparedStatement statement =
                  connection.prepareStatement(bind(String.valueOf(step.get("sql"))))) {
                statement.setObject(1, taskId);
                statement.execute();
              }
            }
          }
          case "handOff" -> {
            handlerRuns.set(0);
            checkpointOperations.set(0);
            caughtSuspensions.set(0);
            completedScripts.set(0);
            returnedSuspendingCalls.set(0);
          }
          case "expect" -> expectObserved(fixture, taskId, step, where);
          default -> throw new Failure(where + ": unknown action");
        }
      }
    }
  }

  private static Worker.Builder worker(Intercept pool, String queue, String workerId) {
    return Worker.builder(pool)
        .queues(queue)
        .workerId(workerId)
        .concurrency(1)
        .pollingOnly(true)
        .disableRegistry(true)
        .pollInterval(Duration.ofMillis(5));
  }

  @SuppressWarnings("unchecked")
  private static List<Map<String, @Nullable Object>> steps(
      Map<String, @Nullable Object> fixture, String phase) {
    List<Map<String, @Nullable Object>> steps =
        (List<Map<String, @Nullable Object>>) Objects.requireNonNull(fixture.get("steps"));
    if (phase.equals("all")) {
      return steps;
    }
    int handOff = -1;
    for (int index = 0; index < steps.size(); index++) {
      if ("handOff".equals(steps.get(index).get("action"))) {
        handOff = index;
      }
    }
    check(handOff >= 0, fixture.get("id") + " has no handOff step for the " + phase + " phase");
    return switch (phase) {
      case "suspend" -> steps.subList(0, handOff);
      case "replay" -> steps.subList(handOff + 1, steps.size());
      default -> throw new Failure("unknown phase " + phase);
    };
  }

  /** pgjdbc binds {@code ?}, and each fixture statement names the task as {@code $1}. */
  private static String bind(String sql) {
    return sql.replace("$1", "?");
  }

  private UUID prepareTask(Map<String, @Nullable Object> fixture, String phase, String taskType)
      throws Exception {
    synchronized (connection) {
      if (phase.equals("replay")) {
        try (PreparedStatement statement =
            connection.prepareStatement("SELECT id FROM workhorse.task WHERE task_type = ?")) {
          statement.setString(1, taskType);
          try (ResultSet rows = statement.executeQuery()) {
            check(rows.next(), "no " + taskType + " task");
            UUID id = rows.getObject(1, UUID.class);
            check(!rows.next(), "more than one " + taskType + " task");
            return id;
          }
        }
      }
      @Nullable Object payload = Map.of();
      if (fixture.get("payloadSql") instanceof String payloadSql) {
        try (PreparedStatement statement = connection.prepareStatement(payloadSql);
            ResultSet rows = statement.executeQuery()) {
          check(rows.next(), "payloadSql returned no row");
          payload = Json.parse(rows.getString(1));
        }
      }
      Queue queue = new Queue(Connections.borrowed(connection));
      return queue
          .enqueue(
              taskType,
              payload,
              EnqueueOptions.builder().queue("runtime-" + fixture.get("id")).build())
          .taskId();
    }
  }

  private static void drain(Worker worker, String where) {
    check(worker.runOnce(), where + ": the worker claimed no task");
    for (int pass = 0; pass < MAXIMUM_DRAIN_PASSES; pass++) {
      if (!worker.runOnce()) {
        return;
      }
    }
    throw new Failure(where + ": the queue did not drain");
  }

  private void expectObserved(
      Map<String, @Nullable Object> fixture,
      UUID taskId,
      Map<String, @Nullable Object> step,
      String where)
      throws Exception {
    String text;
    synchronized (connection) {
      try (PreparedStatement statement =
          connection.prepareStatement(bind(String.valueOf(fixture.get("observe"))))) {
        statement.setObject(1, taskId);
        try (ResultSet rows = statement.executeQuery()) {
          check(rows.next(), where + ": the observe query returned no row");
          text = rows.getString(1);
        }
      }
    }
    Object observed = Json.parse(text);
    Object expectedObserved = step.get("observed");
    // The runner puts the error name of its SDK into the observed value it expects.
    if (step.get("errorNames") instanceof Map<?, ?> names) {
      check(
          expectedObserved instanceof Map<?, ?> && names.get("java") instanceof String,
          where + ": errorNames needs an observed object and a name for java");
      Map<Object, Object> named = new LinkedHashMap<>((Map<?, ?>) expectedObserved);
      named.put("errorName", names.get("java"));
      expectedObserved = named;
    }
    check(
        Matcher.same(observed, expectedObserved),
        where
            + ": observed "
            + Matcher.render(observed)
            + ", expected "
            + Matcher.render(expectedObserved));
    for (Map.Entry<String, AtomicInteger> counter :
        Map.of(
                "handlerRuns", handlerRuns,
                "checkpointOperations", checkpointOperations,
                "caughtSuspensions", caughtSuspensions,
                "completedScripts", completedScripts,
                "returnedSuspendingCalls", returnedSuspendingCalls)
            .entrySet()) {
      Object expected = step.get(counter.getKey());
      long actual = counter.getValue().get();
      check(
          expected == null || Matcher.same(actual, expected),
          where + ": " + counter.getKey() + " is " + actual + ", expected " + expected);
    }
  }

  @SuppressWarnings("unchecked")
  private Object runScript(
      Map<String, @Nullable Object> fixture, @Nullable Object payload, HandlerContext context)
      throws Exception {
    handlerRuns.incrementAndGet();
    Map<String, @Nullable Object> result = new LinkedHashMap<>();
    for (Object entry : (List<Object>) Objects.requireNonNull(fixture.get("script"))) {
      Map<String, @Nullable Object> operation = (Map<String, @Nullable Object>) entry;
      String key = operation.get("key") instanceof String text ? text : null;
      if ("catchSuspension".equals(operation.get("op"))) {
        try {
          runOperation(
              fixture,
              (Map<String, @Nullable Object>) Objects.requireNonNull(operation.get("step")),
              payload,
              context);
        } catch (Throwable caught) {
          // The handler catches the suspension and returns. The worker must suspend the task
          // anyway.
          caughtSuspensions.incrementAndGet();
          return Map.of(Objects.requireNonNull(key), true);
        }
        result.put(Objects.requireNonNull(key), false);
        continue;
      }
      @Nullable Object value = runOperation(fixture, operation, payload, context);
      if (key != null) {
        result.put(key, value);
      }
    }
    completedScripts.incrementAndGet();
    return result;
  }

  private static Instant payloadTime(@Nullable Object payload, @Nullable Object field) {
    Map<String, @Nullable Object> fields = Runner.object(payload, "the payload");
    if (!(fields.get(String.valueOf(field)) instanceof String text)) {
      throw new Failure("the payload field " + field + " is not text");
    }
    return OffsetDateTime.parse(text).toInstant();
  }

  private @Nullable Object runOperation(
      Map<String, @Nullable Object> fixture,
      Map<String, @Nullable Object> operation,
      @Nullable Object payload,
      HandlerContext context)
      throws Exception {
    @Nullable Object value = runOperationOnce(fixture, operation, payload, context);
    if (SUSPENDING.contains(String.valueOf(operation.get("op")))) {
      returnedSuspendingCalls.incrementAndGet();
    }
    return value;
  }

  @SuppressWarnings("unchecked")
  private @Nullable Object runOperationOnce(
      Map<String, @Nullable Object> fixture,
      Map<String, @Nullable Object> operation,
      @Nullable Object payload,
      HandlerContext context)
      throws Exception {
    String name = String.valueOf(operation.get("name"));
    String childType = String.valueOf(fixture.get("childTaskType"));
    String childQueue = fixture.get("childQueue") instanceof String text ? text : null;
    return switch (String.valueOf(operation.get("op"))) {
      case "checkpoint" -> {
        @Nullable Object value = operation.get("value");
        if (operation.containsKey("input")) {
          yield context.checkpoint(
              name,
              Object.class,
              CheckpointOptions.input(operation.get("input")),
              () -> {
                checkpointOperations.incrementAndGet();
                return value;
              });
        }
        yield context.checkpoint(
            name,
            Object.class,
            () -> {
              checkpointOperations.incrementAndGet();
              return value;
            });
      }
      case "sleep" -> {
        long millis = ((Number) Objects.requireNonNull(operation.get("durationMs"))).longValue();
        context.sleep(name, Duration.ofMillis(millis));
        yield null;
      }
      case "sleepUntil" -> {
        context.sleepUntil(name, payloadTime(payload, operation.get("wakeAtField")));
        yield null;
      }
      case "waitForSignal" -> context.waitForSignal(name, Object.class, null);
      case "waitForHuman" ->
          context.waitForHuman(name, operation.get("context"), Object.class, null);
      case "runChild" -> {
        EnqueueOptions.Builder options = EnqueueOptions.builder().queue(childQueue);
        if (operation.get("deadlineField") != null) {
          options.deadline(payloadTime(payload, operation.get("deadlineField")));
        }
        if (operation.get("runAtField") != null) {
          options.runAt(payloadTime(payload, operation.get("runAtField")));
        }
        yield context.runChild(
            name, childType, operation.get("payload"), options.build(), Object.class);
      }
      case "runChildren" -> {
        List<ChildRequest> requests = new ArrayList<>();
        for (Object child : (List<Object>) Objects.requireNonNull(operation.get("children"))) {
          Map<String, @Nullable Object> request = (Map<String, @Nullable Object>) child;
          requests.add(
              ChildRequest.of(
                  String.valueOf(request.get("name")),
                  childType,
                  request.get("payload"),
                  EnqueueOptions.builder().queue(childQueue).build()));
        }
        Map<String, @Nullable Object> outcomes = new LinkedHashMap<>();
        Map<String, ChildOutcome> joined = context.runChildren(requests);
        // The set join counts as returned before the runner reads its outcomes, so a wrong value
        // still counts.
        returnedSuspendingCalls.incrementAndGet();
        for (Map.Entry<String, ChildOutcome> outcome : joined.entrySet()) {
          ChildStatus status = outcome.getValue().status();
          Map<String, @Nullable Object> shape = new LinkedHashMap<>();
          shape.put("status", status.name().toLowerCase(java.util.Locale.ROOT));
          if (status == ChildStatus.SUCCEEDED) {
            shape.put("result", outcome.getValue().result());
          }
          outcomes.put(outcome.getKey(), shape);
        }
        yield outcomes;
      }
      case "overlappingCheckpoints" ->
          overlappingCheckpoints(
              name,
              ((Number) Objects.requireNonNull(operation.get("overlapWindowMs"))).longValue(),
              context);
      default -> throw new Failure("unknown durable-script operation " + operation.get("op"));
    };
  }

  /**
   * Starts a second call with one name while the operation of the first call runs. The operation
   * waits until a second operation starts or the window ends, so a call that does not join the call
   * in flight runs the operation again.
   */
  private Object overlappingCheckpoints(String name, long windowMs, HandlerContext context)
      throws Exception {
    CountDownLatch started = new CountDownLatch(1);
    java.util.concurrent.Callable<Object> operation =
        () -> {
          int ordinal = checkpointOperations.incrementAndGet();
          started.countDown();
          long deadline = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(windowMs);
          while (checkpointOperations.get() < 2 && System.nanoTime() < deadline) {
            Thread.sleep(10);
          }
          return Map.of("operation", ordinal);
        };
    CompletableFuture<@Nullable Object> first =
        CompletableFuture.supplyAsync(
            () -> {
              try {
                return context.checkpoint(name, Object.class, operation);
              } catch (Exception error) {
                throw new java.util.concurrent.CompletionException(error);
              } finally {
                started.countDown();
              }
            });
    started.await();
    @Nullable Object second = context.checkpoint(name, Object.class, operation);
    List<@Nullable Object> values = new ArrayList<>();
    values.add(first.join());
    values.add(second);
    return values;
  }
}
