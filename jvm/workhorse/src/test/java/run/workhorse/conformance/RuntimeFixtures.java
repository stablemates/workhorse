package run.workhorse.conformance;

import static run.workhorse.conformance.Failure.check;

import io.opentelemetry.api.trace.Span;
import io.opentelemetry.context.Scope;
import io.opentelemetry.sdk.trace.data.SpanData;
import java.lang.reflect.InvocationHandler;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;
import java.lang.reflect.Proxy;
import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.Connection;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Statement;
import java.time.Duration;
import java.time.Instant;
import java.time.OffsetDateTime;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.BlockingQueue;
import java.util.concurrent.Callable;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;
import java.util.concurrent.atomic.AtomicReference;
import javax.sql.DataSource;
import org.jspecify.annotations.Nullable;
import org.postgresql.PGConnection;
import run.workhorse.AlreadyWaitingException;
import run.workhorse.BatchFailed;
import run.workhorse.BatchHandler;
import run.workhorse.BatchHandlerItem;
import run.workhorse.BatchHandlerOutcome;
import run.workhorse.BatchOptions;
import run.workhorse.BatchSucceeded;
import run.workhorse.BudgetDefinition;
import run.workhorse.CancelResult;
import run.workhorse.CancelStatus;
import run.workhorse.CancellationReason;
import run.workhorse.CheckpointOptions;
import run.workhorse.ChildRequest;
import run.workhorse.ConflictException;
import run.workhorse.EnqueueOptions;
import run.workhorse.Handler;
import run.workhorse.HandlerContext;
import run.workhorse.LeaseLostException;
import run.workhorse.LimitExceededException;
import run.workhorse.Queue;
import run.workhorse.QueueOptions;
import run.workhorse.RateLimit;
import run.workhorse.RateLimitPolicyDefinition;
import run.workhorse.Worker;
import run.workhorse.WorkhorseTelemetry;
import run.workhorse.internal.Json;
import run.workhorse.internal.Sql;
import run.workhorse.internal.SqlCatalogue;
import run.workhorse.testing.RecordingOpenTelemetry;

/**
 * Drives the failures and runtime fixtures through {@link Worker} against a scratch database. The
 * counterpart of Ruby's {@code Conformance::RuntimeFixtures}. Faults are injected around the
 * worker's statements through {@link Intercept} or into installed functions, never into the worker
 * itself.
 */
final class RuntimeFixtures {
  /** The JVM slices that are still open. A listed fixture names one of them. */
  static final Set<String> OPEN_SLICES = Set.of();

  /**
   * RuntimeFixtures fixtures that need a surface an open JVM slice owns, by fixture ID. Each one is
   * also on the expected-unsupported list with the same slice.
   */
  private static final Map<String, String> GAPS = Map.of();

  /** How long a runner waits for a stopped run to return. */
  private static final long RUN_WAIT_SECONDS = 10;

  /**
   * The shutdown grace of a worker whose stopped run the runner joins. The shared server can stall
   * a claim on its WAL flush for longer than {@link #RUN_WAIT_SECONDS}. A stop during that claim
   * waits until the grace ends, so the grace must end before the wait of the runner (SM-1801).
   */
  private static final Duration JOIN_GRACE = Duration.ofSeconds(5);

  /**
   * The shutdown grace of the graceful-drain worker, which is the default. The fixture tests the
   * drain, which the grace bounds, so the runner waits for the whole grace and then {@link
   * #RUN_WAIT_SECONDS} (SM-1801).
   */
  private static final Duration DRAIN_GRACE = Duration.ofSeconds(25);

  private static final Map<CancellationReason, String> CANCEL_NAMES =
      Map.of(
          CancellationReason.REQUESTED, "CancellationRequestedError",
          CancellationReason.DEADLINE_EXCEEDED, "DeadlineExceededError",
          CancellationReason.EXECUTION_TIMEOUT, "ExecutionTimeoutError");

  private final Connections.Opener opener;
  private final Connection connection;
  private final Map<String, @Nullable Object> envelope;
  private final Queue queue;
  private final List<Cleanup> cleanups = new ArrayList<>();

  RuntimeFixtures(Connections.Opener opener, Connection connection, Path protocol)
      throws Exception {
    this.opener = opener;
    this.connection = connection;
    this.envelope =
        Runner.object(
            Runner.object(
                    Json.parse(Files.readString(protocol.resolve("failures.json"))), "failures")
                .get("envelope"),
            "envelope");
    this.queue = new Queue(Connections.borrowed(connection));
  }

  /** Why no Java adapter can run {@code fixture} yet, or {@code null} when one can. */
  static @Nullable String gap(Map<String, @Nullable Object> fixture) {
    return GAPS.get(String.valueOf(fixture.get("id")));
  }

  void run(Map<String, @Nullable Object> fixture) throws Exception {
    try {
      dispatch(fixture);
    } finally {
      cleanUp();
    }
  }

  private void dispatch(Map<String, @Nullable Object> fixture) throws Exception {
    try {
      switch (String.valueOf(fixture.get("kind"))) {
        case "trace-propagation" -> trace(fixture);
        case "cooperative-cancellation" -> cancellation(fixture);
        case "expiration" -> expiration(fixture);
        case "heartbeat-cadence" -> heartbeatCadence(fixture);
        case "poll-cadence" -> pollCadence(fixture);
        case "graceful-drain" -> gracefulDrain(fixture);
        case "budget-admission-race" -> budgetRace(fixture);
        case "missing-handler" -> missingHandler(fixture);
        case "release-wait" -> releaseWait(fixture);
        case "subscription-recovery" -> subscriptionRecovery(fixture);
        case "json-round-trip" -> jsonRoundTrip(fixture);
        case "oversized-result" -> oversizedResult(fixture);
        case "shutdown-cancellation" -> shutdownCancellation(fixture);
        case "heartbeat-failure" -> heartbeatFailure(fixture);
        case "heartbeat-busy" -> heartbeatBusy(fixture);
        case "maintenance-phase-error" -> maintenancePhaseError(fixture);
        case "slot-refill" -> slotRefill(fixture);
        case "batch" -> batch(fixture);
        case "suspension-replay" -> suspensionReplay(fixture);
        case "lease-loss" -> leaseLoss(fixture);
        case "refused-completion" -> refusedCompletion(fixture);
        case "replay-conflict" -> replayConflict(fixture);
        default ->
            throw new Failure(
                "unknown runtime fixture kind " + Matcher.render(fixture.get("kind")));
      }
    } catch (Failure failure) {
      throw failure;
    } catch (Exception error) {
      throw new Failure(error.getClass().getSimpleName() + ": " + error.getMessage());
    }
  }

  /** The error a failures fixture declares by name. Its simple name is the envelope name. */
  static final class PaymentDeclined extends Exception {
    private static final long serialVersionUID = 1L;

    PaymentDeclined(String message) {
      super(message);
    }
  }

  /**
   * The message a failures fixture describes: text, or an array of text parts and unpaired
   * surrogates. A Java string holds an unpaired surrogate as one {@code char}.
   */
  static String fixtureMessage(@Nullable Object message) {
    if (message instanceof String text) {
      return text;
    }
    StringBuilder built = new StringBuilder();
    for (Object part : (List<?>) Objects.requireNonNull(message, "message")) {
      if (part instanceof String text) {
        built.append(text);
      } else {
        Object unit = Runner.object(part, "message part").get("unpairedSurrogate");
        built.append((char) Integer.parseInt(String.valueOf(unit), 16));
      }
    }
    return built.toString();
  }

  void failure(Map<String, @Nullable Object> fixture) throws Exception {
    String name = "failures-" + fixture.get("id");
    UUID taskId = enqueue("protocol.failure", Map.of(), options(name).maxAttempts(1));
    boolean redacted = Boolean.TRUE.equals(fixture.get("redactErrorDetails"));
    if (redacted) {
      update(
          "UPDATE workhorse.task SET payload_redact_keys = ARRAY['secret'] WHERE id = '"
              + taskId
              + "'");
    }
    Map<String, @Nullable Object> declared = Runner.object(fixture.get("error"), "error");
    String message = fixtureMessage(declared.get("message"));
    Exception error =
        Boolean.TRUE.equals(declared.get("declaresName"))
            ? new PaymentDeclined(message)
            : new Exception(message);
    boolean declaresStack = Boolean.TRUE.equals(declared.get("declaresStack"));
    if (!declaresStack) {
      error.setStackTrace(new StackTraceElement[0]);
    }
    List<@Nullable Object> sent = new CopyOnWriteArrayList<>();
    Intercept.Hook hook =
        new Intercept.Hook() {
          @Override
          public void before(Intercept.Call call) {
            // PostgreSQL also redacts, so the envelope is checked before it leaves the worker.
            if (call.is(SqlCatalogue.FAIL_V1)) {
              sent.add(Json.parse(String.valueOf(call.parameter(SqlCatalogue.FAIL_V1, 4))));
            }
          }
        };
    try (Intercept pool = new Intercept(opener, hook)) {
      Worker subject =
          Worker.builder(pool)
              .queues(name)
              .workerId("jvm-" + name)
              .pollingOnly(true)
              .disableRegistry(true)
              .handle(
                  "protocol.failure",
                  Object.class,
                  (ctx, payload) -> {
                    throw error;
                  })
              .build();
      check(subject.runOnce(), "the worker did not run the failing task");
    }
    check(
        (error.getStackTrace().length > 0) == declaresStack,
        "the handler raised a stack of "
            + error.getStackTrace().length
            + " frames, want declaresStack "
            + declaresStack);
    check(sent.size() == 1, "the worker sent " + sent.size() + " fail_v1 calls, want 1");
    Object stored =
        Json.parse(
            value(
                "SELECT error::text FROM workhorse.task_outcome WHERE task_id = '" + taskId + "'"));
    failureEnvelope(fixture, "sent", Runner.object(sent.get(0), "sent envelope"));
    failureEnvelope(fixture, "stored", Runner.object(stored, "stored envelope"));
  }

  private void failureEnvelope(
      Map<String, @Nullable Object> fixture, String label, Map<String, @Nullable Object> stored) {
    boolean redacted = Boolean.TRUE.equals(fixture.get("redactErrorDetails"));
    Set<Object> fields = Set.copyOf((List<?>) envelope.get(redacted ? "redactedFields" : "fields"));
    check(
        Set.copyOf(stored.keySet()).equals(fields),
        label + " envelope fields " + stored.keySet() + ", want " + fields);
    Map<String, @Nullable Object> expected = Runner.object(fixture.get("envelope"), "envelope");
    Object want = expected.get("name");
    if ("$generic".equals(want)) {
      want = Runner.object(envelope.get("genericName"), "genericName").get("java");
    }
    check(
        Matcher.same(stored.get("name"), want),
        label + " envelope name " + Matcher.render(stored.get("name")) + ", want " + want);
    check(
        Matcher.same(stored.get("message"), expected.get("message")),
        label
            + " envelope message "
            + Matcher.render(stored.get("message"))
            + ", want "
            + Matcher.render(expected.get("message")));
    Object stack = stored.get("stack");
    switch (String.valueOf(expected.get("stack"))) {
      case "string" ->
          check(
              stack instanceof String text && !text.isEmpty(),
              label + " envelope stack is not a string");
      case "stringOrNull" ->
          check(
              stack == null || stack instanceof String,
              label + " envelope stack is neither a string nor null");
      default -> {}
    }
    for (Object character : (List<?>) envelope.get("forbiddenNameCharacters")) {
      check(
          !String.valueOf(stored.get("name")).contains((String) character),
          label + " envelope name " + stored.get("name") + " contains " + character);
    }
  }

  // ----- fixtures ------------------------------------------------------------------------------

  private void cancellation(Map<String, @Nullable Object> fixture) throws Exception {
    UUID taskId = enqueue(taskType(fixture), Map.of(), options(queueName(fixture)));
    CountDownLatch started = new CountDownLatch(1);
    List<String> reasons = new CopyOnWriteArrayList<>();
    try (Intercept pool = new Intercept(opener, new Intercept.Hook() {})) {
      Worker subject =
          worker(pool, fixture)
              .lease(millis(fixture, "leaseMs"))
              .heartbeat(millis(fixture, "heartbeatMs"))
              .sharedHeartbeats(true)
              .handle(
                  taskType(fixture),
                  Object.class,
                  (ctx, payload) -> {
                    started.countDown();
                    if (!ctx.cancellation().await(Duration.ofSeconds(5))) {
                      throw new IllegalStateException("the cancellation never reached the handler");
                    }
                    reasons.add(CANCEL_NAMES.get(ctx.cancellation().reason()));
                    ctx.cancellation().throwIfCancelled();
                    return null;
                  })
              .build();
      CompletableFuture<Boolean> result = running(subject, subject::runOnce);
      check(started.await(5, TimeUnit.SECONDS), "the handler never started");
      CancelResult cancel =
          queue.cancel(taskId, "runtime-fixture", (String) fixture.get("cancelReason"));
      check(cancel.status() == CancelStatus.CANCEL_REQUESTED, "cancel returned " + cancel.status());
      check(join(result), "the worker did not report the cancelled run");
    }
    check(reasons.equals(List.of(fixture.get("expectedAbortReason"))), "abort reasons " + reasons);
    expectState(taskId, object(fixture, "expectedState"));
    expectOutcomes(taskId, List.of(fixture.get("expectedAttemptOutcome")));
  }

