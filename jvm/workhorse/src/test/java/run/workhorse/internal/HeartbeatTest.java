package run.workhorse.internal;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotSame;
import static org.junit.jupiter.api.Assertions.assertSame;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import io.opentelemetry.api.common.AttributeKey;
import io.opentelemetry.sdk.metrics.data.LongPointData;
import io.opentelemetry.sdk.metrics.data.MetricData;
import java.io.EOFException;
import java.io.IOException;
import java.lang.reflect.Proxy;
import java.net.ConnectException;
import java.net.SocketTimeoutException;
import java.sql.SQLException;
import java.sql.SQLNonTransientConnectionException;
import java.sql.SQLTimeoutException;
import java.sql.SQLTransientConnectionException;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;
import java.util.function.BooleanSupplier;
import javax.sql.DataSource;
import org.jspecify.annotations.Nullable;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import run.workhorse.DatabaseException;
import run.workhorse.internal.telemetry.Names;
import run.workhorse.internal.telemetry.OpenTelemetryTelemetry;
import run.workhorse.internal.telemetry.Telemetry;
import run.workhorse.testing.RecordingOpenTelemetry;

@Timeout(value = 60, unit = TimeUnit.SECONDS)
class HeartbeatTest {
  private static long millis(long milliseconds) {
    return TimeUnit.MILLISECONDS.toNanos(milliseconds);
  }

  @Test
  void boundsARoundByThreeQuartersOfTheIntervalAndByTheIntervalUpTo50Ms() {
    assertEquals(millis(10), Heartbeat.roundBoundNanos(millis(10)));
    assertEquals(millis(40), Heartbeat.roundBoundNanos(millis(40)));
    assertEquals(millis(50), Heartbeat.roundBoundNanos(millis(50)));
    assertEquals(millis(50), Heartbeat.roundBoundNanos(millis(66)));
    assertEquals(millis(51), Heartbeat.roundBoundNanos(millis(69)));
    assertEquals(millis(150), Heartbeat.roundBoundNanos(millis(200)));
    assertEquals(millis(7_500), Heartbeat.roundBoundNanos(millis(10_000)));
  }

  @Test
  void keepsTheBoundBelowAnIntervalAbove50Ms() {
    for (long interval = 1; interval <= 1_000; interval++) {
      long bound = Heartbeat.roundBoundNanos(millis(interval));
      if (interval <= 50) {
        assertEquals(millis(interval), bound, "interval " + interval + " ms");
      } else {
        assertTrue(bound < millis(interval), "interval " + interval + " ms");
      }
    }
  }

  /**
   * SM-1569: the shared heartbeat of a {@code DataSource} is keyed by the object itself. Two pools
   * that compare equal are still two pools.
   */
  @Test
  void sharesOneDedicatedHeartbeatForEachDataSourceObjectByIdentity() {
    DataSource first = equalDataSource();
    DataSource second = equalDataSource();
    assertEquals(first, second, "the two sources compare equal");
    assertSame(Heartbeat.dedicated(first), Heartbeat.dedicated(first));
    assertNotSame(Heartbeat.dedicated(first), Heartbeat.dedicated(second));
  }

  /** A data source that equals every other one from this method, and opens no connection. */
  private static DataSource equalDataSource() {
    return (DataSource)
        Proxy.newProxyInstance(
            DataSource.class.getClassLoader(),
            new Class<?>[] {DataSource.class},
            (proxy, method, arguments) ->
                switch (method.getName()) {
                  case "equals" ->
                      arguments[0] != null && Proxy.isProxyClass(arguments[0].getClass());
                  case "hashCode" -> 1;
                  case "toString" -> "equal data source";
                  default -> throw new UnsupportedOperationException(method.getName());
                });
  }

  @Test
  void leavesAMarginAfterOneTimedOutRoundWithTheDefaults() {
    long lease = millis(30_000);
    long interval = lease / 3;
    assertTrue(2 * interval + Heartbeat.roundBoundNanos(interval) < lease);
  }

  private static Heartbeat.Member member(String workerId) {
    UUID taskId = UUID.randomUUID();
    return new Heartbeat.Member() {
      @Override
      public String workerId() {
        return workerId;
      }

      @Override
      public UUID taskId() {
        return taskId;
      }

      @Override
      public long fenceToken() {
        return 1;
      }

      @Override
      public long leaseMs() {
        return 30_000;
      }

      @Override
      public long intervalNanos() {
        return millis(10_000);
      }

      @Override
      public long leaseEndsAt() {
        return System.nanoTime() + millis(30_000);
      }

      @Override
      public void renew(long sentAt) {}

      @Override
      public void settle(String status) {}

      @Override
      public void fail(Exception error) {}
    };
  }

  private static List<Heartbeat.Member> members(int count) {
    List<Heartbeat.Member> members = new ArrayList<>();
    for (int index = 0; index < count; index++) {
      members.add(member("worker"));
    }
    return members;
  }

  /**
   * The deadline of a round in the batch tests. A pause of a loaded host before the first send
   * stays below it (SM-1479).
   */
  private static final long ROUND_DEADLINE_MS = 200;

  /**
   * A round whose slow batch always passes the deadline of {@link #ROUND_DEADLINE_MS}. It records
   * the payload of each send.
   */
  private static Heartbeat.Round slowFirstBatch(String slowTask, List<String> sent) {
    return (timeoutNanos, statement, parameters) -> {
      String payload = (String) parameters[1];
      sent.add(payload);
      if (payload.contains(slowTask)) {
        try {
          TimeUnit.MILLISECONDS.sleep(ROUND_DEADLINE_MS + 50);
        } catch (InterruptedException interrupted) {
          Thread.currentThread().interrupt();
        }
      }
      return List.of();
    };
  }

