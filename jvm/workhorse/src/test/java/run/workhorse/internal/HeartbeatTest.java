package run.workhorse.internal;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.sql.SQLException;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;
import java.util.function.BooleanSupplier;
import org.jspecify.annotations.Nullable;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;

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

  @Test
  void retriesAFailedRoundNoLaterThanTheNextSlot() {
    // A 40 ms interval: the round that started at 0 failed at 30 ms, so the next slot is in 10 ms.
    assertEquals(millis(10), Heartbeat.retryWaitNanos(0, millis(40), millis(30)));
    // The next slot is later than the retry wait, so the retry wait applies.
    assertEquals(millis(100), Heartbeat.retryWaitNanos(0, millis(10_000), millis(7_500)));
    // The slot has passed, for example after a checkout that the pool refused.
    assertEquals(millis(100), Heartbeat.retryWaitNanos(0, millis(40), millis(50)));
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
      shared.sendBatches(
          batches,
          shared.nextFirstBatch(batches.size()),
          deadline,
          slowFirstBatch(due.get(0).taskId().toString(), sent));
      // A shared round has no deadline, so the batch after the slow one is always sent.
      assertEquals(2, sent.size(), "round " + round);
      assertTrue(sent.get(1).contains(last), "round " + round);
    }
  }

  @Test
  void aDedicatedRoundStartsWithTheNextBatchSoNoBatchStarves() throws Exception {
    List<Heartbeat.Member> due = members(101);
    List<Heartbeat.Batch> batches = Heartbeat.batches(due);
    String last = due.get(100).taskId().toString();
    Heartbeat dedicated = new Heartbeat(null, true);
    int renewedLast = 0;
    for (int round = 0; round < 4; round++) {
      List<String> sent = new ArrayList<>();
      long deadline = System.nanoTime() + millis(ROUND_DEADLINE_MS);
      dedicated.sendBatches(
          batches,
          dedicated.nextFirstBatch(batches.size()),
          deadline,
          slowFirstBatch(due.get(0).taskId().toString(), sent));
      if (sent.stream().anyMatch(payload -> payload.contains(last))) {
        renewedLast++;
      }
    }
    // The slow batch uses the whole deadline when it goes first, so the last lease is sent in the
    // rounds that start with its batch: every second round.
    assertEquals(2, renewedLast);
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
    final AtomicInteger renewals = new AtomicInteger();
    final List<String> statuses = new CopyOnWriteArrayList<>();

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
      return leaseEndsAt.get();
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

  /** A round that records each statement and its overlap, and answers through {@code answer}. */
  private static final class Recorder implements Heartbeat.Round {
    final List<Call> calls = new CopyOnWriteArrayList<>();
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
      Call call = new Call(System.nanoTime(), (String) parameters[1]);
      int index = calls.size();
      calls.add(call);
      overlap.accumulateAndGet(inFlight.incrementAndGet(), Math::max);
      try {
        if (sendMillis > 0) {
          TimeUnit.MILLISECONDS.sleep(sendMillis);
        }
        List<Row> rows = new ArrayList<>();
        for (Map.Entry<UUID, String> entry : answer.statuses(index, call).entrySet()) {
          Map<String, @Nullable Object> values = new LinkedHashMap<>();
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
      waitUntil("a busy retry ran", () -> round.calls.size() >= 2);
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
}