  private void expiration(Map<String, @Nullable Object> fixture) throws Exception {
    boolean deadline = "deadline".equals(fixture.get("mode"));
    long duration = (Long) fixture.get("durationMs");
    long lead = (Long) fixture.get("localClockLeadMs");
    EnqueueOptions.Builder options =
        options(queueName(fixture))
            .maxAttempts(Runner.intValue(fixture.get("maxAttempts")))
            .retryPolicy(Map.of("type", "fixed", "delayMs", 0));
    // The deadline budget starts after the claim, inside the claim hook. The placeholder only has
    // to be far enough away that the claim never skips the task.
    if (deadline) {
      options.deadline(Instant.now().plusSeconds(3600));
    } else {
      options.executionTimeout(Duration.ofMillis(duration));
    }
    UUID taskId = enqueue(taskType(fixture), Map.of(), options);
    List<String> reasons = new CopyOnWriteArrayList<>();
    // The expiry PostgreSQL holds for each attempt, and its clock when the handler saw
    // cancellation.
    List<Instant> expiries = new CopyOnWriteArrayList<>();
    List<Instant> cancelledAt = new CopyOnWriteArrayList<>();
    AtomicInteger heartbeats = new AtomicInteger();
    String field = deadline ? "deadline_at" : "attempt_timeout_at";
    AtomicReference<@Nullable Worker> holder = new AtomicReference<>();
    // The local timer reads the claimed row, so shifting it models a clock that runs ahead of or
    // behind PostgreSQL.
    Intercept.Hook hook =
        new Intercept.Hook() {
          @Override
          public void before(Intercept.Call call) {
            if (call.is(SqlCatalogue.HEARTBEAT_MANY_V2)) {
              heartbeats.incrementAndGet();
            }
          }

          @Override
          public void after(Intercept.Call call) {
            if (call.is(SqlCatalogue.HEARTBEAT_MANY_V2)) {
              heartbeats.decrementAndGet();
            }
          }

          @Override
          public @Nullable OffsetDateTime timestamp(
              Intercept.Call call, String column, @Nullable OffsetDateTime value) throws Exception {
            if (!call.is(SqlCatalogue.CLAIM_MANY_V1) || !column.equals(field)) {
              return value;
            }
            Instant anchor;
            synchronized (connection) {
              anchor =
                  deadline
                      ? Database.instant(
                          value(
                              "UPDATE workhorse.task_runtime SET deadline_at = clock_timestamp() + ("
                                  + duration
                                  + " * interval '1 millisecond') WHERE task_id = '"
                                  + taskId
                                  + "' RETURNING deadline_at::text"))
                      : java.util.Objects.requireNonNull(value).toInstant();
            }
            expiries.add(anchor);
            return anchor.minusMillis(lead).atOffset(java.time.ZoneOffset.UTC);
          }
        };
    try (Intercept pool = new Intercept(opener, hook)) {
      Worker subject =
          worker(pool, fixture)
              .lease(millis(fixture, "leaseMs"))
              .heartbeat(millis(fixture, "heartbeatMs"))
              .sharedHeartbeats(true)
              .handle(
                  taskType(fixture),
                  Object.class,
                  (ctx, payload) -> {
                    if (!ctx.cancellation().await(Duration.ofSeconds(5))) {
                      throw new IllegalStateException("the expiration never reached the handler");
                    }
                    cancelledAt.add(
                        Database.instant(
                            java.util.Objects.requireNonNull(
                                value("SELECT clock_timestamp()::text"))));
                    reasons.add(CANCEL_NAMES.get(ctx.cancellation().reason()));
                    java.util.Objects.requireNonNull(holder.get()).pause();
                    ctx.cancellation().throwIfCancelled();
                    return null;
                  })
              .build();
      holder.set(subject);
      List<?> runs = (List<?>) fixture.get("expectedAfterRuns");
      for (int index = 0; index < runs.size(); index++) {
        // A heartbeat round that began before the last attempt settled holds the task's row
        // lock, and the claim skips a locked row.
        eventually(
            "a heartbeat round outlived the previous attempt", 5, () -> heartbeats.get() == 0);
        subject.resume();
        check(subject.runOnce(), "run " + (index + 1) + " did not run the task");
        expectState(taskId, Runner.object(runs.get(index), "expected"));
      }
    }
    check(reasons.equals(fixture.get("expectedAbortReasons")), "abort reasons " + reasons);
    // Both times come from the database clock, so the worker clock cannot move either one.
    check(
        expiries.size() == cancelledAt.size(),
        expiries.size() + " claims, " + cancelledAt.size() + " cancellations");
    List<Boolean> afterExpiry = new java.util.ArrayList<>();
    for (int index = 0; index < cancelledAt.size(); index++) {
      afterExpiry.add(!cancelledAt.get(index).isBefore(expiries.get(index)));
    }
    check(
        afterExpiry.equals(
            java.util.Collections.nCopies(
                cancelledAt.size(), fixture.get("expectedCancelledAfterDatabaseExpiry"))),
        "cancellation after the database expiry: " + afterExpiry);
    expectOutcomes(taskId, (List<?>) fixture.get("expectedAttemptOutcomes"));
  }

  private void heartbeatCadence(Map<String, @Nullable Object> fixture) throws Exception {
    enqueue(taskType(fixture), Map.of(), options(queueName(fixture)));
    CountDownLatch handlerStarted = new CountDownLatch(1);
    CountDownLatch releaseHandler = new CountDownLatch(1);
    CountDownLatch firstStarted = new CountDownLatch(1);
    CountDownLatch releaseFirst = new CountDownLatch(1);
    AtomicInteger calls = new AtomicInteger();
    AtomicInteger active = new AtomicInteger();
    AtomicInteger overlap = new AtomicInteger();
    long heartbeat = (Long) fixture.get("heartbeatMs");
    Intercept.Hook hook =
        new Intercept.Hook() {
          @Override
          public void before(Intercept.Call call) throws InterruptedException {
            if (!call.is(SqlCatalogue.HEARTBEAT_MANY_V2)) {
              return;
            }
            int number = calls.incrementAndGet();
            overlap.accumulateAndGet(active.incrementAndGet(), Math::max);
            if (number == 1) {
              firstStarted.countDown();
              if (!releaseFirst.await(5, TimeUnit.SECONDS)) {
                throw new IllegalStateException("the first heartbeat was never released");
              }
            }
          }

          @Override
          public void after(Intercept.Call call) {
            if (call.is(SqlCatalogue.HEARTBEAT_MANY_V2)) {
              active.decrementAndGet();
            }
          }
        };
    try (Intercept pool = new Intercept(opener, hook)) {
      Worker subject =
          worker(pool, fixture)
              .lease(millis(fixture, "leaseMs"))
              .heartbeat(Duration.ofMillis(heartbeat))
              .sharedHeartbeats(true)
              .handle(
                  taskType(fixture),
                  Object.class,
                  (ctx, payload) -> {
                    handlerStarted.countDown();
                    if (!releaseHandler.await(5, TimeUnit.SECONDS)) {
                      throw new IllegalStateException("the handler was never released");
                    }
                    return null;
                  })
              .build();
      CompletableFuture<Boolean> result = running(subject, subject::runOnce);
      try {
        check(handlerStarted.await(5, TimeUnit.SECONDS), "the handler never started");
        check(firstStarted.await(5, TimeUnit.SECONDS), "no heartbeat started");
        Thread.sleep(heartbeat * 3);
        check(
            calls.get() == (Long) fixture.get("expectedCallsWhileBlocked"),
            calls.get() + " heartbeats started while one was blocked");
        releaseFirst.countDown();
        long minimum = (Long) fixture.get("expectedMinimumCallsBeforeSettlement");
        eventually("no heartbeat followed the blocked one", 10, () -> calls.get() >= minimum);
        check(
            overlap.get() == (Long) fixture.get("expectedMaximumOverlap"),
            overlap.get() + " heartbeats overlapped");
        releaseHandler.countDown();
        check(join(result), "the worker did not run the task");
      } finally {
        releaseFirst.countDown();
        releaseHandler.countDown();
        result.handle((value, error) -> value).get(10, TimeUnit.SECONDS);
      }
      // An in-flight round can end after the attempt settles; it starts no new one.
      eventually("a heartbeat round outlived the attempt", 5, () -> active.get() == 0);
      int settled = calls.get();
      Thread.sleep(heartbeat * 3);
      check(calls.get() == settled, "heartbeats continued after the attempt settled");
    }
  }

  /**
   * Holds the worker after each empty claim until the driver releases it, so an uncounted poll
   * cannot advance the backoff step the delay is measured against.
   *
   * <p>The delay runs from the moment the last empty claim returns to the worker to the start of
   * the next claim. That span is the worker's own cadence.
   */
  private void pollCadence(Map<String, @Nullable Object> fixture) throws Exception {
    String name = queueName(fixture);
    long polls = (Long) fixture.get("emptyPollsBeforeEnqueue");
    long maximum = (Long) fixture.get("expectedMaximumDelayMs");
    BlockingQueue<Boolean> reached = new LinkedBlockingQueue<>();
    BlockingQueue<Boolean> released = new LinkedBlockingQueue<>();
    AtomicBoolean holding = new AtomicBoolean(true);
    // Each claim_many_v1 call's start, its return to the worker, and whether it found a task.
    List<long[]> claims = Collections.synchronizedList(new ArrayList<>());
    Map<Intercept.Call, Long> starts =
        Collections.synchronizedMap(new java.util.IdentityHashMap<>());
    CountDownLatch handled = new CountDownLatch(1);
    Intercept.Hook hook =
        new Intercept.Hook() {
          @Override
          public void before(Intercept.Call call) {
            if (call.is(SqlCatalogue.CLAIM_MANY_V1)) {
              starts.put(call, System.nanoTime());
            }
          }

          @Override
          public void after(Intercept.Call call) throws InterruptedException {
            if (!call.is(SqlCatalogue.CLAIM_MANY_V1)) {
              return;
            }
            if (call.rows() == 0 && holding.get()) {
              reached.add(true);
              released.poll(5, TimeUnit.SECONDS);
            }
            Long start = starts.remove(call);
            claims.add(new long[] {start == null ? 0 : start, System.nanoTime(), call.rows()});
          }
        };
    try (Intercept pool = new Intercept(opener, hook)) {
      Worker subject =
          worker(pool, fixture)
              .pollInterval(millis(fixture, "pollMs"))
              .shutdownGrace(JOIN_GRACE)
              .handle(
                  taskType(fixture),
                  Object.class,
                  (ctx, payload) -> {
                    handled.countDown();
                    return null;
                  })
              .build();
      CompletableFuture<Void> run = running(subject, subject::run);
      try {
        for (long poll = 1; poll <= polls; poll++) {
          check(
              reached.poll(maximum + 1000, TimeUnit.MILLISECONDS) != null,
              "the worker did not complete empty poll " + poll);
          if (poll == polls) {
            // A stall longer than one backoff step changes nothing for a held worker.
            Thread.sleep((Long) fixture.get("enqueueStallMs"));
            enqueue(taskType(fixture), Map.of(), options(name));
            holding.set(false);
          }
          released.add(true);
        }
        check(
            handled.await(maximum + 1000, TimeUnit.MILLISECONDS),
            "the worker never ran the enqueued task");
      } finally {
        holding.set(false);
        released.add(true);
        subject.stop();
        run.get(RUN_WAIT_SECONDS, TimeUnit.SECONDS);
      }
    }
    List<long[]> seen = List.copyOf(claims);
    int found = -1;
    for (int index = 0; index < seen.size(); index++) {
      if (seen.get(index)[2] > 0) {
        found = index;
        break;
      }
    }
    check(found > 0, "no claim_many_v1 call after an empty poll returned the enqueued task");
    long empty = seen.subList(0, found).stream().filter(claim -> claim[2] == 0).count();
    check(
        empty == polls,
        "the worker claimed the task after " + empty + " empty polls, want " + polls);
    long delay = TimeUnit.NANOSECONDS.toMillis(seen.get(found)[0] - seen.get(found - 1)[1]);
    long minimum = (Long) fixture.get("expectedMinimumDelayMs");
    check(
        delay >= minimum && delay <= maximum,
        "the claim after "
            + polls
            + " empty polls waited "
            + delay
            + " ms, want "
            + minimum
            + " to "
            + maximum
            + " ms");
  }