  @Test
  void aSharedRoundSendsEveryBatchAfterASlowFirstBatch() throws Exception {
    List<Heartbeat.Member> due = members(101);
    List<Heartbeat.Batch> batches = Heartbeat.batches(due);
    assertEquals(2, batches.size());
    String last = due.get(100).taskId().toString();
    Heartbeat shared = new Heartbeat(null, false);
    for (int round = 0; round < 3; round++) {
      List<String> sent = new ArrayList<>();
      long deadline = System.nanoTime() + millis(ROUND_DEADLINE_MS);
      shared.sendBatches(batches, deadline, slowFirstBatch(due.get(0).taskId().toString(), sent));
      // A shared round has no deadline, so the batch after the slow one is always sent.
      assertEquals(2, sent.size(), "round " + round);
      assertTrue(sent.get(1).contains(last), "round " + round);
    }
  }

  /**
   * SM-1633: a dedicated round sends one {@code heartbeat_pool_v1} statement for every batch of
   * every worker. A batch holds at most 100 leases of one worker, and the statuses go back to the
   * members of each batch by the batch number.
   */
  @Test
  void aDedicatedRoundSendsEveryBatchOfEveryWorkerInOneStatement() throws Exception {
    long interval = millis(10_000);
    List<FakeMember> due = new ArrayList<>();
    for (int index = 0; index < 101; index++) {
      due.add(new FakeMember("first", interval));
    }
    FakeMember second = new FakeMember("second", interval);
    FakeMember third = new FakeMember("third", interval);
    due.add(second);
    due.add(third);
    // The fixed round is never due within the test: the member interval is 10 s.
    Heartbeat dedicated =
        new Heartbeat(null, true, (timeoutNanos, statement, parameters) -> List.of());
    List<Runnable> removals = new ArrayList<>();
    due.forEach(member -> removals.add(dedicated.register(member)));
    Recorder round = new Recorder(0, (index, call) -> answer(call, due, second));
    try {
      List<Heartbeat.Member> busy =
          dedicated.sendBatches(
              Heartbeat.batches(List.copyOf(due)),
              System.nanoTime() + millis(ROUND_DEADLINE_MS),
              round);
      assertEquals(1, round.calls.size(), "one statement carries every batch");
      assertSame(SqlCatalogue.HEARTBEAT_POOL_V1, round.statements.get(0));
      List<?> items = (List<?>) Json.parse(round.calls.get(0).payload());
      assertEquals(4, items.size(), "two batches of the first worker and one of each other");
      List<String> workers = new ArrayList<>();
      for (Object item : items) {
        Map<?, ?> batch = (Map<?, ?>) item;
        workers.add((String) batch.get("workerId"));
        assertTrue(((List<?>) batch.get("leases")).size() <= 100, "a batch has at most 100");
      }
      assertEquals(List.of("first", "first", "second", "third"), workers);
      assertEquals(List.of(second), busy, "the busy status reaches the member of its batch");
      for (FakeMember member : due) {
        assertEquals(member == second ? 0 : 1, member.renewals.get(), member.workerId);
      }
    } finally {
      removals.forEach(Runnable::run);
    }
  }

  @Test
  void givesTheHeartbeatAndEachIdleGapOneQuarterOfTheTimeLeft() {
    assertEquals(250, Heartbeat.serverBudgetMs(1_000));
    assertEquals(187, Heartbeat.serverBudgetMs(750));
    assertEquals(2, Heartbeat.serverBudgetMs(8));
    assertEquals(1, Heartbeat.serverBudgetMs(7));
    assertEquals(1, Heartbeat.serverBudgetMs(1));
    assertEquals(1, Heartbeat.serverBudgetMs(0));
    for (long remaining = 8; remaining <= 2_000; remaining++) {
      // The heartbeat and both idle gaps end within three quarters of the time left.
      assertTrue(3 * Heartbeat.serverBudgetMs(remaining) <= remaining * 3 / 4, remaining + " ms");
    }
  }

  // SM-1443: busy leases and the busy retry.

  @Test
  void waitsAJitteredDelayOfAtMostTwiceTheBaseBeforeABusyRetry() {
    for (int sample = 0; sample < 1_000; sample++) {
      long slow = Heartbeat.busyRetryDelayNanos(millis(10_000));
      assertTrue(slow >= millis(100) && slow < millis(200), "delay " + slow);
      long fast = Heartbeat.busyRetryDelayNanos(millis(400));
      assertTrue(fast >= millis(50) && fast < millis(100), "delay " + fast);
    }
  }

  @Test
  void endsABusyRetryByTheBoundTheNextSlotAndTheEarliestLeaseWindow() {
    long interval = millis(1_000);
    FakeMember far = new FakeMember("worker", interval);
    far.leaseEndsAt.set(millis(10_000));
    // The bound of a 1 s interval is 750 ms.
    assertEquals(millis(750), Heartbeat.retryDeadline(0, interval, millis(900), List.of(far)));
    assertEquals(millis(600), Heartbeat.retryDeadline(0, interval, millis(600), List.of(far)));
    FakeMember near = new FakeMember("worker", interval);
    near.leaseEndsAt.set(millis(300));
    assertEquals(
        millis(300), Heartbeat.retryDeadline(0, interval, millis(900), List.of(far, near)));
  }

  /** One registered attempt whose callbacks the test reads. */
  private static final class FakeMember implements Heartbeat.Member {
    final String workerId;
    final UUID taskId;
    final long intervalNanos;
    final AtomicLong leaseEndsAt = new AtomicLong(System.nanoTime() + millis(60_000));

    /**
     * When it is above zero, the lease window always ends this many nanoseconds after each read,
     * instead of at {@link #leaseEndsAt}.
     */
    final AtomicLong windowLeft = new AtomicLong();

