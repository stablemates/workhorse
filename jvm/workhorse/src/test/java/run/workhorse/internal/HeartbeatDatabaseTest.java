package run.workhorse.internal;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;
import java.lang.reflect.Proxy;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;
import java.util.concurrent.locks.LockSupport;
import java.util.function.BooleanSupplier;
import java.util.function.LongSupplier;
import javax.sql.DataSource;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.extension.ExtendWith;
import org.postgresql.PGConnection;
import org.postgresql.core.BaseConnection;
import run.workhorse.ConnectionSource;
import run.workhorse.EnqueueOptions;
import run.workhorse.Queue;
import run.workhorse.Worker;
import run.workhorse.testing.ScratchDataSource;
import run.workhorse.testing.ScratchDatabase;

/** The dedicated heartbeat against PostgreSQL, through its bounded transaction. */
@ExtendWith(ScratchDatabase.class)
@Timeout(value = 60, unit = TimeUnit.SECONDS)
class HeartbeatDatabaseTest {
  private static final String LEASE =
      "SELECT worker_id, fence_token, expires_at FROM workhorse.task_runtime"
          + " WHERE task_id = ?::uuid";

  private final ScratchDataSource dataSource = new ScratchDataSource(true);

  private record Lease(String workerId, long fenceToken, Instant expiresAt) {}