  private void gracefulDrain(Map<String, @Nullable Object> fixture) throws Exception {
    String name = queueName(fixture);
    List<UUID> taskIds = new ArrayList<>();
    for (long sequence = 0; sequence < (Long) fixture.get("taskCount"); sequence++) {
      taskIds.add(enqueue(taskType(fixture), Map.of("sequence", sequence), options(name)));
    }
    CountDownLatch release = new CountDownLatch(1);
    AtomicInteger active = new AtomicInteger();
    long expectedActive = (Long) fixture.get("expectedActiveAtStop");
    try (Intercept pool = new Intercept(opener, new Intercept.Hook() {})) {
      Worker subject =
          worker(pool, fixture)
              .concurrency(Math.toIntExact((Long) fixture.get("concurrency")))
              .pollInterval(Duration.ofSeconds(5))
              .shutdownGrace(DRAIN_GRACE)
              .handle(
                  taskType(fixture),
                  Object.class,
                  (ctx, payload) -> {
                    active.incrementAndGet();
                    try {
                      if (!release.await(5, TimeUnit.SECONDS)) {
                        throw new IllegalStateException("the handler was never released");
                      }
                      return null;
                    } finally {
                      active.decrementAndGet();
                    }
                  })
              .build();
      CompletableFuture<Void> run = running(subject, subject::run);
      try {
        eventually("the worker did not fill its slots", 10, () -> active.get() == expectedActive);
        subject.stop();
        check(active.get() == expectedActive, "stop abandoned an active slot");
        Thread.sleep((Long) fixture.get("settleCheckMs"));
        check(!run.isDone(), "run returned before its handlers finished");
      } finally {
        release.countDown();
        subject.stop();
        // The wait is in the finally block, so it also bounds a fixture that fails early. The
        // failure of the fixture stays the reported outcome.
        try {
          run.get(DRAIN_GRACE.toSeconds() + RUN_WAIT_SECONDS, TimeUnit.SECONDS);
        } catch (ExecutionException | TimeoutException ignored) {
          // The checks after the drain report the outcome.
        }
      }
      check(run.isDone(), "the worker run did not return within its shutdown grace and then 10 s");
      run.get();
      check(active.get() == 0, "slots remain active after the drain");
    }
    List<String> states = new ArrayList<>();
    for (UUID taskId : taskIds) {
      states.add(String.valueOf(state(taskId).get("state")));
    }
    check(
        Collections.frequency(states, "succeeded") == (Long) fixture.get("expectedSucceeded"),
        "states after the drain: " + states);
    check(
        Collections.frequency(states, "ready") == (Long) fixture.get("expectedReady"),
        "states after the drain: " + states);
  }

  /**
   * A busy worker refills free slots with overlapping batched claims. Holding a claim keeps it in
   * flight, so the next claim is observed while the first is open.
   */
  private void slotRefill(Map<String, @Nullable Object> fixture) throws Exception {
    String name = queueName(fixture);
    int concurrency = Math.toIntExact((Long) fixture.get("concurrency"));
    long taskCount = (Long) fixture.get("taskCount");
    List<UUID> taskIds = new ArrayList<>();
    for (long sequence = 0; sequence < taskCount; sequence++) {
      taskIds.add(enqueue(taskType(fixture), Map.of("sequence", sequence), options(name)));
    }
    Object lock = new Object();
    List<Long> limits = new ArrayList<>();
    List<CountDownLatch> held = new ArrayList<>();
    AtomicBoolean holding = new AtomicBoolean();
    AtomicInteger inFlight = new AtomicInteger();
    AtomicInteger overlapping = new AtomicInteger();
    AtomicInteger withTasks = new AtomicInteger();
    // `running` and `peak` count handler bodies, so the whole run shows the concurrency holds.
    List<CountDownLatch> started = new ArrayList<>();
    AtomicBoolean open = new AtomicBoolean();
    AtomicInteger running = new AtomicInteger();
    AtomicInteger peak = new AtomicInteger();
    Runnable releaseHeld =
        () -> {
          List<CountDownLatch> waiting;
          synchronized (lock) {
            holding.set(false);
            waiting = List.copyOf(held);
            held.clear();
          }
          waiting.forEach(CountDownLatch::countDown);
        };
    Runnable openAll =
        () -> {
          List<CountDownLatch> waiting;
          synchronized (lock) {
            open.set(true);
            waiting = List.copyOf(started);
            started.clear();
          }
          waiting.forEach(CountDownLatch::countDown);
        };
    Intercept.Hook hook =
        new Intercept.Hook() {
          @Override
          public void before(Intercept.Call call) throws InterruptedException {
            if (!call.is(SqlCatalogue.CLAIM_MANY_V1)) {
              return;
            }
            CountDownLatch release = new CountDownLatch(1);
            synchronized (lock) {
              limits.add(
                  Long.parseLong(String.valueOf(call.parameter(SqlCatalogue.CLAIM_MANY_V1, 3))));
              overlapping.accumulateAndGet(inFlight.incrementAndGet(), Math::max);
              if (holding.get()) {
                held.add(release);
              } else {
                release.countDown();
              }
            }
            if (!release.await(10, TimeUnit.SECONDS)) {
              inFlight.decrementAndGet();
              throw new IllegalStateException("a held claim was never released");
            }
          }

          @Override
          public void after(Intercept.Call call) {
            if (call.is(SqlCatalogue.CLAIM_MANY_V1)) {
              if (call.rows() > 0) {
                withTasks.incrementAndGet();
              }
              inFlight.decrementAndGet();
            }
          }
        };
    try (Intercept pool = new Intercept(opener, hook)) {
      Worker subject =
          worker(pool, fixture)
              .concurrency(concurrency)
              .sharedHeartbeats(true)
              .shutdownGrace(JOIN_GRACE)
              .handle(
                  taskType(fixture),
                  Object.class,
                  (ctx, payload) -> {
                    CountDownLatch finished = new CountDownLatch(1);
                    boolean blocked;
                    synchronized (lock) {
                      peak.accumulateAndGet(running.incrementAndGet(), Math::max);
                      blocked = !open.get();
                      if (blocked) {
                        started.add(finished);
                      }
                    }
                    try {
                      if (blocked && !finished.await(10, TimeUnit.SECONDS)) {
                        throw new IllegalStateException("the handler was never finished");
                      }
                      return null;
                    } finally {
                      running.decrementAndGet();
                    }
                  })
              .build();
      CompletableFuture<Void> run = running(subject, subject::run);
      try {
        eventually(
            "the worker did not fill its slots", 10, () -> size(lock, started) == concurrency);
        holding.set(true);
        for (int finished = 1; finished <= 3; finished++) {
          CountDownLatch first;
          synchronized (lock) {
            first = started.remove(0);
          }
          first.countDown();
          if (finished == 2) {
            // One more free slot is below the refill batch while the first refill is held.
            Thread.sleep((Long) fixture.get("settleCheckMs"));
            check(
                size(lock, limits) == 2, "a single free slot started claim " + size(lock, limits));
          } else {
            int expected = finished == 1 ? 2 : 3;
            eventually(
                "the worker did not start claim " + expected,
                10,
                () -> size(lock, limits) >= expected);
          }
        }
        List<Long> seen;
        synchronized (lock) {
          seen = List.copyOf(limits);
        }
        check(Matcher.same(seen, fixture.get("expectedClaimLimits")), "claim limits " + seen);
        check(
            overlapping.get() == (Long) fixture.get("expectedOverlappingClaims"),
            overlapping.get() + " claims overlapped");
        releaseHeld.run();
        openAll.run();
        eventually(
            "the worker did not run every task",
            20,
            () -> {
              for (UUID taskId : taskIds) {
                if (!"succeeded".equals(state(taskId).get("state"))) {
                  return false;
                }
              }
              return true;
            });
        double ratio = withTasks.get() / (double) taskCount;
        check(
            ratio <= ((Number) fixture.get("expectedMaximumClaimsPerTask")).doubleValue(),
            ratio + " claims per task");
        check(
            peak.get() == concurrency,
            peak.get() + " handlers ran at once with concurrency " + concurrency);
      } finally {
        releaseHeld.run();
        openAll.run();
        subject.stop();
        run.handle((value, error) -> null).get(RUN_WAIT_SECONDS, TimeUnit.SECONDS);
      }
    }
  }

  /**
   * Whether {@code call} renews leases. A worker with shared heartbeats sends {@code
   * heartbeat_many_v2}. The dedicated heartbeat of a pool sends {@code heartbeat_pool_v1}.
   */
  private static boolean heartbeat(Intercept.Call call) {
    return call.is(SqlCatalogue.HEARTBEAT_MANY_V2) || call.is(SqlCatalogue.HEARTBEAT_POOL_V1);
  }

  private static int size(Object lock, List<?> list) {
    synchronized (lock) {
      return list.size();
    }
  }

  /**
   * The handler checkpoints, pauses the worker on its first run, and sleeps durably. The sleep
   * suspends the attempt and frees the slot for the following task. The runner then rewinds the
   * wait and promotes it, so the replay runs at once and reuses the checkpoint.
   */
  private void suspensionReplay(Map<String, @Nullable Object> fixture) throws Exception {
    String name = queueName(fixture);
    Map<String, UUID> taskIds = new LinkedHashMap<>();
    taskIds.put("suspension", enqueue(taskType(fixture), Map.of(), options(name)));
    taskIds.put(
        "following", enqueue((String) fixture.get("followingTaskType"), Map.of(), options(name)));
    List<String> seen = new CopyOnWriteArrayList<>();
    AtomicInteger runs = new AtomicInteger();
    AtomicInteger operations = new AtomicInteger();
    AtomicReference<@Nullable Worker> holder = new AtomicReference<>();
    try (Intercept pool = new Intercept(opener, new Intercept.Hook() {})) {
      Worker subject =
          worker(pool, fixture)
              .maintenanceInterval(Duration.ofMillis(100))
              .handle(
                  taskType(fixture),
                  Object.class,
                  (ctx, payload) -> {
                    int run = runs.incrementAndGet();
                    seen.add("suspension:" + ctx.task().attempt());
                    Object prepared =
                        ctx.checkpoint(
                            (String) fixture.get("checkpointName"),
                            Object.class,
                            () -> Map.of("operation", (long) operations.incrementAndGet()));
                    if (run == 1) {
                      java.util.Objects.requireNonNull(holder.get()).pause();
                    }
                    ctx.sleep((String) fixture.get("waitName"), millis(fixture, "waitMs"));
                    Map<String, @Nullable Object> result = new LinkedHashMap<>();
                    result.put("prepared", prepared);
                    result.put("handlerRuns", (long) run);
                    return result;
                  })
              .handle(
                  (String) fixture.get("followingTaskType"),
                  Object.class,
                  (ctx, payload) -> {
                    seen.add("following:" + ctx.task().attempt());
                    return Map.of("handled", true);
                  })
              .build();
      holder.set(subject);
      check(subject.runOnce(), "the worker did not run the suspending task");
      expectStates(taskIds, object(fixture, "expectedAfterSuspension"));
      check(
          attempts(taskIds.get("suspension"))
              == (Long) fixture.get("expectedAttemptsAfterSuspension"),
          "the suspended task recorded " + attempts(taskIds.get("suspension")) + " attempts");
      subject.resume();
      check(subject.runOnce(), "the released slot did not run the following task");
      expectStates(taskIds, object(fixture, "expectedAfterSlotRelease"));
      // The wait is long enough that it cannot elapse on a slow runner, so the runner rewinds it
      // and promotes it instead of sleeping through it.
      update(
          "UPDATE workhorse.task_runtime SET run_at = clock_timestamp() - interval '1 millisecond'"
              + " WHERE task_id = '"
              + taskIds.get("suspension")
              + "'");
      update("SELECT * FROM workhorse.tick_v1(100, 100)");
      check(subject.runOnce(), "the worker did not replay the woken task");
      expectStates(taskIds, object(fixture, "expectedAfterReplay"));
    }
    check(
        attempts(taskIds.get("suspension")) == (Long) fixture.get("expectedAttemptsAfterReplay"),
        "the replayed task recorded " + attempts(taskIds.get("suspension")) + " attempts");
    check(Matcher.same(seen, fixture.get("expectedHandlerOrder")), "handler order " + seen);
    check(
        runs.get() == (Long) fixture.get("expectedHandlerRuns"),
        "the handler ran " + runs.get() + " times");
    check(
        operations.get() == (Long) fixture.get("expectedCheckpointOperations"),
        "the checkpoint operation ran " + operations.get() + " times");
  }