    final AtomicInteger renewals = new AtomicInteger();
    final List<String> statuses = new CopyOnWriteArrayList<>();

    /** The telemetry that counts a failed round of this member. */
    Telemetry telemetry = Telemetry.NOOP;

    FakeMember(String workerId, long intervalNanos) {
      this(workerId, UUID.randomUUID(), intervalNanos);
    }

    /** A new attempt of the task of {@code replaced}. */
    FakeMember(FakeMember replaced) {
      this(replaced.workerId, replaced.taskId, replaced.intervalNanos);
    }

    private FakeMember(String workerId, UUID taskId, long intervalNanos) {
      this.workerId = workerId;
      this.taskId = taskId;
      this.intervalNanos = intervalNanos;
    }

    @Override
    public String workerId() {
      return workerId;
    }

    @Override
    public UUID taskId() {
      return taskId;
    }

    @Override
    public long fenceToken() {
      return 1;
    }

    @Override
    public long leaseMs() {
      return 30_000;
    }

    @Override
    public long intervalNanos() {
      return intervalNanos;
    }

    @Override
    public long leaseEndsAt() {
      long left = windowLeft.get();
      return left > 0 ? System.nanoTime() + left : leaseEndsAt.get();
    }

    @Override
    public void renew(long sentAt) {
      renewals.incrementAndGet();
    }

    @Override
    public void settle(String status) {
      statuses.add(status);
    }

    @Override
    public void fail(Exception error) {
      throw new AssertionError(error);
    }

    @Override
    public Telemetry telemetry() {
      return telemetry;
    }
  }

  /** One statement that a scheduler test round received. */
  private record Call(long startedAt, String payload) {
    boolean sends(FakeMember member) {
      return payload.contains(member.taskId().toString());
    }
  }

  /** Answers one statement: the status of each sent task by its ID, or a failure. */
  @FunctionalInterface
  private interface Answer {
    Map<UUID, String> statuses(int call, Call sent) throws SQLException;
  }

  /**
   * A round that records each statement and its overlap, and answers through {@code answer}. It
   * answers a {@code heartbeat_pool_v1} statement with the number of the batch that sent each task.
   */
  private static final class Recorder implements Heartbeat.Round {
    final List<Call> calls = new CopyOnWriteArrayList<>();
    final List<SqlCatalogue.Statement> statements = new CopyOnWriteArrayList<>();
    final AtomicInteger inFlight = new AtomicInteger();
    final AtomicInteger overlap = new AtomicInteger();
    final Answer answer;
    final long sendMillis;

    Recorder(long sendMillis, Answer answer) {
      this.sendMillis = sendMillis;
      this.answer = answer;
    }

    @Override
    public List<Row> send(
        long timeoutNanos, SqlCatalogue.Statement statement, @Nullable Object... parameters)
        throws SQLException {
      Call call = new Call(System.nanoTime(), (String) parameters[parameters.length - 1]);
      int index = calls.size();
      calls.add(call);
      statements.add(statement);
      overlap.accumulateAndGet(inFlight.incrementAndGet(), Math::max);
      try {
        if (sendMillis > 0) {
          TimeUnit.MILLISECONDS.sleep(sendMillis);
        }
        List<Row> rows = new ArrayList<>();
        for (Map.Entry<UUID, String> entry : answer.statuses(index, call).entrySet()) {
          Map<String, @Nullable Object> values = new LinkedHashMap<>();
          if (statement == SqlCatalogue.HEARTBEAT_POOL_V1) {
            values.put("batch", Long.toString(batchOf(call.payload(), entry.getKey())));
          }
          values.put("task_id", entry.getKey().toString());
          values.put("status", entry.getValue());
          rows.add(new Row(values));
        }
        return rows;
      } catch (InterruptedException interrupted) {
        Thread.currentThread().interrupt();
        throw new SQLException("interrupted", interrupted);
      } finally {
        inFlight.decrementAndGet();
      }
    }
  }

  /**
   * The 1-based number of the batch of a {@code heartbeat_pool_v1} payload that sends {@code task}.
   */
  private static int batchOf(String payload, UUID task) {
    List<?> items = (List<?>) Json.parse(payload);
    for (int index = 0; index < items.size(); index++) {
      for (Object lease : (List<?>) ((Map<?, ?>) items.get(index)).get("leases")) {
        if (task.toString().equals(((Map<?, ?>) lease).get("taskId"))) {
          return index + 1;
        }
      }
    }
    throw new AssertionError("no batch sends " + task);
  }

  /** Every member that {@code call} sends, as accepted, apart from {@code busy}. */
  private static Map<UUID, String> answer(
      Call call, List<FakeMember> members, @Nullable FakeMember busy) {
    Map<UUID, String> statuses = new LinkedHashMap<>();
    for (FakeMember member : members) {
      if (call.sends(member)) {
        statuses.put(member.taskId(), member == busy ? "busy" : "accepted");
      }
    }
    return statuses;
  }

  private static void waitUntil(String what, BooleanSupplier condition)
      throws InterruptedException {
    long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(20);
    while (!condition.getAsBoolean()) {
      if (System.nanoTime() - deadline > 0) {
        throw new AssertionError("timed out waiting until " + what);
      }
      TimeUnit.MILLISECONDS.sleep(5);
    }
  }

  private static double gapMillis(Call earlier, Call later) {
    return (later.startedAt() - earlier.startedAt()) / 1e6;
  }

