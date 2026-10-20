package run.workhorse.internal;

import static org.junit.jupiter.api.Assertions.assertEquals;
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
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;
import java.util.function.BooleanSupplier;
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

    /** The local lease window always ends this many nanoseconds after each read. */
    final AtomicLong windowLeft = new AtomicLong(TimeUnit.SECONDS.toNanos(30));

    Recorded(UUID taskId, Lease lease) {
      this.taskId = taskId;
      this.lease = lease;
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
      return TimeUnit.SECONDS.toNanos(1);
    }

    @Override
    public long leaseEndsAt() {
      return System.nanoTime() + windowLeft.get();
    }

    @Override
    public void renew(long sentAt) {
      renewedAt.compareAndSet(0, System.nanoTime());
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

    DataSource over(DataSource source) {
      return (DataSource)
          Proxy.newProxyInstance(
              DataSource.class.getClassLoader(),
              new Class<?>[] {DataSource.class},
              (proxy, method, arguments) -> {
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
                  events.add("heartbeat " + pid);
                } else if (sql.contains("statement_timeout")) {
                  events.add("settings " + pid);
                  return settings((PreparedStatement) result);
                }
                return result;
              });
    }

    private PreparedStatement settings(PreparedStatement statement) {
      return (PreparedStatement)
          Proxy.newProxyInstance(
              PreparedStatement.class.getClassLoader(),
              new Class<?>[] {PreparedStatement.class},
              (proxy, method, arguments) -> {
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