  /**
   * A heartbeat locks the task's runtime row, and recovery skips a locked row. So the runner holds
   * every heartbeat until the recovery ends, as the Go and Ruby lanes do. The first heartbeat after
   * that finds the recovered task and reports the lease as stale.
   */
  private void leaseLoss(Map<String, @Nullable Object> fixture) throws Exception {
    UUID taskId =
        enqueue(
            taskType(fixture),
            Map.of(),
            options(queueName(fixture))
                .maxAttempts(Runner.intValue(fixture.get("maxAttempts")))
                .retryPolicy(Map.of("type", "fixed", "delayMs", 0)));
    CountDownLatch started = new CountDownLatch(1);
    CountDownLatch recoveryEnded = new CountDownLatch(1);
    List<@Nullable CancellationReason> reasons = new CopyOnWriteArrayList<>();
    List<String> rejected = new CopyOnWriteArrayList<>();
    AtomicReference<@Nullable Worker> holder = new AtomicReference<>();
    Intercept.Hook hook =
        new Intercept.Hook() {
          @Override
          public void before(Intercept.Call call) throws InterruptedException {
            if (heartbeat(call) && !recoveryEnded.await(5, TimeUnit.SECONDS)) {
              throw new IllegalStateException("a held heartbeat was never released");
            }
          }
        };
    try (Intercept pool = new Intercept(opener, hook)) {
      Worker subject =
          worker(pool, fixture)
              .lease(millis(fixture, "leaseMs"))
              .heartbeat(millis(fixture, "heartbeatMs"))
              .handle(
                  taskType(fixture),
                  Object.class,
                  (ctx, payload) -> {
                    started.countDown();
                    if (!ctx.cancellation().await(Duration.ofSeconds(5))) {
                      throw new IllegalStateException("the lease loss never reached the handler");
                    }
                    reasons.add(ctx.cancellation().reason());
                    for (Map.Entry<String, LateWrite> write : lateWrites(ctx).entrySet()) {
                      try {
                        write.getValue().run();
                      } catch (LeaseLostException lost) {
                        rejected.add(write.getKey());
                      }
                    }
                    // The worker survives the loss and would claim the retried attempt next, so
                    // claims pause to keep the ready state observable.
                    java.util.Objects.requireNonNull(holder.get()).pause();
                    return Map.of("late", true);
                  })
              .build();
      holder.set(subject);
      CompletableFuture<Boolean> result = running(subject, subject::runOnce);
      try {
        check(started.await(5, TimeUnit.SECONDS), "the handler never started");
        update(
            "UPDATE workhorse.task_runtime SET expires_at = clock_timestamp() - interval '1"
                + " millisecond' WHERE task_id = '"
                + taskId
                + "'");
        String recovered =
            value("SELECT rows_affected FROM workhorse.recover_expired_telemetry_v1(100, 0)");
        recoveryEnded.countDown();
        check("1".equals(recovered), "recovery expired " + recovered + " leases, want 1");
        check(join(result), "the worker did not report the lost run");
      } finally {
        recoveryEnded.countDown();
      }
    }
    check("processed".equals(fixture.get("expectedRunOutcome")), "unexpected run outcome");
    check(reasons.equals(List.of(CancellationReason.LEASE_LOST)), "abort reasons " + reasons);
    check(
        Matcher.same(rejected, fixture.get("portableRejectedWrites")),
        "rejected writes " + rejected);
    expectState(taskId, object(fixture, "expectedState"));
    expectOutcomes(taskId, List.of(fixture.get("expectedAttemptOutcome")));
  }

  /**
   * The handler changes its own task in PostgreSQL and then returns, so PostgreSQL refuses the
   * completion write. The enqueued deadline and execution timeout are an hour away, so the worker's
   * own timers cannot reach them. The run settles the cause of the refusal before it returns,
   * without a maintenance pass.
   */
  private void refusedCompletion(Map<String, @Nullable Object> fixture) throws Exception {
    for (Object entry : (List<?>) Objects.requireNonNull(fixture.get("cases"), "cases")) {
      Map<String, @Nullable Object> testCase = Runner.object(entry, "case");
      String cause = (String) testCase.get("cause");
      try {
        refusedCompletion(fixture, testCase, cause);
      } catch (Failure failure) {
        throw new Failure(cause + ": " + failure.getMessage());
      }
    }
  }

  private void refusedCompletion(
      Map<String, @Nullable Object> fixture, Map<String, @Nullable Object> testCase, String cause)
      throws Exception {
    String queueName = queueName(fixture) + "-" + cause;
    UUID taskId =
        enqueue(
            taskType(fixture),
            Map.of(),
            options(queueName)
                .maxAttempts(1)
                .deadline(Instant.now().plus(Duration.ofHours(1)))
                .executionTimeout(Duration.ofHours(1)));
    AtomicInteger handled = new AtomicInteger();
    List<CancelStatus> cancels = new CopyOnWriteArrayList<>();
    try (Intercept pool = new Intercept(opener, new Intercept.Hook() {})) {
      Worker subject =
          worker(pool, fixture)
              .queues(queueName)
              .workerId("jvm-" + queueName)
              .lease(millis(fixture, "leaseMs"))
              .heartbeat(millis(fixture, "heartbeatMs"))
              .maintenanceInterval(Duration.ofHours(1))
              .handle(
                  taskType(fixture),
                  Object.class,
                  (ctx, payload) -> {
                    handled.incrementAndGet();
                    switch (cause) {
                      case "deadline", "attempt-timeout" ->
                          update(
                              "UPDATE workhorse.task_runtime SET "
                                  + ("deadline".equals(cause)
                                      ? "deadline_at"
                                      : "attempt_timeout_at")
                                  + " = clock_timestamp() - interval '1 second' WHERE task_id = '"
                                  + taskId
                                  + "'");
                      case "cancellation" -> {
                        synchronized (connection) {
                          cancels.add(queue.cancel(taskId, "runtime-fixture", null).status());
                        }
                      }
                      case "moved-fence" ->
                          update(
                              "UPDATE workhorse.task_runtime SET fence_token = fence_token + 1,"
                                  + " deadline_at = clock_timestamp() - interval '1 second'"
                                  + " WHERE task_id = '"
                                  + taskId
                                  + "'");
                      default -> throw new Failure("unknown refused-completion cause " + cause);
                    }
                    return Map.of("late", true);
                  })
              .build();
      check(subject.runOnce(), "the worker did not report the processed task");
    }
    check(handled.get() == 1, "the handler ran " + handled.get() + " times");
    check(
        cancels.equals(
            "cancellation".equals(cause) ? List.of(CancelStatus.CANCEL_REQUESTED) : List.of()),
        "cancel returned " + cancels);
    expectState(taskId, object(testCase, "expectedState"));
    String result =
        value(
            "SELECT outcome.result::text FROM workhorse.task task LEFT JOIN workhorse.task_outcome"
                + " outcome ON outcome.task_id = task.id WHERE task.id = '"
                + taskId
                + "'");
    check(result == null, "the stored result is " + result);
    expectOutcomes(taskId, (List<?>) testCase.get("expectedAttemptOutcomes"));
  }

  /** One durable write a handler may attempt after its lease is gone. */
  @FunctionalInterface
  private interface LateWrite {
    void run() throws Exception;
  }

  /** Each durable write a handler may attempt after its lease is gone, by its portable name. */
  private static Map<String, LateWrite> lateWrites(HandlerContext ctx) {
    Map<String, LateWrite> writes = new LinkedHashMap<>();
    writes.put(
        "checkpoint", () -> ctx.checkpoint("too-late", Object.class, () -> Map.of("late", true)));
    writes.put("sleep", () -> ctx.sleep("too-late", Duration.ofMillis(1)));
    writes.put("sleepUntil", () -> ctx.sleepUntil("too-late-until", Instant.now()));
    writes.put("waitForSignal", () -> ctx.waitForSignal("too-late", Object.class, null));
    writes.put(
        "waitForHuman",
        () -> ctx.waitForHuman("too-late", Map.of("late", true), Object.class, null));
    writes.put(
        "runChild",
        () ->
            ctx.runChild(
                "too-late", "protocol.child", Map.of(), EnqueueOptions.defaults(), Object.class));
    writes.put(
        "runChildren",
        () -> ctx.runChildren(List.of(ChildRequest.of("too-late", "protocol.child", Map.of()))));
    return writes;
  }

  /**
   * Each case throws the error a durable replay raises. A conflict is terminal, so the retry
   * callback never runs; a limit, an occupied wait, and a plain error retry once.
   */
  private void replayConflict(Map<String, @Nullable Object> fixture) throws Exception {
    for (Object item : (List<?>) fixture.get("cases")) {
      Map<String, @Nullable Object> entry = Runner.object(item, "case");
      String kind = String.valueOf(entry.get("errorKind"));
      String name = queueName(fixture) + "-" + kind;
      UUID taskId =
          enqueue(
              taskType(fixture),
              Map.of(),
              options(name).maxAttempts(Runner.intValue(fixture.get("maxAttempts"))));
      if (Boolean.TRUE.equals(entry.get("redactErrorDetails"))) {
        update(
            "UPDATE workhorse.task SET payload_redact_keys = ARRAY['secret'] WHERE id = '"
                + taskId
                + "'");
      }
      AtomicInteger delayCalls = new AtomicInteger();
      try (Intercept pool = new Intercept(opener, new Intercept.Hook() {})) {
        Worker subject =
            Worker.builder(pool)
                .queues(name)
                .workerId("jvm-" + name)
                .pollingOnly(true)
                .disableRegistry(true)
                .retryDelay(
                    (attempt, task) -> {
                      delayCalls.incrementAndGet();
                      return Duration.ofSeconds(60);
                    })
                .handle(
                    taskType(fixture),
                    Object.class,
                    (ctx, payload) -> {
                      if ("checkpoint-input".equals(kind)) {
                        // The second call replays the saved checkpoint with another input, so the
                        // SDK throws its own input conflict.
                        Callable<Object> saved = () -> Map.of("saved", true);
                        ctx.checkpoint(
                            "saved",
                            Object.class,
                            CheckpointOptions.input(Map.of("version", 1)),
                            saved);
                        ctx.checkpoint(
                            "saved",
                            Object.class,
                            CheckpointOptions.input(Map.of("version", 2)),
                            saved);
                        throw new IllegalStateException("the second checkpoint did not conflict");
                      }
                      throw switch (kind) {
                        case "checkpoint" -> new ConflictException("checkpoint", "saved");
                        // A conflict inside a plain wrapper is still terminal (SM-1512).
                        case "wrapped-checkpoint" ->
                            new RuntimeException(
                                "wrapped", new ConflictException("checkpoint", "saved"));
                        case "wait" -> new ConflictException("sleep", "saved");
                        case "child", "redacted-child" ->
                            new ConflictException("runChild", "saved");
                        case "child-set" -> new ConflictException("runChildren", "saved");
                        case "human" -> new ConflictException("waitForHuman", "saved");
                        case "child-limit" -> new LimitExceededException("runChild", "saved");
                        case "signal-wait" -> new AlreadyWaitingException("waitForSignal", "saved");
                        // The Java counterpart of the Ruby lane's StandardError.
                        case "transient" -> new Exception("transient");
                        default -> new IllegalStateException("unknown error kind " + kind);
                      };
                    })
                .build();
        check(subject.runOnce(), kind + ": the conflict handler did not run");
      }
      Map<String, @Nullable Object> expected = new LinkedHashMap<>();
      expected.put("state", entry.get("expectedState"));
      expected.put("attempt", entry.get("expectedAttempt"));
      expected.put(
          "errorName", Runner.object(entry.get("expectedErrorNames"), "names").get("java"));
      Map<String, @Nullable Object> actual = state(taskId);
      check(Matcher.same(expected, actual), kind + ": task state " + actual + ", want " + expected);
      boolean terminal = "failed".equals(entry.get("expectedState"));
      check(
          delayCalls.get() == (terminal ? 0 : 1),
          kind + ": the retry callback ran " + delayCalls.get() + " times");
      expectOutcomes(taskId, List.of(terminal ? "failed" : "retry"));
    }
  }

  private void expectStates(Map<String, UUID> taskIds, Map<String, @Nullable Object> expected) {
    expected.forEach(
        (key, want) -> expectState(taskIds.get(key), Runner.object(want, String.valueOf(key))));
  }