  @Test
  void retriesOnlyTheBusyLeaseSoonerThanTheInterval() throws Exception {
    long interval = millis(400);
    FakeMember busy = new FakeMember("worker", interval);
    FakeMember accepted = new FakeMember("worker", interval);
    List<FakeMember> all = List.of(busy, accepted);
    Recorder round = new Recorder(0, (index, call) -> answer(call, all, index == 0 ? busy : null));
    Heartbeat heartbeat = new Heartbeat(null, true, round);
    Runnable removeBusy = heartbeat.register(busy);
    Runnable removeAccepted = heartbeat.register(accepted);
    try {
      // The recorder adds a call before the heartbeat thread settles its answer. A member that
      // leaves before the settlement gets nothing from the round, so the test waits for the
      // renewal of the retry too. Without that, a loaded host left the busy lease with 0 renewals.
      waitUntil(
          "a busy retry ran and renewed the lease",
          () -> round.calls.size() >= 2 && busy.renewals.get() >= 1);
    } finally {
      removeBusy.run();
      removeAccepted.run();
    }
    Call first = round.calls.get(0);
    Call retry = round.calls.get(1);
    assertTrue(first.sends(busy) && first.sends(accepted), "the regular round sends both leases");
    assertTrue(retry.sends(busy), "the retry sends the busy lease");
    assertFalse(retry.sends(accepted), "the retry sends only the busy lease");
    // The base is min(100 ms, 400 ms / 8) = 50 ms, so the retry waits less than 100 ms.
    assertTrue(gapMillis(first, retry) < 250, "the retry came " + gapMillis(first, retry) + " ms");
    assertEquals(List.of("busy"), busy.statuses, "busy reaches the member as a status");
    assertEquals(1, busy.renewals.get(), "only the accepted retry renews the busy lease");
    assertEquals(1, accepted.renewals.get());
  }

  @Test
  void keepsTheRegularSlotsAndOneRoundInFlightWhileRetriesRun() throws Exception {
    long interval = millis(300);
    FakeMember busy = new FakeMember("worker", interval);
    FakeMember accepted = new FakeMember("worker", interval);
    List<FakeMember> all = List.of(busy, accepted);
    Recorder round = new Recorder(10, (index, call) -> answer(call, all, busy));
    Heartbeat heartbeat = new Heartbeat(null, true, round);
    Runnable removeBusy = heartbeat.register(busy);
    Runnable removeAccepted = heartbeat.register(accepted);
    try {
      waitUntil(
          "four regular rounds ran",
          () -> round.calls.stream().filter(call -> call.sends(accepted)).count() >= 4);
    } finally {
      removeBusy.run();
      removeAccepted.run();
    }
    List<Call> regular = round.calls.stream().filter(call -> call.sends(accepted)).toList();
    long retries = round.calls.stream().filter(call -> !call.sends(accepted)).count();
    assertTrue(retries >= 3, "only " + retries + " busy retries ran");
    for (int index = 1; index < 4; index++) {
      double gap = gapMillis(regular.get(index - 1), regular.get(index));
      // A retry does not move the slot, so each regular round starts one interval after the last.
      assertTrue(gap > 290 && gap < 380, "regular round " + index + " came after " + gap + " ms");
    }
    assertEquals(1, round.overlap.get(), "two statements of one heartbeat overlapped");
    assertEquals(0, busy.renewals.get(), "busy never renews");
  }

  @Test
  void ignoresAResultForAMemberThatWasReplacedWhileTheRoundRan() throws Exception {
    long interval = millis(300);
    FakeMember original = new FakeMember("worker", interval);
    FakeMember replacement = new FakeMember(original);
    List<Heartbeat> subject = new CopyOnWriteArrayList<>();
    List<Runnable> removals = new CopyOnWriteArrayList<>();
    Recorder round =
        new Recorder(
            0,
            (index, call) -> {
              if (index == 0) {
                // The attempt ends and a new attempt of the same task registers during the round.
                removals.get(0).run();
                removals.add(subject.get(0).register(replacement));
                return Map.of(original.taskId(), "busy");
              }
              return Map.of(original.taskId(), "accepted");
            });
    subject.add(new Heartbeat(null, true, round));
    removals.add(subject.get(0).register(original));
    try {
      waitUntil("a second round ran", () -> round.calls.size() >= 2);
    } finally {
      removals.forEach(Runnable::run);
    }
    assertTrue(original.statuses.isEmpty(), "the replaced member got " + original.statuses);
    assertEquals(0, original.renewals.get());
    assertTrue(replacement.statuses.isEmpty(), "the replacement got the old round's result");
    assertTrue(replacement.renewals.get() >= 1, "its own round renews the replacement");
    // The busy result belonged to no registered member, so no retry ran before the regular slot.
    double gap = gapMillis(round.calls.get(0), round.calls.get(1));
    assertTrue(gap > 290, "the second round came after " + gap + " ms");
  }

  @Test
  void doesNotRetryAgainAfterAFailedRetry() throws Exception {
    long interval = millis(300);
    FakeMember busy = new FakeMember("worker", interval);
    FakeMember accepted = new FakeMember("worker", interval);
    List<FakeMember> all = List.of(busy, accepted);
    Recorder round =
        new Recorder(
            0,
            (index, call) -> {
              if (index == 1) {
                throw new SQLException("injected retry failure");
              }
              return answer(call, all, busy);
            });
    Heartbeat heartbeat = new Heartbeat(null, true, round);
    Runnable removeBusy = heartbeat.register(busy);
    Runnable removeAccepted = heartbeat.register(accepted);
    try {
      waitUntil("a round after the failed retry ran", () -> round.calls.size() >= 3);
    } finally {
      removeBusy.run();
      removeAccepted.run();
    }
    assertFalse(round.calls.get(1).sends(accepted), "the second statement was the retry");
    // The failed retry scheduled no retry, so the next round is the regular one at the slot.
    Call next = round.calls.get(2);
    assertTrue(next.sends(busy) && next.sends(accepted), "the next round is a regular round");
    double gap = gapMillis(round.calls.get(0), next);
    assertTrue(gap > 290, "the round after the failed retry came after " + gap + " ms");
  }