  private static Lease lease(UUID taskId) throws SQLException {
    try (Connection connection = ScratchDatabase.connect();
        PreparedStatement statement = connection.prepareStatement(LEASE)) {
      statement.setString(1, taskId.toString());
      try (ResultSet result = statement.executeQuery()) {
        assertTrue(result.next(), "the task holds a lease");
        return new Lease(
            result.getString("worker_id"),
            result.getLong("fence_token"),
            result.getTimestamp("expires_at").toInstant());
      }
    }
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

  /** One attempt that the test registers by hand. It records each status and when it came. */
  private static final class Recorded implements Heartbeat.Member {
    private final Lease lease;
    private final UUID taskId;
    final List<String> statuses = new CopyOnWriteArrayList<>();
    final List<Long> statusAt = new CopyOnWriteArrayList<>();
    final AtomicInteger renewals = new AtomicInteger();
    final AtomicLong renewedAt = new AtomicLong();
    final AtomicLong lastRenewedAt = new AtomicLong();
    private final long interval;

    /** The local lease window always ends this many nanoseconds after each read. */
    final AtomicLong windowLeft = new AtomicLong(TimeUnit.SECONDS.toNanos(30));

    Recorded(UUID taskId, Lease lease) {
      this(taskId, lease, TimeUnit.SECONDS.toNanos(1));
    }

    Recorded(UUID taskId, Lease lease, long interval) {
      this.taskId = taskId;
      this.lease = lease;
      this.interval = interval;
    }

    @Override
    public String workerId() {
      return lease.workerId();
    }

    @Override
    public UUID taskId() {
      return taskId;
    }

    @Override
    public long fenceToken() {
      return lease.fenceToken();
    }

    @Override
    public long leaseMs() {
      return 30_000;
    }

    @Override
    public long intervalNanos() {
      return interval;
    }

    @Override
    public long leaseEndsAt() {
      return System.nanoTime() + windowLeft.get();
    }

    @Override
    public void renew(long sentAt) {
      renewedAt.compareAndSet(0, System.nanoTime());
      lastRenewedAt.set(System.nanoTime());
      renewals.incrementAndGet();
    }

    @Override
    public void settle(String status) {
      statusAt.add(System.nanoTime());
      statuses.add(status);
    }

    @Override
    public void fail(Exception error) {
      throw new AssertionError(error);
    }
  }

  /**
   * SM-1443: a round does not wait on a task row that another transaction holds. It reports the
   * lease busy at once, renews nothing, and the round after the commit renews the lease.
   */
  @Test
  void reportsALeaseBusyAtOnceWhileAnotherTransactionHoldsItsRow() throws Exception {
    String queueName = "jvm-heartbeat-busy-" + UUID.randomUUID();
    UUID taskId =
        new Queue(ConnectionSource.of(dataSource))
            .enqueue("held", Map.of(), EnqueueOptions.builder().queue(queueName).build())
            .taskId();
    CountDownLatch started = new CountDownLatch(1);
    CountDownLatch release = new CountDownLatch(1);
    // The worker's own heartbeat is far away, so only the test's heartbeat renews in the test.
    Worker worker =
        Worker.builder(dataSource)
            .queues(queueName)
            .workerId("jvm-heartbeat-busy")
            .pollingOnly(true)
            .pollInterval(Duration.ofMillis(10))
            .disableRegistry(true)
            .lease(Duration.ofSeconds(30))
            .heartbeat(Duration.ofSeconds(10))
            .handle(
                "held",
                Object.class,
                (ctx, payload) -> {
                  started.countDown();
                  release.await(30, TimeUnit.SECONDS);
                  return Map.of();
                })
            .build();
    ExecutorService runner = Executors.newSingleThreadExecutor();
    Heartbeat heartbeat = new Heartbeat(dataSource, true);
    Runnable unregister = () -> {};
    try (Connection blocker = ScratchDatabase.connect()) {
      Future<Boolean> run = runner.submit(worker::runOnce);
      assertTrue(started.await(20, TimeUnit.SECONDS), "the handler started");
      Lease claimed = lease(taskId);
      blocker.setAutoCommit(false);
      try (PreparedStatement lock =
          blocker.prepareStatement(
              "SELECT FROM workhorse.task_runtime WHERE task_id = ?::uuid FOR UPDATE")) {
        lock.setString(1, taskId.toString());
        lock.execute();
      }
      Recorded member = new Recorded(taskId, claimed);
      long registeredAt = System.nanoTime();
      unregister = heartbeat.register(member);
      waitUntil("a round reported the lease busy", () -> !member.statuses.isEmpty());
      // SM-1550: the heartbeat thread can still add to a shared list, so each check reads one copy.
      List<Long> answeredAt = List.copyOf(member.statusAt);
      List<String> answers = List.copyOf(member.statuses);
      // The first round falls due one interval of 1 s after the registration. Its bound is 750 ms,
      // and a busy answer comes long before it.
      double answeredMs = (answeredAt.get(0) - registeredAt - TimeUnit.SECONDS.toNanos(1)) / 1e6;
      assertTrue(answeredMs < 300, "the busy answer came " + answeredMs + " ms after the slot");
      assertEquals("busy", answers.get(0));
      assertEquals(0, member.renewals.get(), "a busy round renews nothing");
      assertEquals(claimed.expiresAt(), lease(taskId).expiresAt(), "the lease did not change");
      blocker.commit();
      waitUntil("a round renewed the lease", () -> member.renewals.get() > 0);
      // A busy retry renews the lease before the next regular slot at 2 s.
      double renewedMs = (member.renewedAt.get() - registeredAt) / 1e6;
      assertTrue(renewedMs < 1_900, "the lease was renewed " + renewedMs + " ms after the start");
      assertTrue(lease(taskId).expiresAt().isAfter(claimed.expiresAt()), "the lease was renewed");
      List<String> statuses = List.copyOf(member.statuses);
      assertTrue(statuses.stream().allMatch("busy"::equals), "only busy statuses: " + statuses);
      unregister.run();
      release.countDown();
      assertTrue(run.get(20, TimeUnit.SECONDS), "the worker ran the task");
    } finally {
      unregister.run();
      release.countDown();
      runner.shutdownNow();
    }
  }

  /**
   * A source over {@code source} that counts checkouts and records the backend PID of each. Once
   * {@link #hold} is true, a checkout waits until {@link #open} counts down. Each checkout runs
   * {@link #onCheckout} after it counts. Once {@link #holdClose} is true, the next close counts
   * down {@link #closing}, and then waits until {@link #closeOpen} counts down.
   */
  private static final class Gated {
    final AtomicInteger checkouts = new AtomicInteger();
    final AtomicInteger openConnections = new AtomicInteger();
    final AtomicInteger waiting = new AtomicInteger();
    final List<Integer> backends = new CopyOnWriteArrayList<>();
    final AtomicBoolean hold = new AtomicBoolean();
    final CountDownLatch open = new CountDownLatch(1);
    volatile Runnable onCheckout = () -> {};
    final AtomicBoolean holdClose = new AtomicBoolean();
    final CountDownLatch closing = new CountDownLatch(1);
    final CountDownLatch closeOpen = new CountDownLatch(1);

    DataSource over(DataSource source) {
      return (DataSource)
          Proxy.newProxyInstance(
              DataSource.class.getClassLoader(),
              new Class<?>[] {DataSource.class},
              (proxy, method, arguments) -> {
                if (!method.getName().equals("getConnection")) {
                  return Watched.invoke(method, source, arguments);
                }
                checkouts.incrementAndGet();
                onCheckout.run();
                if (hold.get()) {
                  waiting.incrementAndGet();
                  try {
                    open.await(30, TimeUnit.SECONDS);
                  } finally {
                    waiting.decrementAndGet();
                  }
                }
                Connection connection = (Connection) Watched.invoke(method, source, arguments);
                backends.add(connection.unwrap(PGConnection.class).getBackendPID());
                openConnections.incrementAndGet();
                AtomicBoolean closed = new AtomicBoolean();
                return (Connection)
                    Proxy.newProxyInstance(
                        Connection.class.getClassLoader(),
                        new Class<?>[] {Connection.class},
                        (inner, call, values) -> {
                          if (call.getName().equals("close")
                              && holdClose.compareAndSet(true, false)) {
                            closing.countDown();
                            closeOpen.await(30, TimeUnit.SECONDS);
                          }
                          if (call.getName().equals("close") && closed.compareAndSet(false, true)) {
                            openConnections.decrementAndGet();
                          }
                          return Watched.invoke(call, connection, values);
                        });
              });
    }
  }

  /**
   * SM-1569: a dedicated heartbeat replaces a lost connection on a checkout thread. While that
   * checkout waits, the reservation is not connected, no round renews, and the heartbeat starts no
   * second checkout. The installed replacement wakes the reservation, and the next round renews.
   */
  @Test
  void replacesALostConnectionOnACheckoutThreadAndWakesTheReservation() throws Exception {
    Gated gated = new Gated();
    Heartbeat heartbeat = new Heartbeat(gated.over(dataSource), true);
    AtomicInteger wakes = new AtomicInteger();
    Heartbeat.Reservation reservation =
        heartbeat.reserve(TimeUnit.SECONDS.toNanos(1), wakes::incrementAndGet);
    Runnable unregister = () -> {};
    try (RunningTask task = new RunningTask("replaced")) {
      assertTrue(
          reservation.await(System.nanoTime() + TimeUnit.SECONDS.toNanos(5), () -> false),
          "the reservation gets its connection");
      assertEquals(1, wakes.get(), "the first connection wakes the reservation");
      Recorded member = new Recorded(task.taskId, task.claimed);
      unregister = heartbeat.register(member);
      waitUntil("a round renewed the lease", () -> member.renewals.get() > 0);

      gated.hold.set(true);
      try (Connection admin = ScratchDatabase.connect();
          PreparedStatement terminate = admin.prepareStatement("SELECT pg_terminate_backend(?)")) {
        terminate.setInt(1, gated.backends.get(0));
        terminate.execute();
      }
      waitUntil("the failed round discarded the connection", () -> !reservation.connected());
      waitUntil("the replacement checkout waits", () -> gated.waiting.get() == 1);
      int renewals = member.renewals.get();
      // Two more slots of 1 s pass without a connection.
      Thread.sleep(2_200);
      assertEquals(2, gated.checkouts.get(), "one replacement checkout at a time");
      assertEquals(renewals, member.renewals.get(), "no round renews without a connection");
      assertTrue(member.statuses.isEmpty(), "statuses: " + List.copyOf(member.statuses));

      gated.open.countDown();
      waitUntil("the replacement wakes the reservation", () -> wakes.get() == 2);
      assertTrue(reservation.connected(), "the heartbeat holds the replacement");
      waitUntil("a round renewed on the replacement", () -> member.renewals.get() > renewals);
    } finally {
      unregister.run();
      reservation.close();
      gated.open.countDown();
    }
  }

  /** Terminates the backend {@code pid}, so the next round on its connection fails. */
  private static void terminate(String pid) throws SQLException {
    try (Connection admin = ScratchDatabase.connect();
        PreparedStatement terminate = admin.prepareStatement("SELECT pg_terminate_backend(?)")) {
      terminate.setInt(1, Integer.parseInt(pid));
      terminate.execute();
    }
  }

  /**
   * The rounds around one replacement connection, as the heartbeat counts them ({@link
   * Heartbeat#roundsStarted}). Each value is 0 until it is known.
   */
  private static final class Replacement {
    /** The first round that waited for a connection. */
    final AtomicLong waitingRound = new AtomicLong();

    /** The first round that got its connection before its deadline after a wait. */
    final AtomicLong receivedRound = new AtomicLong();

    /** The renewals of the member when the round started to wait, after the termination. */
    final AtomicInteger renewalsAtWait = new AtomicInteger(-1);

    final CountDownLatch waiting = new CountDownLatch(1);

    Replacement(Heartbeat heartbeat, Recorded member) {
      heartbeat.onAwaitConnection =
          () -> {
            if (waitingRound.compareAndSet(0, heartbeat.roundsStarted.get())) {
              renewalsAtWait.set(member.renewals.get());
              waiting.countDown();
            }
          };
      heartbeat.onConnectionInRound =
          () -> receivedRound.compareAndSet(0, heartbeat.roundsStarted.get());
    }

    /** True when the member has a renewal that the round after the wait reported. */
    boolean renewed(Recorded member) {
      int before = renewalsAtWait.get();
      return before >= 0 && member.renewals.get() > before;
    }

    /**
     * Checks that the round that waited got the replacement, so the delivery came inside that
     * round's bound, and that the next round sent the first statement on it. Returns that
     * statement.
     */
    Watched.Sent firstOnReplacement(Watched watched) {
      long waited = waitingRound.get();
      assertEquals(
          waited,
          receivedRound.get(),
          "the round that waited got the replacement before its deadline");
      assertEquals(2, watched.checkouts.get(), "one replacement connection");
      Watched.Sent first = watched.firstHeartbeat(watched.checkoutPids.get(1));
      assertEquals(
          waited + 1,
          first.round(),
          "the round after the one that waited sent the first statement on the replacement");
      return first;
    }
  }

  /**
   * SM-1569: the first round on a replacement connection has the full round bound. The interval is
   * 2 s, so a round has a bound of 1.5 s. The replacement checkout is held until a round waits for
   * it, and it arrives about 0.6 s into that round's bound. The round that waited gets it and sends
   * nothing, and the next round runs at once on the replacement. The first statement on the
   * replacement thus gets one quarter of the full bound as its {@code statement_timeout}, about 375
   * ms. Without the fix the round that waited sends it, with one quarter of the 0.9 s that it had
   * left, about 225 ms.
   */
  @Test
  void startsTheFirstRoundOnAReplacementWithTheFullBound() throws Exception {
    Watched watched = new Watched();
    Heartbeat heartbeat = new Heartbeat(watched.over(dataSource), true);
    watched.round = heartbeat.roundsStarted::get;
    Runnable unregister = () -> {};
    try (RunningTask task = new RunningTask("replaced-bound")) {
      Recorded member = new Recorded(task.taskId, task.claimed, TimeUnit.SECONDS.toNanos(2));
      unregister = heartbeat.register(member);
      waitUntil("a round renewed the lease", () -> member.renewals.get() > 0);
      Replacement replacement = new Replacement(heartbeat, member);
      watched.holdCheckout.set(true);
      terminate(watched.checkoutPids.get(0));
      assertTrue(
          replacement.waiting.await(20, TimeUnit.SECONDS), "a round waits for the replacement");
      // The replacement arrives about 0.6 s into the waiting round's bound of 1.5 s.
      Thread.sleep(600);
      watched.checkoutOpen.countDown();
      waitUntil("a round renewed on the replacement", () -> replacement.renewed(member));
      Watched.Sent first = replacement.firstOnReplacement(watched);
      long timeout = watched.firstTimeout(first.pid());
      assertTrue(
          timeout >= 300,
          "the first statement on the replacement had a statement timeout of "
              + timeout
              + " ms, not about 375 ms: "
              + List.copyOf(watched.statementTimeouts));
      assertTrue(member.statuses.isEmpty(), "statuses: " + List.copyOf(member.statuses));
    } finally {
      unregister.run();
      watched.checkoutOpen.countDown();
    }
  }

  /**
   * SM-1569, validator round 4: the member with the shortest interval leaves while a round waits
   * for the replacement. The round that waited gets the replacement and sends nothing, and the next
   * round still runs at once on it, so the member with the long interval is renewed at once. A
   * schedule from the old shortest interval would move that round almost a whole long interval
   * away.
   */
  @Test
  void renewsAtOnceOnAReplacementAfterTheShortestIntervalLeft() throws Exception {
    Watched watched = new Watched();
    Heartbeat heartbeat = new Heartbeat(watched.over(dataSource), true);
    watched.round = heartbeat.roundsStarted::get;
    Runnable removeFast = () -> {};
    Runnable removeSlow = () -> {};
    try (RunningTask fastTask = new RunningTask("short-interval");
        RunningTask slowTask = new RunningTask("long-interval")) {
      Recorded fast = new Recorded(fastTask.taskId, fastTask.claimed, TimeUnit.SECONDS.toNanos(1));
      Recorded slow = new Recorded(slowTask.taskId, slowTask.claimed, TimeUnit.SECONDS.toNanos(10));
      removeFast = heartbeat.register(fast);
      removeSlow = heartbeat.register(slow);
      waitUntil(
          "a round renewed both leases", () -> fast.renewals.get() > 0 && slow.renewals.get() > 0);
      Replacement replacement = new Replacement(heartbeat, slow);
      watched.holdCheckout.set(true);
      terminate(watched.checkoutPids.get(0));
      assertTrue(
          replacement.waiting.await(20, TimeUnit.SECONDS), "a round waits for the replacement");
      // The member with the interval of 1 s leaves during the wait, and the replacement arrives.
      removeFast.run();
      long released = System.nanoTime();
      watched.checkoutOpen.countDown();
      waitUntil("the long lease renewed on the replacement", () -> replacement.renewed(slow));
      Watched.Sent first = replacement.firstOnReplacement(watched);
      long renewedAt = slow.lastRenewedAt.get();
      assertTrue(
          renewedAt - first.at() >= 0,
          "the renewal came after the first statement on the replacement");
      double renewedMs = (renewedAt - released) / 1e6;
      assertTrue(
          renewedMs < 2_000,
          "the long lease was renewed " + renewedMs + " ms after the replacement arrived");
    } finally {
      removeFast.run();
      removeSlow.run();
      watched.checkoutOpen.countDown();
    }
  }

  /**
   * SM-1569: a failed renewal on a connection that stays open, and a round that a row lock holds,
   * are not a loss of readiness. The reservation stays connected, so the claim gate stays open, and
   * the heartbeat keeps its one connection.
   *
   * <p>SM-1806: a round that ends after its deadline discards the connection, as in every SDK. So a
   * host that delays one round past its bound fails this test. The failure messages hold the
   * checkouts and the events. They show whether a round aborted or closed the connection, and
   * whether a replacement followed.
   */
  @Test
  void staysConnectedThroughAFailedRenewalAndABusyRound() throws Exception {
    Watched watched = new Watched();
    Heartbeat heartbeat = new Heartbeat(watched.over(dataSource), true);
    Heartbeat.Reservation reservation = heartbeat.reserve(TimeUnit.SECONDS.toNanos(1), () -> {});
    AtomicBoolean disconnected = new AtomicBoolean();
    AtomicBoolean sampling = new AtomicBoolean(true);
    Thread sampler = null;
    Runnable unregister = () -> {};
    try (RunningTask task = new RunningTask("kept");
        Connection blocker = ScratchDatabase.connect()) {
      assertTrue(
          reservation.await(System.nanoTime() + TimeUnit.SECONDS.toNanos(5), () -> false),
          "the reservation gets its connection");
      sampler =
          Thread.ofVirtual()
              .start(
                  () -> {
                    while (sampling.get()) {
                      if (!reservation.connected()) {
                        disconnected.set(true);
                      }
                      LockSupport.parkNanos(TimeUnit.MILLISECONDS.toNanos(2));
                    }
                  });
      watched.failHeartbeats.set(1);
      Recorded member = new Recorded(task.taskId, task.claimed);
      unregister = heartbeat.register(member);
      waitUntil("a round renewed after the failed one", () -> member.renewals.get() > 0);
      List<String> events = List.copyOf(watched.events);
      assertTrue(
          events.stream().anyMatch(event -> event.startsWith("failed heartbeat")),
          "events: " + events);

      blocker.setAutoCommit(false);
      try (PreparedStatement lock =
          blocker.prepareStatement(
              "SELECT FROM workhorse.task_runtime WHERE task_id = ?::uuid FOR UPDATE")) {
        lock.setString(1, task.taskId.toString());
        lock.execute();
      }
      waitUntil("a round reported the lease busy", () -> member.statuses.contains("busy"));
      int renewals = member.renewals.get();
      blocker.commit();
      waitUntil("a round renewed after the lock", () -> member.renewals.get() > renewals);

      sampling.set(false);
      sampler.join(Duration.ofSeconds(5));
      assertFalse(
          disconnected.get(),
          () -> "the reservation stayed connected; " + checkoutsAndEvents(watched));
      assertEquals(
          1,
          watched.checkouts.get(),
          () -> "the heartbeat kept its one connection; " + checkoutsAndEvents(watched));
    } finally {
      sampling.set(false);
      unregister.run();
      reservation.close();
    }
  }

  /**
   * The checkouts of {@code watched}, as a count and the backend PID of each, and its events, for a
   * failure message.
   */
  private static String checkoutsAndEvents(Watched watched) {
    return "checkouts: "
        + watched.checkouts.get()
        + " "
        + watched.checkoutPids
        + ", events: "
        + watched.events;
  }

  /**
   * SM-1569: a connection that arrives after every wait for it timed out has one owner, the
   * checkout thread, which gives it back to the pool. Waits that time out again and again run one
   * checkout, not one each.
   */
  @Test
  void runsOneCheckoutForRepeatedTimeoutsAndClosesTheLateConnection() throws Exception {
    Gated gated = new Gated();
    gated.hold.set(true);
    Heartbeat heartbeat = new Heartbeat(gated.over(dataSource), true);
    try {
      for (int attempt = 0; attempt < 5; attempt++) {
        Heartbeat.Reservation reservation =
            heartbeat.reserve(TimeUnit.SECONDS.toNanos(1), () -> {});
        assertFalse(
            reservation.await(System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(50), () -> false),
            "the held checkout gives no connection");
        reservation.close();
      }
      waitUntil("the checkout waits", () -> gated.waiting.get() == 1);
      assertEquals(1, gated.checkouts.get(), "five timed-out waits ran one checkout");
    } finally {
      gated.open.countDown();
    }
    waitUntil("the checkout got its connection", () -> gated.backends.size() == 1);
    waitUntil("the late connection went back to the pool", () -> gated.openConnections.get() == 0);
    assertEquals(1, gated.checkouts.get(), "nothing needed a second checkout");
  }

  /**
   * SM-1580: the last reservation closes, and the heartbeat lets its connection go. The pool takes
   * that connection back slowly. A new reservation waits for the return, so the heartbeat never has
   * two connections out.
   */
  @Test
  void waitsForTheReturnOfTheLastConnectionBeforeTheNextCheckout() throws Exception {
    Gated gated = new Gated();
    Heartbeat heartbeat = new Heartbeat(gated.over(dataSource), true);
    Heartbeat.Reservation first = heartbeat.reserve(TimeUnit.SECONDS.toNanos(1), () -> {});
    try {
      assertTrue(
          first.await(System.nanoTime() + TimeUnit.SECONDS.toNanos(20), () -> false),
          "the first reservation gets the connection");
      gated.holdClose.set(true);
    } finally {
      first.close();
    }
    assertTrue(gated.closing.await(20, TimeUnit.SECONDS), "the return of the connection waits");
    assertTheNextCheckoutWaitsForTheReturn(gated, heartbeat);
  }

  /**
   * SM-1580: a checkout gives its connection after the last reservation closed, so nothing needs
   * it. The pool takes that connection back slowly. A new reservation waits for the return, so the
   * heartbeat never has two connections out.
   */
  @Test
  void waitsForTheReturnOfAnUnwantedConnectionBeforeTheNextCheckout() throws Exception {
    Gated gated = new Gated();
    gated.hold.set(true);
    Heartbeat heartbeat = new Heartbeat(gated.over(dataSource), true);
    Heartbeat.Reservation first = heartbeat.reserve(TimeUnit.SECONDS.toNanos(1), () -> {});
    try {
      waitUntil("the checkout waits", () -> gated.waiting.get() == 1);
      gated.holdClose.set(true);
    } finally {
      first.close();
    }
    gated.open.countDown();
    assertTrue(gated.closing.await(20, TimeUnit.SECONDS), "the return of the connection waits");
    assertTheNextCheckoutWaitsForTheReturn(gated, heartbeat);
  }

  /**
   * Reserves the connection while the return of the previous one waits on {@link Gated#closeOpen}.
   * The reservation decides at once whether it starts a checkout: a new checkout runs {@link
   * Gated#onCheckout}, and a wait for the return runs {@link Heartbeat#onReturnPending}.
   */
  private static void assertTheNextCheckoutWaitsForTheReturn(Gated gated, Heartbeat heartbeat)
      throws Exception {
    CountDownLatch decided = new CountDownLatch(1);
    heartbeat.onReturnPending = decided::countDown;
    gated.onCheckout = decided::countDown;
    Heartbeat.Reservation next = heartbeat.reserve(TimeUnit.SECONDS.toNanos(1), () -> {});
    try {
      assertTrue(decided.await(20, TimeUnit.SECONDS), "the new reservation decided");
      assertEquals(1, gated.checkouts.get(), "no second checkout starts while the return runs");
      gated.closeOpen.countDown();
      assertTrue(
          next.await(System.nanoTime() + TimeUnit.SECONDS.toNanos(20), () -> false),
          "the new reservation gets the next connection after the return");
      assertEquals(2, gated.checkouts.get(), "the next connection is the second checkout");
      assertEquals(1, gated.openConnections.get(), "one heartbeat connection is out");
    } finally {
      gated.closeOpen.countDown();
      next.close();
    }
    waitUntil("the connection went back to the pool", () -> gated.openConnections.get() == 0);
  }

  /**
   * A task whose handler runs until {@link #close}. The worker's own heartbeat is far away, so only
   * the test's heartbeat renews in the test.
   */
  private final class RunningTask implements AutoCloseable {
    final UUID taskId;
    final Lease claimed;
    private final CountDownLatch release = new CountDownLatch(1);
    private final ExecutorService runner = Executors.newSingleThreadExecutor();
    private final Future<Boolean> run;

    RunningTask(String name) throws Exception {
      String queueName = "jvm-heartbeat-" + name + "-" + UUID.randomUUID();
      taskId =
          new Queue(ConnectionSource.of(dataSource))
              .enqueue("held", Map.of(), EnqueueOptions.builder().queue(queueName).build())
              .taskId();
      CountDownLatch started = new CountDownLatch(1);
      Worker worker =
          Worker.builder(dataSource)
              .queues(queueName)
              .workerId("jvm-heartbeat-" + name)
              .pollingOnly(true)
              .pollInterval(Duration.ofMillis(10))
              .disableRegistry(true)
              .lease(Duration.ofSeconds(30))
              .heartbeat(Duration.ofSeconds(10))
              .handle(
                  "held",
                  Object.class,
                  (ctx, payload) -> {
                    started.countDown();
                    release.await(30, TimeUnit.SECONDS);
                    return Map.of();
                  })
              .build();
      run = runner.submit(worker::runOnce);
      assertTrue(started.await(20, TimeUnit.SECONDS), "the handler started");
      claimed = lease(taskId);
    }

    @Override
    public void close() throws ExecutionException, TimeoutException {
      release.countDown();
      try {
        assertTrue(run.get(20, TimeUnit.SECONDS), "the worker ran the task");
      } catch (InterruptedException interrupted) {
        Thread.currentThread().interrupt();
        throw new AssertionError(interrupted);
      } finally {
        runner.shutdownNow();
      }
    }
  }

  /**
   * A source over {@code source} that records, in order, what the heartbeat does on each
   * connection, with the backend PID of the connection. While {@link #slowSettingsMs} is above
   * zero, the next settings statement waits that long before it goes out, so the round passes the
   * quarter that it keeps for {@code COMMIT}.
   */
  private static final class Watched {
    final AtomicInteger checkouts = new AtomicInteger();
    final List<String> events = new CopyOnWriteArrayList<>();
    final AtomicLong slowSettingsMs = new AtomicLong();
    final AtomicLong slowRollbackMs = new AtomicLong();

    /** The number of heartbeat statements that fail before they go out, on an open connection. */
    final AtomicInteger failHeartbeats = new AtomicInteger();

    /** While true, each checkout waits until {@link #checkoutOpen} counts down. */
    final AtomicBoolean holdCheckout = new AtomicBoolean();

    final CountDownLatch checkoutOpen = new CountDownLatch(1);

    /** The backend PID of each checkout, in checkout order. */
    final List<String> checkoutPids = new CopyOnWriteArrayList<>();

    /** Each heartbeat statement: its backend PID, its round, and when it went out. */
    record Sent(String pid, long round, long at) {}

    /** The heartbeat statements, in order. */
    final List<Sent> heartbeats = new CopyOnWriteArrayList<>();

    /** The round that a heartbeat statement belongs to; a test sets it to the heartbeat's count. */
    volatile LongSupplier round = () -> 0;

    /** The first heartbeat statement on the connection of {@code pid}. */
    Sent firstHeartbeat(String pid) {
      for (Sent sent : heartbeats) {
        if (sent.pid().equals(pid)) {
          return sent;
        }
      }
      throw new AssertionError("no heartbeat statement on backend " + pid + ": " + heartbeats);
    }

    /** The {@code statement_timeout} of each round, as {@code <pid> <milliseconds>}, in order. */
    final List<String> statementTimeouts = new CopyOnWriteArrayList<>();

    /** The {@code statement_timeout} of the first round on the connection of {@code pid}. */
    long firstTimeout(String pid) {
      for (String entry : statementTimeouts) {
        int space = entry.indexOf(' ');
        if (entry.substring(0, space).equals(pid)) {
          return Long.parseLong(entry.substring(space + 1));
        }
      }
      throw new AssertionError("no round on backend " + pid + ": " + statementTimeouts);
    }

    DataSource over(DataSource source) {
      return (DataSource)
          Proxy.newProxyInstance(
              DataSource.class.getClassLoader(),
              new Class<?>[] {DataSource.class},
              (proxy, method, arguments) -> {
                if (method.getName().equals("getConnection") && holdCheckout.get()) {
                  checkoutOpen.await(60, TimeUnit.SECONDS);
                }
                Object result = invoke(method, source, arguments);
                if (!method.getName().equals("getConnection")) {
                  return result;
                }
                checkouts.incrementAndGet();
                return connection((Connection) result);
              });
    }

    private Connection connection(Connection connection) throws SQLException {
      int pid = connection.unwrap(PGConnection.class).getBackendPID();
      checkoutPids.add(Integer.toString(pid));
      return (Connection)
          Proxy.newProxyInstance(
              Connection.class.getClassLoader(),
              new Class<?>[] {Connection.class},
              (proxy, method, arguments) -> {
                switch (method.getName()) {
                  case "rollback" ->
                      events.add(
                          "rollback "
                              + connection.unwrap(BaseConnection.class).getTransactionState()
                              + " "
                              + pid);
                  case "close", "abort" -> events.add(method.getName() + " " + pid);
                  default -> {}
                }
                Object result = invoke(method, connection, arguments);
                if (method.getName().equals("rollback")) {
                  long delay = slowRollbackMs.getAndSet(0);
                  if (delay > 0) {
                    // After the rollback, so it succeeds on the server but returns late.
                    Thread.sleep(delay);
                  }
                }
                if (!method.getName().equals("prepareStatement")) {
                  return result;
                }
                String sql = String.valueOf(arguments[0]);
                if (sql.contains("heartbeat_many_v2")) {
                  if (failHeartbeats.getAndUpdate(left -> Math.max(0, left - 1)) > 0) {
                    ((PreparedStatement) result).close();
                    events.add("failed heartbeat " + pid);
                    throw new SQLException("injected heartbeat failure", "XX000");
                  }
                  events.add("heartbeat " + pid);
                  heartbeats.add(
                      new Sent(Integer.toString(pid), round.getAsLong(), System.nanoTime()));
                } else if (sql.contains("statement_timeout")) {
                  events.add("settings " + pid);
                  return settings((PreparedStatement) result, pid);
                }
                return result;
              });
    }

    private PreparedStatement settings(PreparedStatement statement, int pid) {
      return (PreparedStatement)
          Proxy.newProxyInstance(
              PreparedStatement.class.getClassLoader(),
              new Class<?>[] {PreparedStatement.class},
              (proxy, method, arguments) -> {
                if (method.getName().equals("setString")
                    && Integer.valueOf(1).equals(arguments[0])) {
                  statementTimeouts.add(pid + " " + arguments[1]);
                }
                if (method.getName().equals("execute")) {
                  long delay = slowSettingsMs.getAndSet(0);
                  if (delay > 0) {
                    // Before the statement, so BEGIN and the settings then go out at once, and no
                    // idle gap ends the session.
                    Thread.sleep(delay);
                  }
                }
                return invoke(method, statement, arguments);
              });
    }

    private static Object invoke(Method method, Object target, Object[] arguments)
        throws Throwable {
      try {
        return method.invoke(target, arguments);
      } catch (InvocationTargetException error) {
        throw error.getCause();
      }
    }
  }

  /**
   * SM-1492: a round whose settings statement uses more than its quarter rolls back before its
   * heartbeat statement. It keeps the connection, and the next round renews on it.
   */
  @Test
  void keepsTheConnectionWhenARoundExpiresAfterBeginBeforeItsHeartbeat() throws Exception {
    Watched watched = new Watched();
    // The round bound of a 1 s interval is 750 ms, so its quarter is about 187 ms.
    watched.slowSettingsMs.set(300);
    Heartbeat heartbeat = new Heartbeat(watched.over(dataSource), true);
    Runnable unregister = () -> {};
    try (RunningTask task = new RunningTask("expired")) {
      Recorded member = new Recorded(task.taskId, task.claimed);
      unregister = heartbeat.register(member);
      waitUntil("a round renewed the lease", () -> member.renewals.get() > 0);
      unregister.run();
      // SM-1550: the heartbeat thread can still add an event, so the checks read one copy.
      List<String> events = List.copyOf(watched.events);
      assertTrue(events.size() >= 4, "events: " + events);
      String pid = events.get(0).substring("settings ".length());
      assertEquals(
          List.of("settings " + pid, "rollback OPEN " + pid, "settings " + pid, "heartbeat " + pid),
          events.subList(0, 4),
          "the first round sent no heartbeat and rolled back; the next one used the same backend");
      assertEquals(1, watched.checkouts.get(), "the heartbeat kept its connection");
      List<String> statuses = List.copyOf(member.statuses);
      assertTrue(statuses.isEmpty(), "statuses: " + statuses);
      assertTrue(
          lease(task.taskId).expiresAt().isAfter(task.claimed.expiresAt()),
          "the lease was renewed");
    } finally {
      unregister.run();
    }
  }

  /**
   * SM-1492: a round that expires before its heartbeat statement, and whose ROLLBACK returns after
   * the round deadline, does not keep its connection. The next round checks out a new one.
   */
  @Test
  void abortsTheConnectionWhenTheRollbackOfAnExpiredRoundEndsAfterTheDeadline() throws Exception {
    Watched watched = new Watched();
    // The round bound of a 1 s interval is 750 ms. The settings use more than its quarter, and the
    // rollback returns after the deadline.
    watched.slowSettingsMs.set(300);
    watched.slowRollbackMs.set(600);
    Heartbeat heartbeat = new Heartbeat(watched.over(dataSource), true);
    Runnable unregister = () -> {};
    try (RunningTask task = new RunningTask("late-rollback")) {
      Recorded member = new Recorded(task.taskId, task.claimed);
      unregister = heartbeat.register(member);
      waitUntil("a round renewed the lease", () -> member.renewals.get() > 0);
      unregister.run();
      // SM-1550: the heartbeat thread can still add an event, so the checks read one copy.
      List<String> events = List.copyOf(watched.events);
      assertTrue(events.size() >= 3, "events: " + events);
      String pid = events.get(0).substring("settings ".length());
      assertEquals(
          List.of("settings " + pid, "rollback OPEN " + pid, "abort " + pid),
          events.subList(0, 3),
          "the first round sent no heartbeat, and its late rollback discarded the connection");
      assertEquals(2, watched.checkouts.get(), "the next round checked out a new connection");
    } finally {
      unregister.run();
    }
  }

  /**
   * SM-1492: a busy retry whose lease window ends 5 ms after it falls due has less than the 20 ms
   * minimum. It sends nothing, and the regular round at the next slot renews the lease on the same
   * connection.
   */
  @Test
  void skipsABusyRetryWithTooLittleTimeAndRenewsAtTheNextSlot() throws Exception {
    Watched watched = new Watched();
    Heartbeat heartbeat = new Heartbeat(watched.over(dataSource), true);
    Runnable unregister = () -> {};
    try (RunningTask task = new RunningTask("short-retry");
        Connection blocker = ScratchDatabase.connect()) {
      blocker.setAutoCommit(false);
      try (PreparedStatement lock =
          blocker.prepareStatement(
              "SELECT FROM workhorse.task_runtime WHERE task_id = ?::uuid FOR UPDATE")) {
        lock.setString(1, task.taskId.toString());
        lock.execute();
      }
      Recorded member = new Recorded(task.taskId, task.claimed);
      member.windowLeft.set(TimeUnit.MILLISECONDS.toNanos(5));
      long registeredAt = System.nanoTime();
      unregister = heartbeat.register(member);
      waitUntil("a round reported the lease busy", () -> !member.statuses.isEmpty());
      blocker.commit();
      waitUntil("a round renewed the lease", () -> member.renewals.get() > 0);
      unregister.run();
      // The first round falls due at 1 s, and the next regular round at 2 s.
      double renewedMs = (member.renewedAt.get() - registeredAt) / 1e6;
      assertTrue(renewedMs > 1_900, "the lease was renewed " + renewedMs + " ms after the start");
      // SM-1550: the heartbeat thread can still add to a shared list, so each check reads one copy.
      assertEquals(List.of("busy"), List.copyOf(member.statuses), "no retry ran");
      List<String> events = List.copyOf(watched.events);
      List<String> heartbeats =
          events.stream().filter(event -> event.startsWith("heartbeat ")).toList();
      assertEquals(2, heartbeats.size(), "events: " + events);
      assertEquals(heartbeats.get(0), heartbeats.get(1), "both rounds used the same backend");
      assertTrue(
          events.stream().noneMatch(event -> event.startsWith("rollback ")), "events: " + events);
      assertEquals(1, watched.checkouts.get(), "the heartbeat kept its connection");
      assertTrue(
          lease(task.taskId).expiresAt().isAfter(task.claimed.expiresAt()),
          "the lease was renewed");
    } finally {
      unregister.run();
    }
  }
}