  /**
   * Commits a budgeted task on one queue while that queue's claim is already past its first read. A
   * test session parks the late claim on its queue's admission shards. Mirrors {@code
   * typescript/core/test/support/budget-race.ts}.
   */
  private void budgetRace(Map<String, @Nullable Object> fixture) throws Exception {
    String name = queueName(fixture);
    String lateQueue = name + "-late";
    String holderQueue = name + "-holder";
    Map<String, @Nullable Object> rate = object(fixture, "queueRate");
    String lease = String.valueOf(fixture.get("leaseMs"));
    queue.syncBudgets(
        name, List.of(new BudgetDefinition(name, Runner.intValue(fixture.get("maxActive")), null)));
    queue.syncRateLimitPolicies(
        name,
        List.of(
            new RateLimitPolicyDefinition(
                lateQueue,
                new RateLimit(
                    Math.toIntExact((Long) rate.get("limit")),
                    Duration.ofMillis((Long) rate.get("intervalMs")),
                    Math.toIntExact((Long) rate.get("burst"))))));
    // One unbudgeted start proves the late queue admits before the blocker parks its claim.
    enqueue(taskType(fixture), Map.of("role", "bucket"), options(lateQueue));
    int bucket =
        Sql.rows(connection, SqlCatalogue.CLAIM_V1, lateQueue, name + "-bucket", lease).size();
    check(bucket == 1, "the late queue did not admit its unbudgeted start");
    enqueue(taskType(fixture), Map.of("role", "holder"), options(holderQueue).budget(name));

    try (Connection blocker = opener.open();
        Connection late = opener.open();
        Connection holder = opener.open()) {
      long latePid;
      try (Statement statement = late.createStatement();
          ResultSet pid = statement.executeQuery("SELECT pg_backend_pid()")) {
        pid.next();
        latePid = pid.getLong(1);
      }
      CompletableFuture<Integer> lateClaim = null;
      try {
        blocker.setAutoCommit(false);
        try (Statement statement = blocker.createStatement()) {
          statement.execute(
              "SELECT pg_advisory_xact_lock(hashtextextended('workhorse:admission-shard:' || '"
                  + lateQueue.replace("'", "''")
                  + "' || ':' || shard, 0)) FROM generate_series(0, 7) AS shard");
        }
        lateClaim =
            CompletableFuture.supplyAsync(
                () ->
                    Sql.rows(late, SqlCatalogue.CLAIM_V1, lateQueue, name + "-late", lease).size());
        eventually(
            "the late claim never reached the admission shards", 10, () -> waitsOn(latePid, null));
        enqueue(taskType(fixture), Map.of("role", "late"), options(lateQueue).budget(name));
        holder.setAutoCommit(false);
        int holderClaims =
            Sql.rows(holder, SqlCatalogue.CLAIM_V1, holderQueue, name + "-holder", lease).size();
        blocker.commit();
        CompletableFuture<Integer> claim = lateClaim;
        eventually(
            "the late claim neither finished nor waited for the budget",
            10,
            () -> claim.isDone() || waitsOn(latePid, "advisory"));
        holder.commit();
        int lateClaims = lateClaim.get(10, TimeUnit.SECONDS);
        long active =
            Long.parseLong(
                value(
                    "SELECT count(*) FROM workhorse.task_runtime WHERE state = 'active' AND"
                        + " budget_name = '"
                        + name
                        + "'"));
        check(
            holderClaims == (Long) fixture.get("expectedHolderClaims"),
            "the holder claimed " + holderClaims);
        check(
            lateClaims == (Long) fixture.get("expectedLateClaims"),
            "the late claim admitted " + lateClaims);
        check(
            active == (Long) fixture.get("expectedActive"), active + " budgeted tasks are active");
      } finally {
        for (Connection session : List.of(blocker, holder)) {
          try {
            if (!session.getAutoCommit()) {
              session.rollback();
            }
          } catch (SQLException ignored) {
            // The session ends with the try block.
          }
        }
        if (lateClaim != null) {
          lateClaim.handle((value, error) -> value).get(10, TimeUnit.SECONDS);
        }
      }
    }
  }

  /**
   * The task stores the caller's W3C trace context at enqueue, and the handler span continues it.
   * The counterpart of Ruby's {@code trace}.
   */
  // The scope only makes the caller span current, so the try block never reads it.
  @SuppressWarnings("try")
  private void trace(Map<String, @Nullable Object> fixture) throws Exception {
    try (RecordingOpenTelemetry recording = new RecordingOpenTelemetry()) {
      WorkhorseTelemetry telemetry = WorkhorseTelemetry.of(recording.sdk());
      Queue traced =
          new Queue(
              Connections.borrowed(connection),
              QueueOptions.builder().telemetry(telemetry).build());
      Span caller = recording.sdk().getTracer("caller").spanBuilder("caller").startSpan();
      UUID taskId;
      try (Scope ignored = caller.makeCurrent()) {
        synchronized (connection) {
          taskId =
              traced
                  .enqueue(taskType(fixture), Map.of(), options(queueName(fixture)).build())
                  .taskId();
        }
      } finally {
        caller.end();
      }
      Object stored =
          Json.parse(
              String.valueOf(
                  value(
                      "SELECT COALESCE(trace_context::text, 'null') FROM workhorse.task WHERE id = '"
                          + taskId
                          + "'")));
      String traceparent =
          stored instanceof Map<?, ?> carrier ? String.valueOf(carrier.get("traceparent")) : "";
      String[] parts = traceparent.split("-", -1);
      check(
          parts.length == 4 && parts[1].equals(caller.getSpanContext().getTraceId()),
          "enqueue stored no caller trace context");
      try (Intercept pool = new Intercept(opener, new Intercept.Hook() {})) {
        check(
            worker(pool, fixture)
                .telemetry(telemetry)
                .handle(taskType(fixture), Object.class, (ctx, payload) -> null)
                .build()
                .runOnce(),
            "the worker did not run the traced task");
      }
      List<SpanData> handlers = recording.spans("workhorse.handler");
      check(handlers.size() == 1, "recorded " + handlers.size() + " handler spans, want 1");
      SpanData handler = handlers.get(0);
      check(
          handler.getTraceId().equals(caller.getSpanContext().getTraceId()),
          "the handler span left the enqueuing trace");
      check(
          handler.getParentSpanId().equals(parts[2]),
          "the handler span's parent is not the stored context");
    }
  }

  private void missingHandler(Map<String, @Nullable Object> fixture) throws Exception {
    String name = queueName(fixture);
    UUID taskId = enqueue(taskType(fixture), Map.of("index", 1), options(name));
    List<@Nullable Object> handled = new CopyOnWriteArrayList<>();
    try (Intercept pool = new Intercept(opener, new Intercept.Hook() {})) {
      Worker older =
          Worker.builder(pool)
              .queues(name)
              .workerId("jvm-" + fixture.get("id") + "-older")
              .pollingOnly(true)
              .disableRegistry(true)
              .lease(millis(fixture, "leaseMs"))
              .pollInterval(millis(fixture, "pollMs"))
              .handle(
                  (String) fixture.get("registeredTaskType"), Object.class, (ctx, payload) -> null)
              .build();
      // A pass that released each task that it claimed made no progress, so it returns false.
      boolean processed = !"unprocessed".equals(fixture.get("expectedReleasedPassOutcome"));
      check(older.runOnce() == processed, "the released-only pass reported progress");
      expectState(taskId, object(fixture, "expectedAfterRelease"));
      // The refusal belongs to no attempt, so the task keeps the attempt it was enqueued with.
      check(
          attempts(taskId) == (Long) fixture.get("expectedAttempts"),
          "the release recorded " + attempts(taskId) + " attempts");
      check(
          releases(taskId) == (Long) fixture.get("expectedReleaseEvents"),
          "the release recorded " + releases(taskId) + " events");
      // The worker keeps no state between calls. The next call claims the ready task again at
      // once, inside the poll interval, releases it, and returns false again.
      check(older.runOnce() == processed, "the pass after the release reported progress");
      check(
          attempts(taskId) == (Long) fixture.get("expectedAttempts"),
          "the next pass recorded " + attempts(taskId) + " attempts");
      check(
          releases(taskId) == (Long) fixture.get("expectedReleaseEventsAfterNextPass"),
          "after the next pass the task had " + releases(taskId) + " release events");
      expectState(taskId, object(fixture, "expectedAfterRelease"));

      Worker newer =
          Worker.builder(pool)
              .queues(name)
              .workerId("jvm-" + fixture.get("id") + "-newer")
              .pollingOnly(true)
              .disableRegistry(true)
              .lease(millis(fixture, "leaseMs"))
              .handle(
                  taskType(fixture),
                  Object.class,
                  (ctx, payload) -> {
                    handled.add(payload);
                    return null;
                  })
              .build();
      check(newer.runOnce(), "the registered worker did not run the task");
    }
    check(Matcher.same(handled, List.of(Map.of("index", 1L))), "the handler received " + handled);
    expectState(taskId, object(fixture, "expectedAfterHandled"));
  }

  /**
   * Runs a listening worker that has no handler for the one ready task. Each release wakes the
   * worker, so the gap between two releases shows its bound.
   */
  private void releaseWait(Map<String, @Nullable Object> fixture) throws Exception {
    String name = queueName(fixture);
    UUID taskId = enqueue(taskType(fixture), Map.of(), options(name));
    long listeners;
    try (Intercept pool = new Intercept(opener, new Intercept.Hook() {})) {
      Worker subject =
          Worker.builder(pool)
              .queues(name)
              .workerId("jvm-" + fixture.get("id"))
              .disableRegistry(true)
              .lease(millis(fixture, "leaseMs"))
              .pollInterval(millis(fixture, "pollMs"))
              .shutdownGrace(JOIN_GRACE)
              .handle(
                  (String) fixture.get("registeredTaskType"), Object.class, (ctx, payload) -> null)
              .build();
      CompletableFuture<Void> run = running(subject, subject::run);
      try {
        Thread.sleep((Long) fixture.get("runMs"));
        // Without a listener, the worker gets no notification, and the fixture proves nothing.
        listeners =
            Long.parseLong(
                value(
                    "SELECT count(*) FROM pg_stat_activity WHERE datname = current_database() AND"
                        + " query = 'LISTEN workhorse_tasks'"));
      } finally {
        subject.stop();
      }
      run.get(RUN_WAIT_SECONDS, TimeUnit.SECONDS);
    }
    check(listeners > 0, "no session listened while the worker ran");
    List<Double> times = new ArrayList<>();
    for (Map<String, @Nullable Object> row :
        Runner.sql(
            connection,
            "SELECT (extract(epoch FROM occurred_at) * 1000)::float8 AS at_ms FROM"
                + " workhorse.task_event WHERE task_id = '"
                + taskId
                + "' AND event_type = 'released' ORDER BY occurred_at")) {
      times.add((Double) row.get("at_ms"));
    }
    check(
        times.size() >= (Long) fixture.get("expectedMinimumReleases")
            && times.size() <= (Long) fixture.get("expectedMaximumReleases"),
        "the worker released the task " + times.size() + " times while it ran");
    for (int index = 1; index < times.size(); index++) {
      double gap = times.get(index) - times.get(index - 1);
      check(
          gap >= (Long) fixture.get("expectedMinimumReleaseGapMs"),
          "the worker released the task again after " + Math.round(gap) + " ms");
    }
  }

  /** The shortest wait at the notification base: 5 s less its jitter of 10 %. */
  private static final long NOTIFICATION_WAIT_MINIMUM_NANOS = TimeUnit.MILLISECONDS.toNanos(4_500);

  /**
   * The longest wait at the polling-only base after the backoff restarts is 275 ms. A worker that
   * makes no claim for this time after an empty claim waits at the notification base.
   */
  private static final long QUIET_BEFORE_LOSS_NANOS = TimeUnit.SECONDS.toNanos(1);