  @Test
  void doesNotRetryABusyLeaseWhoseWindowHasEnded() throws Exception {
    long interval = millis(300);
    FakeMember busy = new FakeMember("worker", interval);
    busy.leaseEndsAt.set(System.nanoTime() - 1);
    Recorder round = new Recorder(0, (index, call) -> answer(call, List.of(busy), busy));
    Heartbeat heartbeat = new Heartbeat(null, true, round);
    Runnable remove = heartbeat.register(busy);
    try {
      waitUntil("two rounds ran", () -> round.calls.size() >= 2);
    } finally {
      remove.run();
    }
    double gap = gapMillis(round.calls.get(0), round.calls.get(1));
    assertTrue(gap > 290, "the second round came after " + gap + " ms");
  }

  // SM-1492: a busy retry with too little time, and a round that expires before its heartbeat.

  @Test
  void runsABusyRetryOnlyWithAtLeast20MsBeforeItsDeadline() {
    assertEquals(millis(20), Heartbeat.BUSY_RETRY_MIN_NANOS);
    assertTrue(Heartbeat.busyRetryFits(0, millis(20)), "a retry with exactly the minimum runs");
    assertTrue(Heartbeat.busyRetryFits(0, millis(300)));
    assertFalse(Heartbeat.busyRetryFits(0, millis(20) - 1));
    assertFalse(Heartbeat.busyRetryFits(0, millis(10)));
  }

  @Test
  void skipsABusyRetryWhoseLeaseWindowEndsTooSoonAndRenewsAtTheNextSlot() throws Exception {
    long interval = millis(300);
    FakeMember busy = new FakeMember("worker", interval);
    FakeMember accepted = new FakeMember("worker", interval);
    List<FakeMember> all = List.of(busy, accepted);
    Recorder round =
        new Recorder(
            0,
            (index, call) -> {
              if (index == 0) {
                // When the retry falls due, the busy lease window ends 5 ms later.
                busy.windowLeft.set(millis(5));
                return answer(call, all, busy);
              }
              return answer(call, all, null);
            });
    Heartbeat heartbeat = new Heartbeat(null, true, round);
    Runnable removeBusy = heartbeat.register(busy);
    Runnable removeAccepted = heartbeat.register(accepted);
    try {
      waitUntil("a round renewed the busy lease", () -> busy.renewals.get() >= 1);
    } finally {
      removeBusy.run();
      removeAccepted.run();
    }
    // The retry sent no statement, so the second statement is the regular round at the slot.
    Call next = round.calls.get(1);
    assertTrue(next.sends(busy) && next.sends(accepted), "the next round is a regular round");
    double gap = gapMillis(round.calls.get(0), next);
    assertTrue(gap > 290, "the second round came after " + gap + " ms");
    assertEquals(1, busy.renewals.get(), "the regular round renews the busy lease");
  }

  @Test
  void runsABusyRetryWhoseLeaseWindowLeavesTheMinimum() throws Exception {
    long interval = millis(300);
    FakeMember busy = new FakeMember("worker", interval);
    FakeMember accepted = new FakeMember("worker", interval);
    List<FakeMember> all = List.of(busy, accepted);
    Recorder round =
        new Recorder(
            0,
            (index, call) -> {
              if (index == 0) {
                busy.windowLeft.set(millis(30));
                return answer(call, all, busy);
              }
              return answer(call, all, null);
            });
    Heartbeat heartbeat = new Heartbeat(null, true, round);
    Runnable removeBusy = heartbeat.register(busy);
    Runnable removeAccepted = heartbeat.register(accepted);
    try {
      waitUntil("a second round ran", () -> round.calls.size() >= 2);
    } finally {
      removeBusy.run();
      removeAccepted.run();
    }
    Call retry = round.calls.get(1);
    assertTrue(retry.sends(busy) && !retry.sends(accepted), "the second statement is the retry");
    double gap = gapMillis(round.calls.get(0), retry);
    assertTrue(gap < 250, "the retry came after " + gap + " ms");
  }

  /** One member of each of three workers, so a round has three batches. */
  private static List<Heartbeat.Member> threeWorkers() {
    return List.of(member("first"), member("second"), member("third"));
  }

  @Test
  void endsADedicatedRoundWithoutAThrowWhenItExpiresBeforeItsHeartbeat() throws Exception {
    List<Heartbeat.Member> due = threeWorkers();
    Heartbeat dedicated = new Heartbeat(null, true);
    List<SqlCatalogue.Statement> sent = new ArrayList<>();
    List<Heartbeat.Member> busy =
        dedicated.sendBatches(
            Heartbeat.batches(due),
            System.nanoTime() + millis(ROUND_DEADLINE_MS),
            (timeoutNanos, statement, parameters) -> {
              sent.add(statement);
              throw new Heartbeat.RoundExpired("injected expiry");
            });
    assertEquals(List.of(SqlCatalogue.HEARTBEAT_POOL_V1), sent, "one statement for the round");
    assertTrue(busy.isEmpty(), "an expired round settles no lease");
  }

  @Test
  void stillThrowsWhenARoundTimesOutWithItsStatementInFlight() {
    List<FakeMember> due =
        List.of(
            new FakeMember("first", millis(10_000)),
            new FakeMember("second", millis(10_000)),
            new FakeMember("third", millis(10_000)));
    // The fixed round is never due within the test: the member interval is 10 s.
    Heartbeat dedicated =
        new Heartbeat(null, true, (timeoutNanos, statement, parameters) -> List.of());
    List<Runnable> removals = new ArrayList<>();
    due.forEach(member -> removals.add(dedicated.register(member)));
    List<String> sent = new ArrayList<>();
    try {
      assertThrows(
          SQLTimeoutException.class,
          () ->
              dedicated.sendBatches(
                  Heartbeat.batches(List.copyOf(due)),
                  System.nanoTime() + millis(ROUND_DEADLINE_MS),
                  (timeoutNanos, statement, parameters) -> {
                    sent.add((String) parameters[0]);
                    throw new SQLTimeoutException("injected in-flight deadline");
                  }));
    } finally {
      removals.forEach(Runnable::run);
    }
    assertEquals(1, sent.size(), "one statement carries every batch");
    for (FakeMember member : due) {
      // The round is all or nothing, so no lease of it counts.
      assertEquals(0, member.renewals.get(), member.workerId);
      assertTrue(member.statuses.isEmpty(), member.workerId);
    }
  }

  // SM-1704: a round that fails before PostgreSQL returns its statuses counts once.

  private static final String ROUND_FAILURE = "workhorse.worker.heartbeat.round_failure";

  /** The reason of a failure before the round deadline, or of a borrowing round. */
  private static String reason(Throwable error) {
    return Heartbeat.roundFailureReason(error, false);
  }

  @Test
  void namesASocketTimeoutTimeoutOnlyAtTheRoundDeadline() {
    SQLException timedOut =
        new SQLException("I/O error", "08006", new SocketTimeoutException("Read timed out"));
    assertEquals("timeout", Heartbeat.roundFailureReason(timedOut, true));
    // A driver socketTimeout or connectTimeout before the deadline, or on a borrowing round.
    assertEquals("connection", reason(timedOut));
    assertEquals("connection", reason(new SocketTimeoutException("connect timed out")));
  }

  @Test
  void namesADriverOrPoolTimeoutTimeoutOnlyAtTheRoundDeadline() {
    SQLTimeoutException login = new SQLTimeoutException("login timed out");
    assertEquals("timeout", Heartbeat.roundFailureReason(login, true));
    assertEquals("connection", reason(login));
    TimeoutException checkout = new TimeoutException("pool checkout timed out");
    assertEquals("timeout", Heartbeat.roundFailureReason(checkout, true));
    assertEquals("connection", reason(checkout));
    assertEquals(
        "connection", reason(new IllegalStateException("acquire failed", new TimeoutException())));
  }

  @Test
  void letsAServerSqlStateDecideBeforeAConnectionWrapper() {
    // A pool that opens a replacement connection gets a refused password from PostgreSQL.
    SQLException refused = new SQLException("password authentication failed", "28P01");
    assertEquals(
        "database",
        reason(new SQLNonTransientConnectionException("could not open a connection", refused)));
    assertEquals(
        "database",
        reason(new SQLTransientConnectionException("request timed out", null, refused)));
    assertEquals("database", reason(new SQLTimeoutException("login timed out", null, refused)));
    assertEquals(
        "connection",
        reason(
            new SQLTransientConnectionException(
                "request timed out", null, new SQLException("refused", "08001"))));
    // A real I/O failure in the chain wins over a SQLSTATE that names no connection failure.
    assertEquals(
        "connection",
        reason(new SQLException("password authentication failed", "28P01", new EOFException())));
    assertEquals(
        "connection",
        reason(
            new SQLNonTransientConnectionException(
                "could not open a connection", null, new IOException("reset", refused))));
  }

  @Test
  void namesAGeneralIoErrorConnection() {
    assertEquals("connection", reason(new SQLException("read failed", null, new EOFException())));
    assertEquals("connection", reason(new IOException("stream closed")));
  }

  @Test
  void namesTheRoundDeadlineAndTheServerTimeoutsTimeout() {
    assertEquals("timeout", reason(new Heartbeat.RoundExpired("expired")));
    assertEquals("timeout", reason(new Heartbeat.RoundDeadline("deadline")));
    assertEquals("timeout", reason(new SQLException("canceled", "57014")));
    assertEquals("timeout", reason(new SQLException("idle", "25P03")));
    // PgJDBC reports the network timeout that the round sets as 08006 with a socket timeout cause.
    assertEquals(
        "timeout",
        Heartbeat.roundFailureReason(
            new SQLException("I/O error", "08006", new SocketTimeoutException("Read timed out")),
            true));
    // A rollback that fails after an expired round keeps the expiry as a suppressed exception.
    SQLException late = new SQLException("rollback failed");
    late.addSuppressed(new Heartbeat.RoundExpired("expired"));
    assertEquals("timeout", reason(late));
  }

  @Test
  void namesASocketErrorAndAConnectionSqlStateConnection() {
    assertEquals("connection", reason(new SQLException("I/O error", "08006")));
    assertEquals("connection", reason(new SQLException("shutdown", "57P01")));
    assertEquals("connection", reason(new SQLException("crash", "57P02")));
    assertEquals("connection", reason(new SQLException("starting up", "57P03")));
    assertEquals("connection", reason(new ConnectException("Connection refused")));
    assertEquals("connection", reason(new SQLNonTransientConnectionException("pool closed")));
    // Sql.rows translates the driver's exception, and keeps it as the cause.
    assertEquals(
        "connection",
        reason(new DatabaseException("closed", null, new SQLException("closed", "08003"))));
    assertEquals(
        "connection",
        reason(new RuntimeException(new IOException("wrapped", new ConnectException("refused")))));
  }