  /**
   * Runs a worker that can listen, but holds its {@code LISTEN} until the first task ran. Without a
   * live subscription, the worker polls at the polling-only base. With one, it waits for the
   * notification poll interval after each empty claim. When the runner ends the listener session,
   * the loss wakes the worker, and it polls at the polling-only base again.
   *
   * <p>The bounds after the loss start at events that the runner controls, not at the moment the
   * runner sees them. A loaded runner sees an event late, and the worker's backoff grows in that
   * time. A late observation would thus charge the runner's delay to the worker.
   */
  private void subscriptionRecovery(Map<String, @Nullable Object> fixture) throws Exception {
    String name = queueName(fixture);
    AtomicReference<CountDownLatch> listenGate = new AtomicReference<>(new CountDownLatch(1));
    // The backend pid of the connection that ran the last LISTEN.
    AtomicInteger listenerPid = new AtomicInteger();
    AtomicBoolean recording = new AtomicBoolean(true);
    // Each claim_many_v1 call's start, its return to the worker, and whether it found a task.
    List<long[]> claims = Collections.synchronizedList(new ArrayList<>());
    Map<Intercept.Call, Long> starts =
        Collections.synchronizedMap(new java.util.IdentityHashMap<>());
    List<String> handled = new CopyOnWriteArrayList<>();
    int recoveryEnd = 0;
    long lostAt = 0;
    long enqueuedAfterLoss = 0;
    // The runner can hold the first empty claim that starts at or after holdFrom. The hook records
    // that claim, counts down reached, and returns it to the worker only after released.
    AtomicLong holdFrom = new AtomicLong(Long.MAX_VALUE);
    CountDownLatch reached = new CountDownLatch(1);
    CountDownLatch released = new CountDownLatch(1);
    Intercept.Hook hook =
        new Intercept.Hook() {
          @Override
          public void before(Intercept.Call call) {
            if (call.is(SqlCatalogue.CLAIM_MANY_V1)) {
              starts.put(call, System.nanoTime());
            }
          }

          @Override
          public void after(Intercept.Call call) throws InterruptedException {
            if (!call.is(SqlCatalogue.CLAIM_MANY_V1)) {
              return;
            }
            Long start = starts.remove(call);
            long started = start == null ? 0 : start;
            if (recording.get()) {
              claims.add(new long[] {started, System.nanoTime(), call.rows()});
            }
            long from = holdFrom.get();
            if (call.rows() == 0
                && started >= from
                && holdFrom.compareAndSet(from, Long.MAX_VALUE)) {
              reached.countDown();
              if (!released.await(15, TimeUnit.SECONDS)) {
                throw new IllegalStateException("the held claim was never released");
              }
            }
          }
        };
    try (Intercept pool = new Intercept(opener, hook)) {
      Worker subject =
          Worker.builder(holdingListen(pool, listenGate, listenerPid))
              .queues(name)
              .workerId("jvm-" + fixture.get("id"))
              .disableRegistry(true)
              .shutdownGrace(JOIN_GRACE)
              .handle(
                  taskType(fixture),
                  Object.class,
                  (ctx, payload) -> {
                    handled.add(String.valueOf(((Map<?, ?>) payload).get("task")));
                    return null;
                  })
              .build();
      CompletableFuture<Void> run = running(subject, subject::run);
      try {
        eventually(
            "the worker made no empty claim before the first enqueue",
            5,
            () -> {
              synchronized (claims) {
                return claims.stream().anyMatch(claim -> claim[2] == 0);
              }
            });
        enqueue(taskType(fixture), Map.of("task", "first"), options(name));
        eventually("the worker did not run the first task", 5, () -> handled.size() == 1);

        listenGate.get().countDown();
        eventually(
            "the listener did not run LISTEN",
            5,
            () ->
                Long.parseLong(
                        Objects.requireNonNull(
                            value(
                                "SELECT count(*) FROM pg_stat_activity WHERE datname ="
                                    + " current_database() AND query = 'LISTEN workhorse_tasks'"
                                    + " AND state = 'idle'")))
                    > 0);
        enqueue(taskType(fixture), Map.of("task", "second"), options(name));
        eventually("the worker did not run the second task", 7, () -> handled.size() == 2);
        Thread.sleep((Long) fixture.get("observeAfterRecoveryMs"));
        recoveryEnd = claims.size();

        // The next empty claim starts a new wait at the notification base. Then the runner ends the
        // live listener session and holds the next LISTEN, so the subscription is lost. The wait
        // is internal to the worker. Thus the runner first waits until the worker has made no claim
        // for QUIET_BEFORE_LOSS_NANOS after an empty claim. A loss before the worker chose its wait
        // gives the polling base without a wake.
        int afterRecovery = recoveryEnd;
        eventually(
            "the worker made no empty claim after the second task",
            7,
            () -> {
              synchronized (claims) {
                return claims.subList(afterRecovery, claims.size()).stream()
                    .anyMatch(claim -> claim[2] == 0);
              }
            });
        eventually(
            "the worker did not wait at the notification base after the second task",
            7,
            () -> {
              synchronized (claims) {
                long[] last = claims.get(claims.size() - 1);
                return last[2] == 0 && System.nanoTime() - last[1] >= QUIET_BEFORE_LOSS_NANOS;
              }
            });
        listenGate.set(new CountDownLatch(1));
        int pid = listenerPid.get();
        check(pid != 0, "the runner did not see the pid of the listener session");
        // The loss starts when the runner ends the session. The hook holds the first empty claim
        // after that moment, which is the claim that the loss wakes. The worker thus cannot advance
        // its backoff before the runner enqueues the third task.
        lostAt = System.nanoTime();
        holdFrom.set(lostAt);
        value("SELECT pg_terminate_backend(" + pid + ")::text");
        eventually(
            "the worker made no claim after the subscription was lost",
            7,
            () -> reached.getCount() == 0);
        enqueuedAfterLoss = System.nanoTime();
        enqueue(taskType(fixture), Map.of("task", "third"), options(name));
        released.countDown();
        eventually("the worker did not run the third task", 7, () -> handled.size() == 3);
      } finally {
        recording.set(false);
        released.countDown();
        listenGate.get().countDown();
        subject.stop();
        run.get(RUN_WAIT_SECONDS, TimeUnit.SECONDS);
      }
    }
    List<long[]> ordered;
    synchronized (claims) {
      ordered = new ArrayList<>(claims);
    }
    ordered.sort((left, right) -> Long.compare(left[0], right[0]));
    List<Integer> found = new ArrayList<>();
    for (int index = 0; index < ordered.size(); index++) {
      if (ordered.get(index)[2] > 0) {
        found.add(index);
      }
    }
    check(found.size() == 3, found.size() + " claims found a task, want 3");
    int first = found.get(0);
    check(first > 0, "no empty claim came before the first task");
    long waited = TimeUnit.NANOSECONDS.toMillis(ordered.get(first)[0] - ordered.get(first - 1)[1]);
    long maximum = (Long) fixture.get("expectedMaximumClaimDelayMs");
    check(
        waited <= maximum,
        "without a live subscription, the claim of the first task waited "
            + waited
            + " ms, want at most "
            + maximum
            + " ms");
    // With a live subscription, the worker waits the notification base after an empty claim.
    List<long[]> recovered;
    synchronized (claims) {
      recovered = new ArrayList<>(claims.subList(0, recoveryEnd));
    }
    recovered.sort((left, right) -> Long.compare(left[0], right[0]));
    int lastFound = 0;
    for (int index = 0; index < recovered.size(); index++) {
      if (recovered.get(index)[2] > 0) {
        lastFound = index;
      }
    }
    long empty =
        recovered.subList(lastFound, recovered.size()).stream().filter(c -> c[2] == 0).count();
    long allowed = (Long) fixture.get("expectedMaximumEmptyClaimsAfterRecovery");
    check(
        empty <= allowed,
        "with a live subscription, "
            + empty
            + " empty claims followed the second task, want at most "
            + allowed);
    // After the loss, the worker claims at once and then polls at the polling-only base again.
    long lossMaximum = (Long) fixture.get("expectedMaximumClaimDelayAfterLossMs");
    int woken = -1;
    for (int index = 0; index < ordered.size() && woken < 0; index++) {
      if (ordered.get(index)[0] >= lostAt) {
        woken = index;
      }
    }
    check(woken > 0, "no claim after the subscription was lost had a claim before it");
    long afterLoss = TimeUnit.NANOSECONDS.toMillis(ordered.get(woken)[0] - lostAt);
    check(
        afterLoss <= lossMaximum,
        "after the subscription was lost, the first claim waited "
            + afterLoss
            + " ms, want at most "
            + lossMaximum
            + " ms");
    // The claim before the woken one found no task. The worker made no claim for
    // QUIET_BEFORE_LOSS_NANOS after it, so it waited at the notification base. The woken claim
    // started before the shortest wait at that base ended, so the loss started it.
    long[] before = ordered.get(woken - 1);
    check(
        before[2] == 0 && lostAt - before[1] >= QUIET_BEFORE_LOSS_NANOS,
        "the claim before the loss returned "
            + TimeUnit.NANOSECONDS.toMillis(lostAt - before[1])
            + " ms before it, want an empty claim at least "
            + TimeUnit.NANOSECONDS.toMillis(QUIET_BEFORE_LOSS_NANOS)
            + " ms before");
    check(
        ordered.get(woken)[0] - before[1] < NOTIFICATION_WAIT_MINIMUM_NANOS,
        "the first claim after the subscription was lost started "
            + TimeUnit.NANOSECONDS.toMillis(ordered.get(woken)[0] - before[1])
            + " ms after the claim before it, so the wait at the notification base, not the loss,"
            + " started it");
    long third = TimeUnit.NANOSECONDS.toMillis(ordered.get(found.get(2))[0] - enqueuedAfterLoss);
    check(
        third <= lossMaximum,
        "after the subscription was lost, the claim of the third task waited "
            + third
            + " ms, want at most "
            + lossMaximum
            + " ms");
  }

  /**
   * A data source over {@code pool} whose plain statements hold {@code LISTEN workhorse_tasks}
   * until the current latch of {@code gate} opens. Until then the worker has no live subscription.
   * The runner can set a new latch to hold the next {@code LISTEN}. {@code pid} receives the
   * backend pid of the connection that runs the {@code LISTEN}. {@link Intercept} sees only
   * prepared statements, and the listener runs a plain one.
   */
  private static DataSource holdingListen(
      Intercept pool, AtomicReference<CountDownLatch> gate, AtomicInteger pid) {
    return proxy(
        DataSource.class,
        (proxy, method, arguments) -> {
          Object result = invoke(pool, method, arguments);
          return result instanceof Connection connection
              ? proxy(
                  Connection.class,
                  (connectionProxy, connectionMethod, connectionArguments) -> {
                    Object made = invoke(connection, connectionMethod, connectionArguments);
                    return made instanceof Statement statement
                            && connectionMethod.getName().equals("createStatement")
                        ? proxy(
                            Statement.class,
                            (statementProxy, statementMethod, statementArguments) -> {
                              if (statementMethod.getName().equals("execute")
                                  && statementArguments != null
                                  && "LISTEN workhorse_tasks".equals(statementArguments[0])) {
                                gate.get().await();
                                pid.set(connection.unwrap(PGConnection.class).getBackendPID());
                              }
                              return invoke(statement, statementMethod, statementArguments);
                            })
                        : made;
                  })
              : result;
        });
  }

  private static @Nullable Object invoke(
      Object target, Method method, @Nullable Object @Nullable [] arguments) throws Throwable {
    try {
      return method.invoke(target, arguments);
    } catch (InvocationTargetException error) {
      throw error.getCause();
    }
  }

  private static <T> T proxy(Class<T> type, InvocationHandler handler) {
    return type.cast(
        Proxy.newProxyInstance(
            RuntimeFixtures.class.getClassLoader(), new Class<?>[] {type}, handler));
  }

  private void jsonRoundTrip(Map<String, @Nullable Object> fixture) throws Exception {
    Object payload = fixture.get("payload");
    UUID taskId = enqueue(taskType(fixture), payload, options(queueName(fixture)));
    List<@Nullable Object> received = new CopyOnWriteArrayList<>();
    try (Intercept pool = new Intercept(opener, new Intercept.Hook() {})) {
      Worker subject =
          worker(pool, fixture)
              .handle(
                  taskType(fixture),
                  Object.class,
                  (ctx, handled) -> {
                    received.add(handled);
                    return handled;
                  })
              .build();
      check(subject.runOnce(), "the worker did not run the task");
    }
    check(
        received.size() == 1 && exact(received.get(0), payload),
        "the handler received " + Matcher.render(received));
    Object stored =
        Json.parse(value("SELECT payload::text FROM workhorse.task WHERE id = '" + taskId + "'"));
    check(exact(stored, payload), "the stored payload is " + Matcher.render(stored));
    Object result =
        Json.parse(
            value(
                "SELECT result::text FROM workhorse.task_outcome WHERE task_id = '"
                    + taskId
                    + "'"));
    check(exact(result, payload), "the stored result is " + Matcher.render(result));
    expectState(taskId, object(fixture, "expectedState"));
    expectOutcomes(taskId, List.of(fixture.get("expectedAttemptOutcome")));
  }

  /**
   * The handler returns an array of zeros, whose {@code jsonb} text is longer than its compact
   * JSON. One pass may also run the immediate retry, so the runner passes until the task settles.
   */
  private void oversizedResult(Map<String, @Nullable Object> fixture) throws Exception {
    String name = queueName(fixture);
    if ("fast".equals(fixture.get("tier"))) {
      synchronized (connection) {
        Sql.rows(
            connection,
            SqlCatalogue.SET_QUEUE_TIER_V1,
            name,
            "fast",
            "runtime-fixture",
            String.valueOf(fixture.get("id")));
      }
    }
    int maxAttempts = Math.toIntExact((Long) fixture.get("maxAttempts"));
    UUID taskId =
        enqueue(
            taskType(fixture),
            fixture.get("oversizedZeros"),
            options(name)
                .maxAttempts(maxAttempts)
                .retryPolicy(Map.of("type", "fixed", "delayMs", 0)));
    Map<String, @Nullable Object> settled = object(fixture, "expectedSettled");
    Object errorName = object(fixture, "expectedErrorNames").get("java");
    try (Intercept pool = new Intercept(opener, new Intercept.Hook() {})) {
      Handler<Object> zeros =
          (ctx, count) -> Collections.nCopies(Math.toIntExact((Long) count), 0L);
      Worker subject = worker(pool, fixture).handle(taskType(fixture), Object.class, zeros).build();
      for (int attempt = 0; attempt < maxAttempts; attempt++) {
        if (Matcher.same(state(taskId).get("state"), settled.get("state"))) {
          break;
        }
        check(subject.runOnce(), "the worker did not run the oversized task");
      }
      Map<String, @Nullable Object> task = state(taskId);
      check(
          Matcher.same(task.get("state"), settled.get("state"))
              && Matcher.same(task.get("attempt"), settled.get("attempt"))
              && Matcher.same(task.get("errorName"), errorName),
          "the oversized task is "
              + task.get("state")
              + "/"
              + task.get("attempt")
              + " with error "
              + task.get("errorName")
              + ", want "
              + settled.get("state")
              + "/"
              + settled.get("attempt")
              + " with "
              + errorName);
      UUID fittingId = enqueue(taskType(fixture), fixture.get("fittingZeros"), options(name));
      check(subject.runOnce(), "the worker did not run the fitting task");
      Map<String, @Nullable Object> fitting = state(fittingId);
      Map<String, @Nullable Object> expected = object(fixture, "expectedFitting");
      check(
          Matcher.same(fitting.get("state"), expected.get("state"))
              && Matcher.same(fitting.get("attempt"), expected.get("attempt")),
          "the fitting task is "
              + fitting.get("state")
              + "/"
              + fitting.get("attempt")
              + ": "
              + fitting.get("errorName"));
    }
  }