  @Test
  void namesAnyOtherSqlStateDatabaseAndTheRestOther() {
    assertEquals("database", reason(new SQLException("internal", "XX000")));
    assertEquals(
        "database",
        reason(new DatabaseException("missing", "42883", new SQLException("missing", "42883"))));
    assertEquals("other", reason(new IllegalStateException("bug")));
    assertEquals("other", reason(new SQLException("no state")));
  }

  @Test
  void readsACyclicCauseChainOnce() {
    SQLException first = new SQLException("first");
    SQLException second = new SQLException("second", first);
    first.initCause(second);
    assertEquals("other", reason(first));
    first.setNextException(new SQLException("next", "08001"));
    assertEquals("connection", reason(first));
  }

  /** The values of the counter of failed rounds, by {@code workhorse.heartbeat.failure_reason}. */
  private static Map<String, Long> roundFailures(RecordingOpenTelemetry recording) {
    Map<String, Long> values = new LinkedHashMap<>();
    for (MetricData metric : recording.metrics()) {
      if (!metric.getName().equals(ROUND_FAILURE)) {
        continue;
      }
      assertEquals("{round}", metric.getUnit());
      for (LongPointData point : metric.getLongSumData().getPoints()) {
        assertEquals(1, point.getAttributes().size(), point.getAttributes().toString());
        values.put(
            point.getAttributes().get(AttributeKey.stringKey(Names.HEARTBEAT_FAILURE_REASON)),
            point.getValue());
      }
    }
    return values;
  }

  @Test
  void countsAFailedDedicatedRoundOnceForEachTelemetry() throws Exception {
    long interval = millis(100);
    FakeMember first = new FakeMember("first", interval);
    FakeMember second = new FakeMember("second", interval);
    FakeMember other = new FakeMember("other", interval);
    List<FakeMember> all = List.of(first, second, other);
    Recorder round =
        new Recorder(
            0,
            (index, call) -> {
              if (index == 0) {
                throw new SQLException("I/O error", "08006");
              }
              return answer(call, all, null);
            });
    try (RecordingOpenTelemetry shared = new RecordingOpenTelemetry();
        RecordingOpenTelemetry own = new RecordingOpenTelemetry()) {
      // Two workers share one telemetry, and the third has its own.
      Telemetry sharedTelemetry = OpenTelemetryTelemetry.of(shared.sdk());
      first.telemetry = sharedTelemetry;
      second.telemetry = sharedTelemetry;
      other.telemetry = OpenTelemetryTelemetry.of(own.sdk());
      // One fixed round carries every member, so no schedule decides which members it sends.
      List<Heartbeat.Batch> batches = Heartbeat.batches(List.copyOf(all));
      assertEquals(3, batches.size());
      Heartbeat heartbeat = new Heartbeat(null, true, round);
      long deadline = System.nanoTime() + millis(60_000);
      assertThrows(SQLException.class, () -> heartbeat.sendBatches(batches, deadline, round));
      // The next round succeeds, and counts nothing.
      heartbeat.sendBatches(batches, deadline, round);
      assertEquals(2, round.calls.size());
      assertEquals(Map.of("connection", 1L), roundFailures(shared));
      assertEquals(Map.of("connection", 1L), roundFailures(own));
      assertTrue(
          shared.metrics().stream()
              .noneMatch(metric -> metric.getName().equals("workhorse.worker.heartbeat.failure")),
          "a failed round gives no ownership verdict");
    }
  }

  @Test
  void countsABorrowingRoundWithTwoFailedBatchesOnce() throws Exception {
    List<FakeMember> all = new ArrayList<>();
    for (int count = 0; count < 101; count++) {
      all.add(new FakeMember("worker", millis(1_000)));
    }
    // The first round sends two batches, and both fail.
    Recorder round =
        new Recorder(
            0,
            (index, call) -> {
              if (index < 2) {
                throw new SQLException("internal", "XX000");
              }
              return answer(call, all, null);
            });
    try (RecordingOpenTelemetry recording = new RecordingOpenTelemetry()) {
      Telemetry telemetry = OpenTelemetryTelemetry.of(recording.sdk());
      all.forEach(member -> member.telemetry = telemetry);
      // One fixed round carries every member, so no schedule splits the two batches.
      List<Heartbeat.Batch> batches = Heartbeat.batches(List.copyOf(all));
      assertEquals(2, batches.size());
      Heartbeat heartbeat = new Heartbeat(null, false, round);
      long deadline = System.nanoTime() + millis(60_000);
      heartbeat.sendBatches(batches, deadline, round);
      assertEquals(2, round.calls.size(), "the round sent both batches");
      assertEquals(Map.of("database", 1L), roundFailures(recording));
      // The next round succeeds, and counts nothing.
      heartbeat.sendBatches(batches, deadline, round);
      assertEquals(Map.of("database", 1L), roundFailures(recording));
    }
  }

  /** {@code count} members of one worker that count a failed round on {@code telemetry}. */
  private static List<Heartbeat.Member> counted(int count, Telemetry telemetry) {
    List<Heartbeat.Member> members = new ArrayList<>();
    for (int index = 0; index < count; index++) {
      FakeMember member = new FakeMember("worker", millis(1_000));
      member.telemetry = telemetry;
      members.add(member);
    }
    return members;
  }