  /**
   * One batch handler receives every task, highest priority first. Each member settles on its own:
   * one succeeds, one retries, and one fails. The handler pauses the worker, so the first pass ends
   * after one batch, and the second pass runs the retry.
   */
  private void batch(Map<String, @Nullable Object> fixture) throws Exception {
    String name = queueName(fixture);
    Map<String, UUID> taskIds = new LinkedHashMap<>();
    for (Object entry : (List<?>) fixture.get("tasks")) {
      Map<String, @Nullable Object> task = Runner.object(entry, "task");
      String key = String.valueOf(task.get("key"));
      Map<String, @Nullable Object> payload = new LinkedHashMap<>();
      payload.put("key", key);
      payload.put("outcome", task.get("outcome"));
      taskIds.put(
          key,
          enqueue(
              taskType(fixture),
              payload,
              options(name)
                  .priority(Runner.intValue(task.get("priority")))
                  .maxAttempts(Runner.intValue(task.get("maxAttempts")))
                  .retryPolicy(Map.of("type", "fixed", "delayMs", 0))));
    }
    List<String> seen = new CopyOnWriteArrayList<>();
    AtomicReference<@Nullable Worker> holder = new AtomicReference<>();
    BatchHandler<Object> handler =
        items -> {
          Worker subject = holder.get();
          if (subject != null) {
            subject.pause();
          }
          List<BatchHandlerOutcome> outcomes = new ArrayList<>();
          for (BatchHandlerItem<Object> item : items) {
            Map<String, @Nullable Object> payload = Runner.object(item.payload(), "payload");
            seen.add(String.valueOf(payload.get("key")));
            int attempt = item.context().task().attempt();
            if ("succeed".equals(payload.get("outcome")) || attempt > 1) {
              outcomes.add(new BatchSucceeded(Map.of("attempt", attempt)));
            } else {
              outcomes.add(
                  new BatchFailed(
                      new IllegalStateException(
                          payload.get("outcome") + " on attempt " + attempt)));
            }
          }
          return outcomes;
        };
    try (Intercept pool = new Intercept(opener, new Intercept.Hook() {})) {
      Worker subject =
          worker(pool, fixture)
              .concurrency(Math.toIntExact((Long) fixture.get("concurrency")))
              .handleBatch(
                  taskType(fixture),
                  Object.class,
                  new BatchOptions(
                      Math.toIntExact((Long) fixture.get("batchMaxSize")), Duration.ofMillis(100)),
                  handler)
              .build();
      holder.set(subject);
      check(subject.runOnce(), "the first run delivered no batch");
      check(
          Matcher.same(seen, fixture.get("expectedHandlerOrder")),
          "handler order " + seen + ", want " + fixture.get("expectedHandlerOrder"));
      batchStates(taskIds, object(fixture, "expectedAfterFirstRun"), "first");
      subject.resume();
      check(subject.runOnce(), "the second run delivered no batch");
      batchStates(taskIds, object(fixture, "expectedAfterSecondRun"), "second");
    }
  }

  private void batchStates(
      Map<String, UUID> taskIds, Map<String, @Nullable Object> expected, String run) {
    for (Map.Entry<String, @Nullable Object> entry : expected.entrySet()) {
      Map<String, @Nullable Object> want = Runner.object(entry.getValue(), "state");
      UUID taskId = taskIds.get(entry.getKey());
      check(taskId != null, "the fixture names no task " + entry.getKey());
      Map<String, @Nullable Object> actual = state(taskId);
      check(
          Matcher.same(want.get("state"), actual.get("state"))
              && Matcher.same(want.get("attempt"), actual.get("attempt")),
          "after the " + run + " run " + entry.getKey() + " is " + actual + ", want " + want);
    }
  }

  /**
   * The handler waits for its cancellation. With an {@code error} handler result it then throws
   * {@code CancelledException(SHUTDOWN)} through {@code throwIfCancelled}; with a {@code value} one
   * it returns a value. One attempt makes a charged attempt fail the task for good.
   */
  private void shutdownCancellation(Map<String, @Nullable Object> fixture) throws Exception {
    check(
        "cancel".equals(object(fixture, "shutdownBehavior").get("java")),
        "the fixture does not expect a cancelling Java worker");
    UUID taskId =
        enqueue(
            taskType(fixture),
            Map.of(),
            options(queueName(fixture)).maxAttempts(Runner.intValue(fixture.get("maxAttempts"))));
    CountDownLatch started = new CountDownLatch(1);
    List<@Nullable CancellationReason> reasons = new CopyOnWriteArrayList<>();
    try (Intercept pool = new Intercept(opener, new Intercept.Hook() {})) {
      Worker subject =
          worker(pool, fixture)
              .shutdownGrace(millis(fixture, "shutdownGraceMs"))
              .handle(
                  taskType(fixture),
                  Object.class,
                  (ctx, payload) -> {
                    started.countDown();
                    try {
                      if (!ctx.cancellation().await(Duration.ofSeconds(5))) {
                        throw new IllegalStateException("the shutdown never reached the handler");
                      }
                    } catch (InterruptedException interrupted) {
                      // At the grace deadline the worker cancels the token with SHUTDOWN and then
                      // interrupts the handler thread, so the wait can end with the interrupt.
                    }
                    reasons.add(ctx.cancellation().reason());
                    if ("error".equals(fixture.get("handlerResult"))) {
                      ctx.cancellation().throwIfCancelled();
                    }
                    return Map.of("finished", true);
                  })
              .build();
      CompletableFuture<Void> run = running(subject, subject::run);
      check(started.await(5, TimeUnit.SECONDS), "the handler never started");
      subject.stop();
      join(run);
    }
    check(
        reasons.equals(List.of(CancellationReason.SHUTDOWN)),
        "the handler saw cancellation reasons " + reasons);
    Map<String, @Nullable Object> expected = object(fixture, "expectedCancelled");
    Map<String, @Nullable Object> actual = state(taskId);
    check(
        Matcher.same(actual.get("state"), expected.get("state"))
            && Matcher.same(actual.get("attempt"), expected.get("attempt")),
        "the stopped task is "
            + actual.get("state")
            + "/"
            + actual.get("attempt")
            + ", want "
            + expected.get("state")
            + "/"
            + expected.get("attempt"));
    List<@Nullable Object> events = new ArrayList<>();
    Runner.sql(
            connection,
            "SELECT event_type FROM workhorse.task_event WHERE task_id = '"
                + taskId
                + "' ORDER BY occurred_at, event_id")
        .forEach(row -> events.add(row.get("event_type")));
    check(
        Matcher.same(events, expected.get("events")),
        "the stopped task recorded events " + events + ", want " + expected.get("events"));
  }

  private void heartbeatFailure(Map<String, @Nullable Object> fixture) throws Exception {
    UUID taskId = enqueue(taskType(fixture), Map.of(), options(queueName(fixture)));
    CountDownLatch started = new CountDownLatch(1);
    CountDownLatch release = new CountDownLatch(1);
    AtomicInteger cancellations = new AtomicInteger();
    long timeout = (Long) fixture.get("renewalTimeoutMs") / 1000;
    try (Intercept pool = new Intercept(opener, new Intercept.Hook() {})) {
      Worker subject =
          worker(pool, fixture)
              .lease(millis(fixture, "leaseMs"))
              .heartbeat(millis(fixture, "heartbeatMs"))
              .handle(
                  taskType(fixture),
                  Object.class,
                  (ctx, payload) -> {
                    started.countDown();
                    if (!release.await(10, TimeUnit.SECONDS)) {
                      throw new IllegalStateException("the handler was never released");
                    }
                    if (ctx.isCancelled()) {
                      cancellations.incrementAndGet();
                    }
                    return null;
                  })
              .build();
      CompletableFuture<Boolean> result = running(subject, subject::runOnce);
      try {
        check(started.await(5, TimeUnit.SECONDS), "the handler never started");
        Instant renewed = renewal(taskId, expiry(taskId), timeout);
        long minimum = (Long) fixture.get("expectedMinimumFailedRounds");
        AtomicReference<Instant> during = new AtomicReference<>(renewed);
        injected(
            object(fixture, "injection"),
            failedCalls -> {
              eventually(
                  "fewer than " + minimum + " heartbeat rounds failed",
                  timeout,
                  () -> failedCalls.getAsLong() >= minimum);
              during.set(expiry(taskId));
            });
        // Once the rounds answer again the lease renews, so the failures cost the attempt nothing.
        renewal(taskId, during.get(), timeout);
        release.countDown();
        check(join(result), "the worker did not run the task");
      } finally {
        release.countDown();
        result.handle((value, error) -> value).get(10, TimeUnit.SECONDS);
      }
    }
    check(
        cancellations.get() == (Long) fixture.get("expectedCancellations"),
        "the handler saw a cancellation");
    expectState(taskId, object(fixture, "expectedState"));
    expectOutcomes(taskId, List.of(fixture.get("expectedAttemptOutcome")));
  }

  /**
   * Busy heartbeat rounds renew nothing, and the worker retries only the busy lease sooner than the
   * next regular round. The injected function answers {@code busy} for its first calls and records
   * each one, then hands every call to the real function, which renews the lease.
   */
  private void heartbeatBusy(Map<String, @Nullable Object> fixture) throws Exception {
    UUID taskId = enqueue(taskType(fixture), Map.of(), options(queueName(fixture)));
    CountDownLatch started = new CountDownLatch(1);
    CountDownLatch release = new CountDownLatch(1);
    AtomicInteger cancellations = new AtomicInteger();
    long timeout = (Long) fixture.get("renewalTimeoutMs") / 1000;
    long expected = (Long) fixture.get("expectedBusyRounds");
    Map<String, @Nullable Object> injection = object(fixture, "injection");
    List<Map<String, @Nullable Object>> rounds = new ArrayList<>();
    try (Intercept pool = new Intercept(opener, new Intercept.Hook() {})) {
      Worker subject =
          worker(pool, fixture)
              .lease(millis(fixture, "leaseMs"))
              .heartbeat(millis(fixture, "heartbeatMs"))
              .handle(
                  taskType(fixture),
                  Object.class,
                  (ctx, payload) -> {
                    started.countDown();
                    if (!release.await(30, TimeUnit.SECONDS)) {
                      throw new IllegalStateException("the handler was never released");
                    }
                    if (ctx.isCancelled()) {
                      cancellations.incrementAndGet();
                    }
                    return null;
                  })
              .build();
      CompletableFuture<Boolean> result = running(subject, subject::runOnce);
      try {
        check(started.await(5, TimeUnit.SECONDS), "the handler never started");
        renewal(taskId, expiry(taskId), timeout);
        injectedBody(
            injection,
            () -> {
              String query = (String) injection.get("roundsQuery");
              eventually(
                  "fewer than " + expected + " busy heartbeat rounds ran",
                  timeout,
                  () -> {
                    List<Map<String, @Nullable Object>> current;
                    synchronized (connection) {
                      current = Runner.sql(connection, query);
                    }
                    rounds.clear();
                    rounds.addAll(current);
                    return rounds.size() >= expected;
                  });
              // The busy rounds renewed nothing. The next round reaches the real function.
              renewal(taskId, expiry(taskId), timeout);
            });
        release.countDown();
        check(join(result), "the worker did not run the task");
      } finally {
        release.countDown();
        result.handle((value, error) -> value).get(10, TimeUnit.SECONDS);
      }
    }
    List<Map<String, @Nullable Object>> busy = rounds.subList(0, (int) expected);
    double maximumGap = ((Number) fixture.get("maximumRetryGapMs")).doubleValue();
    for (int index = 0; index < busy.size(); index++) {
      long leases = ((Number) busy.get(index).get("lease_count")).longValue();
      check(leases == 1, "busy round " + index + " sent " + leases + " leases, want 1");
      if (index > 0) {
        double gap =
            ((Number) busy.get(index).get("round_at_ms")).doubleValue()
                - ((Number) busy.get(index - 1).get("round_at_ms")).doubleValue();
        check(
            gap < maximumGap,
            "busy round " + index + " came " + gap + " ms after the previous one");
      }
    }
    check(
        cancellations.get() == (Long) fixture.get("expectedCancellations"),
        "the handler saw a cancellation");
    expectState(taskId, object(fixture, "expectedState"));
    expectOutcomes(taskId, List.of(fixture.get("expectedAttemptOutcome")));
  }