  @Test
  void countsAFailedBorrowingBatchAtOnceWhileTheNextBatchStalls() throws Exception {
    CountDownLatch release = new CountDownLatch(1);
    Recorder round =
        new Recorder(
            0,
            (index, call) -> {
              if (index == 0) {
                throw new SQLException("internal", "XX000");
              }
              try {
                release.await(30, TimeUnit.SECONDS);
              } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
              }
              return Map.of();
            });
    try (RecordingOpenTelemetry recording = new RecordingOpenTelemetry()) {
      List<Heartbeat.Batch> batches =
          Heartbeat.batches(counted(101, OpenTelemetryTelemetry.of(recording.sdk())));
      assertEquals(2, batches.size());
      Heartbeat heartbeat = new Heartbeat(null, false, round);
      Thread sender =
          Thread.ofPlatform()
              .start(
                  () -> {
                    try {
                      heartbeat.sendBatches(batches, System.nanoTime() + millis(60_000), round);
                    } catch (SQLException error) {
                      throw new AssertionError(error);
                    }
                  });
      try {
        waitUntil("the second batch is in flight", () -> round.calls.size() == 2);
        waitUntil(
            "the failed batch counted while the next batch stalls",
            () -> !roundFailures(recording).isEmpty());
      } finally {
        release.countDown();
        sender.join();
      }
      assertEquals(Map.of("database", 1L), roundFailures(recording));
    }
  }

  @Test
  void countsADedicatedRoundThatReachedItsDeadlineBeforeItSentTimeout() throws Exception {
    Recorder round = new Recorder(0, (index, call) -> Map.of());
    try (RecordingOpenTelemetry recording = new RecordingOpenTelemetry()) {
      List<Heartbeat.Batch> batches =
          Heartbeat.batches(counted(2, OpenTelemetryTelemetry.of(recording.sdk())));
      Heartbeat heartbeat = new Heartbeat(null, true, round);
      assertEquals(List.of(), heartbeat.sendBatches(batches, System.nanoTime() - 1, round));
      assertEquals(List.of(), round.calls, "the expired round sent nothing");
      assertEquals(Map.of("timeout", 1L), roundFailures(recording));
      // A round without members is no round, and counts nothing.
      heartbeat.sendBatches(List.of(), System.nanoTime() - 1, round);
      assertEquals(Map.of("timeout", 1L), roundFailures(recording));
    }
  }

  /** A failure as PgJDBC reports a read that its socket timeout ended. */
  private static SQLException socketTimeout() {
    return new SQLException("I/O error", "08006", new SocketTimeoutException("Read timed out"));
  }

  @Test
  void countsADedicatedSocketTimeoutAtTheRoundDeadlineTimeout() throws Exception {
    Recorder round =
        new Recorder(
            0,
            (index, call) -> {
              try {
                TimeUnit.MILLISECONDS.sleep(40);
              } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
              }
              throw socketTimeout();
            });
    try (RecordingOpenTelemetry recording = new RecordingOpenTelemetry()) {
      List<Heartbeat.Batch> batches =
          Heartbeat.batches(counted(1, OpenTelemetryTelemetry.of(recording.sdk())));
      Heartbeat heartbeat = new Heartbeat(null, true, round);
      assertThrows(
          SQLException.class,
          () -> heartbeat.sendBatches(batches, System.nanoTime() + millis(20), round));
      assertEquals(Map.of("timeout", 1L), roundFailures(recording));
    }
  }

  @Test
  void countsASocketTimeoutBeforeTheDeadlineOrOnABorrowingRoundConnection() throws Exception {
    Recorder round =
        new Recorder(
            0,
            (index, call) -> {
              throw socketTimeout();
            });
    try (RecordingOpenTelemetry dedicated = new RecordingOpenTelemetry();
        RecordingOpenTelemetry borrowing = new RecordingOpenTelemetry()) {
      List<Heartbeat.Batch> early =
          Heartbeat.batches(counted(1, OpenTelemetryTelemetry.of(dedicated.sdk())));
      Heartbeat held = new Heartbeat(null, true, round);
      // A driver socketTimeout that ends the read long before the round deadline.
      assertThrows(
          SQLException.class,
          () -> held.sendBatches(early, System.nanoTime() + millis(60_000), round));
      assertEquals(Map.of("connection", 1L), roundFailures(dedicated));
      // A borrowing round sets no network timeout, even after its deadline.
      List<Heartbeat.Batch> late =
          Heartbeat.batches(counted(1, OpenTelemetryTelemetry.of(borrowing.sdk())));
      new Heartbeat(null, false, round).sendBatches(late, System.nanoTime() - 1, round);
      assertEquals(Map.of("connection", 1L), roundFailures(borrowing));
    }
  }

  @Test
  void countsALoginTimeoutOnABorrowingRoundConnectionAndAtADedicatedDeadlineTimeout()
      throws Exception {
    // JDBC lets DataSource.getConnection throw this when its login timeout ends.
    Recorder borrowingRound =
        new Recorder(
            0,
            (index, call) -> {
              throw new SQLTimeoutException("login timed out");
            });
    Recorder dedicatedRound =
        new Recorder(
            0,
            (index, call) -> {
              try {
                TimeUnit.MILLISECONDS.sleep(40);
              } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
              }
              throw new SQLTimeoutException("login timed out");
            });
    try (RecordingOpenTelemetry borrowing = new RecordingOpenTelemetry();
        RecordingOpenTelemetry dedicated = new RecordingOpenTelemetry()) {
      List<Heartbeat.Batch> shared =
          Heartbeat.batches(counted(1, OpenTelemetryTelemetry.of(borrowing.sdk())));
      new Heartbeat(null, false, borrowingRound)
          .sendBatches(shared, System.nanoTime() + millis(60_000), borrowingRound);
      assertEquals(Map.of("connection", 1L), roundFailures(borrowing));
      List<Heartbeat.Batch> held =
          Heartbeat.batches(counted(1, OpenTelemetryTelemetry.of(dedicated.sdk())));
      Heartbeat heartbeat = new Heartbeat(null, true, dedicatedRound);
      assertThrows(
          SQLException.class,
          () -> heartbeat.sendBatches(held, System.nanoTime() + millis(20), dedicatedRound));
      assertEquals(Map.of("timeout", 1L), roundFailures(dedicated));
    }
  }
}