  private void maintenancePhaseError(Map<String, @Nullable Object> fixture) throws Exception {
    Map<String, @Nullable Object> injection = object(fixture, "injection");
    // tick_v1 returns a phase failure as data, so a raising promote_v1 models a lock timeout
    // inside the promote phase.
    injected(
        injection,
        failedCalls -> {
          UUID taskId = enqueue(taskType(fixture), Map.of(), options(queueName(fixture)));
          List<List<Map<String, @Nullable Object>>> ticks = new CopyOnWriteArrayList<>();
          Intercept.Hook hook =
              new Intercept.Hook() {
                @Override
                public void after(Intercept.Call call) {
                  if (call.is(SqlCatalogue.TICK_V1)) {
                    ticks.add(call.read());
                  }
                }
              };
          try (Intercept pool = new Intercept(opener, hook)) {
            Worker subject =
                worker(pool, fixture)
                    // The first pass is due at once. A long interval keeps a slow pass from
                    // starting a second tick, so the pass runs exactly the failing one.
                    .maintenanceInterval(Duration.ofMinutes(1))
                    .handle(taskType(fixture), Object.class, (ctx, payload) -> null)
                    .build();
            // The failing phase runs on this pass, and the pass still claims and settles the task.
            check(subject.runOnce(), "the worker did not run the task");
          }
          check(ticks.size() == 1, "the worker ran " + ticks.size() + " ticks, want 1");
          Object error = null;
          for (Map<String, @Nullable Object> row : ticks.get(0)) {
            if (Matcher.same(row.get("phase"), fixture.get("expectedPhase"))) {
              error = row.get("error");
            }
          }
          check(
              String.valueOf(error).contains((String) injection.get("message")),
              "the worker's tick reported " + Matcher.render(error));
          expectState(taskId, object(fixture, "expectedState"));
        });
  }

  // ----- support -------------------------------------------------------------------------------

  private static String queueName(Map<String, @Nullable Object> fixture) {
    return "runtime-" + fixture.get("id");
  }

  private static String taskType(Map<String, @Nullable Object> fixture) {
    return (String) fixture.get("taskType");
  }

  private static Duration millis(Map<String, @Nullable Object> fixture, String key) {
    return Duration.ofMillis((Long) fixture.get(key));
  }

  private static Map<String, @Nullable Object> object(
      Map<String, @Nullable Object> fixture, String key) {
    return Runner.object(fixture.get(key), key);
  }

  private static EnqueueOptions.Builder options(String queueName) {
    return EnqueueOptions.builder().queue(queueName);
  }

  private UUID enqueue(String taskType, @Nullable Object payload, EnqueueOptions.Builder options) {
    synchronized (connection) {
      return queue.enqueue(taskType, payload, options.build()).taskId();
    }
  }

  private static Worker.Builder worker(Intercept pool, Map<String, @Nullable Object> fixture) {
    return Worker.builder(pool)
        .queues(queueName(fixture))
        .workerId("jvm-" + fixture.get("id"))
        .pollingOnly(true)
        .disableRegistry(true)
        .pollInterval(Duration.ofMillis(5));
  }

  /** A worker call on its own thread. The caller joins it before the fixture ends. */
  @FunctionalInterface
  private interface Action<T> {
    T call() throws Exception;
  }

  private <T> CompletableFuture<T> running(Worker subject, Action<T> action) {
    CompletableFuture<T> future = new CompletableFuture<>();
    Thread thread =
        new Thread(
            () -> {
              try {
                future.complete(action.call());
              } catch (Throwable error) {
                future.completeExceptionally(error);
              }
            },
            "conformance-worker");
    thread.setDaemon(true);
    thread.start();
    // A fixture that fails early skips its own stop, so the worker never outlives the fixture.
    cleanups.add(
        () -> {
          subject.stop();
          try {
            future.get(10, TimeUnit.SECONDS);
          } catch (ExecutionException | TimeoutException ignored) {
            // The fixture already reported its outcome; this wait only bounds the thread.
          }
        });
    return future;
  }

  private CompletableFuture<Void> running(Worker subject, Runnable action) {
    return running(
        subject,
        () -> {
          action.run();
          return null;
        });
  }

  /** Stops every worker a fixture started on its own thread, and waits for each one. */
  private void cleanUp() throws InterruptedException {
    for (Cleanup cleanup : cleanups) {
      cleanup.run();
    }
    cleanups.clear();
  }

  @FunctionalInterface
  private interface Cleanup {
    void run() throws InterruptedException;
  }

  /** The result of a worker call, re-throwing its error. */
  private static <T> T join(CompletableFuture<T> future) throws Exception {
    try {
      return future.get(10, TimeUnit.SECONDS);
    } catch (TimeoutException error) {
      throw new Failure("the worker run did not return");
    } catch (ExecutionException error) {
      if (error.getCause() instanceof Exception cause) {
        throw cause;
      }
      throw error;
    }
  }

  /** A long counter, for an injected function's raised calls. */
  @FunctionalInterface
  private interface Counter {
    long getAsLong() throws SQLException;
  }

  @FunctionalInterface
  private interface Injected {
    void run(Counter failedCalls) throws Exception;
  }

  /**
   * Replaces one installed function with a raising body, and restores it afterwards. The exception
   * rolls the call back, so only a sequence carries the count of raised calls out.
   */
  private void injected(Map<String, @Nullable Object> injection, Injected body) throws Exception {
    String original =
        value("SELECT pg_get_functiondef('" + injection.get("function") + "'::regprocedure)");
    String sequence = (String) injection.get("counterSequence");
    try {
      if (sequence != null) {
        update("CREATE SEQUENCE " + sequence + " MINVALUE 0 START 0");
      }
      update(
          "CREATE OR REPLACE FUNCTION "
              + injection.get("header")
              + " LANGUAGE plpgsql AS $injected$ BEGIN "
              + (sequence == null ? "" : "PERFORM nextval('" + sequence + "');")
              + " RAISE EXCEPTION '"
              + injection.get("message")
              + "' USING ERRCODE = '"
              + injection.get("errorCode")
              + "'; END; $injected$");
      body.run(
          () -> sequence == null ? 0 : Long.parseLong(value("SELECT last_value FROM " + sequence)));
    } finally {
      update(original);
      if (sequence != null) {
        update("DROP SEQUENCE IF EXISTS " + sequence);
      }
    }
  }

  @FunctionalInterface
  private interface Observation {
    void run() throws Exception;
  }

  /**
   * Replaces one installed function with the fixture's body while {@code body} runs. It runs every
   * {@code setup} statement first, and afterwards restores the definition the database reported,
   * then runs every {@code teardown} statement, whatever {@code body} does.
   */
  private void injectedBody(Map<String, @Nullable Object> injection, Observation body)
      throws Exception {
    String original =
        value("SELECT pg_get_functiondef('" + injection.get("function") + "'::regprocedure)");
    check(original != null, "the function " + injection.get("function") + " is not installed");
    try {
      for (Object statement : (List<?>) injection.get("setup")) {
        update((String) statement);
      }
      update(
          "CREATE OR REPLACE FUNCTION "
              + injection.get("header")
              + " LANGUAGE plpgsql AS $injected$ "
              + injection.get("body")
              + " $injected$");
      try {
        body.run();
      } finally {
        update(original);
      }
    } finally {
      for (Object statement : (List<?>) injection.get("teardown")) {
        update((String) statement);
      }
    }
  }

  private Instant expiry(UUID taskId) throws SQLException {
    String text =
        value(
            "SELECT expires_at::text FROM workhorse.task_runtime WHERE task_id = '" + taskId + "'");
    check(text != null, "task " + taskId + " holds no lease");
    return Database.instant(text);
  }

  private Instant renewal(UUID taskId, Instant previous, long timeoutSeconds) throws Exception {
    AtomicReference<Instant> renewed = new AtomicReference<>(previous);
    eventually(
        "the lease of " + taskId + " was not renewed",
        timeoutSeconds,
        () -> {
          renewed.set(expiry(taskId));
          return renewed.get().isAfter(previous);
        });
    return renewed.get();
  }

  private boolean waitsOn(long pid, @Nullable String lock) throws SQLException {
    return "t"
        .equals(
            value(
                "SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE pid = "
                    + pid
                    + " AND wait_event_type = 'Lock'"
                    + (lock == null ? "" : " AND wait_event = '" + lock + "'")
                    + ")"));
  }

  private long attempts(UUID taskId) throws SQLException {
    return Long.parseLong(
        value("SELECT count(*) FROM workhorse.attempt_history WHERE task_id = '" + taskId + "'"));
  }

  private long releases(UUID taskId) throws SQLException {
    return Long.parseLong(
        value(
            "SELECT count(*) FROM workhorse.task_event WHERE task_id = '"
                + taskId
                + "' AND event_type = 'released'"));
  }

  private Map<String, @Nullable Object> state(UUID taskId) {
    List<Map<String, @Nullable Object>> rows;
    synchronized (connection) {
      rows =
          Runner.sql(
              connection,
              "SELECT state::text AS state, current_attempt, error->>'name' AS error_name FROM"
                  + " workhorse.task_runtime WHERE task_id = '"
                  + taskId
                  + "' UNION ALL SELECT state::text, current_attempt, error->>'name' FROM"
                  + " workhorse.task_outcome WHERE task_id = '"
                  + taskId
                  + "' UNION ALL SELECT state, attempt, NULL FROM workhorse.fast_task_runtime"
                  + " WHERE task_id = '"
                  + taskId
                  + "' UNION ALL SELECT state, attempt, error->>'name' FROM"
                  + " workhorse.fast_task_outcome WHERE task_id = '"
                  + taskId
                  + "'");
    }
    check(rows.size() == 1, "task " + taskId + " has " + rows.size() + " state rows");
    Map<String, @Nullable Object> row = rows.get(0);
    Map<String, @Nullable Object> state = new LinkedHashMap<>();
    state.put("state", row.get("state"));
    state.put("attempt", row.get("current_attempt"));
    state.put("errorName", row.get("error_name"));
    return state;
  }

  private void expectState(UUID taskId, Map<String, @Nullable Object> expected) {
    Map<String, @Nullable Object> actual = state(taskId);
    Map<String, @Nullable Object> want = new LinkedHashMap<>();
    want.put("state", expected.get("state"));
    want.put("attempt", expected.get("attempt"));
    Map<String, @Nullable Object> got = new LinkedHashMap<>();
    got.put("state", actual.get("state"));
    got.put("attempt", actual.get("attempt"));
    if (expected.containsKey("errorName")) {
      want.put("errorName", expected.get("errorName"));
      got.put("errorName", actual.get("errorName"));
    }
    check(Matcher.same(want, got), "task state " + actual + ", want " + want);
  }

  private void expectOutcomes(UUID taskId, List<?> expected) {
    List<@Nullable Object> outcomes = new ArrayList<>();
    synchronized (connection) {
      Runner.sql(
              connection,
              "SELECT outcome::text AS outcome FROM workhorse.attempt_history WHERE task_id = '"
                  + taskId
                  + "' ORDER BY attempt")
          .forEach(row -> outcomes.add(row.get("outcome")));
    }
    check(Matcher.same(outcomes, expected), "attempt outcomes " + outcomes + ", want " + expected);
  }

  /** The first column of the one row {@code sql} returns as text, or {@code null}. */
  private @Nullable String value(String sql) throws SQLException {
    synchronized (connection) {
      try (Statement statement = connection.createStatement();
          ResultSet rows = statement.executeQuery(sql)) {
        return rows.next() ? rows.getString(1) : null;
      }
    }
  }

  private void update(String sql) throws SQLException {
    synchronized (connection) {
      try (Statement statement = connection.createStatement()) {
        statement.execute(sql);
      }
    }
  }

  /** A condition that can read the database. */
  @FunctionalInterface
  private interface Condition {
    boolean holds() throws Exception;
  }

  private static void eventually(String message, long timeoutSeconds, Condition condition)
      throws Exception {
    long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(timeoutSeconds);
    while (!condition.holds()) {
      if (System.nanoTime() > deadline) {
        throw new Failure(message);
      }
      Thread.sleep(5);
    }
  }

  /**
   * Two JSON values that agree with the same kind of each number, as Ruby's {@code ==} compares an
   * Integer and a Float. Object keys compare as a set, because {@code jsonb} reorders them.
   */
  private static boolean exact(@Nullable Object left, @Nullable Object right) {
    if (left instanceof Number || right instanceof Number) {
      return left != null
          && right != null
          && left.getClass() == right.getClass()
          && left.equals(right);
    }
    if (left instanceof List<?> list) {
      if (!(right instanceof List<?> other) || list.size() != other.size()) {
        return false;
      }
      for (int index = 0; index < list.size(); index++) {
        if (!exact(list.get(index), other.get(index))) {
          return false;
        }
      }
      return true;
    }
    Map<String, @Nullable Object> object = Json.object(left);
    Map<String, @Nullable Object> other = Json.object(right);
    if (object != null || other != null) {
      return object != null
          && other != null
          && object.keySet().equals(other.keySet())
          && object.keySet().stream().allMatch(key -> exact(object.get(key), other.get(key)));
    }
    return Matcher.same(left, right);
  }
}
