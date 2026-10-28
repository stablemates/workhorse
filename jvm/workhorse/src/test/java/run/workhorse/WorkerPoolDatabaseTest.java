package run.workhorse;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.zaxxer.hikari.HikariDataSource;
import com.zaxxer.hikari.HikariPoolMXBean;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Proxy;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Statement;
import java.time.Duration;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.function.BooleanSupplier;
import javax.sql.DataSource;
import org.jspecify.annotations.Nullable;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.extension.ExtendWith;
import run.workhorse.testing.DelayedDataSource;
import run.workhorse.testing.ScratchDataSource;
import run.workhorse.testing.ScratchDatabase;

/**
 * SM-1569: workers on one HikariCP pool. The pool waits up to its own 30 s for a connection, which
 * is longer than a lease, so the connections that the workers reserve decide whether a lease can
 * expire. Every worker on one {@code DataSource} object shares one listener connection and one
 * heartbeat connection.
 */
@ExtendWith(ScratchDatabase.class)
@Timeout(value = 120, unit = TimeUnit.SECONDS)
class WorkerPoolDatabaseTest {
  private static final Duration WAIT = Duration.ofSeconds(60);

  private final Queue queue = new Queue(ConnectionSource.of(new ScratchDataSource(true)));
  private String queueName = "";
  private String applicationName = "";

  @BeforeEach
  void name() {
    String id = UUID.randomUUID().toString();
    queueName = "jvm-pool-" + id;
    applicationName = "jvm-pool-test-" + id.substring(0, 8);
  }

  /**
   * A HikariCP pool of {@code size} over the scratch database, with HikariCP's default wait of 30
   * s. It opens a connection only when a caller asks for one, and it names its sessions, so a test
   * finds them in {@code pg_stat_activity}.
   */
  private HikariDataSource pool(int size) {
    HikariDataSource pool = new HikariDataSource();
    pool.setDataSource(new ScratchDataSource(true));
    pool.setMaximumPoolSize(size);
    pool.setMinimumIdle(0);
    pool.setPoolName(applicationName);
    pool.setConnectionInitSql("SET application_name = '" + applicationName + "'");
    return pool;
  }

  private Worker.Builder worker(DataSource pool, String workerId) {
    return Worker.builder(pool)
        .queues(queueName)
        .workerId(workerId)
        .disableRegistry(true)
        .lease(Duration.ofSeconds(3))
        .heartbeat(Duration.ofSeconds(1));
  }

  private UUID enqueue(String taskType) {
    return queue
        .enqueue(taskType, Map.of(), EnqueueOptions.builder().queue(queueName).build())
        .taskId();
  }

  /** The count that {@code sql} returns for its one text parameter {@code parameter}. */
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

  private Set<String> completedBy() throws SQLException {
    Set<String> workers = new HashSet<>();
    try (Connection connection = ScratchDatabase.connect();
        PreparedStatement statement =
            connection.prepareStatement(
                "SELECT DISTINCT h.worker_id FROM workhorse.attempt_history h"
                    + " JOIN workhorse.task t ON t.id = h.task_id"
                    + " WHERE t.queue_name = ? AND h.outcome = 'succeeded'")) {
      statement.setString(1, queueName);
      try (ResultSet result = statement.executeQuery()) {
        while (result.next()) {
          workers.add(result.getString(1));
        }
      }
    }
    return workers;
  }

  private static void waitUntil(String what, BooleanSupplier condition) {
    long deadline = System.nanoTime() + WAIT.toNanos();
    while (!condition.getAsBoolean()) {
      if (System.nanoTime() > deadline) {
        throw new AssertionError("timed out waiting until " + what);
      }
      try {
        Thread.sleep(20);
      } catch (InterruptedException interrupted) {
        Thread.currentThread().interrupt();
        throw new AssertionError("interrupted waiting until " + what, interrupted);
      }
    }
  }

  private long succeeded() {
    try {
      return count(
          "SELECT count(*) FROM workhorse.task t"
              + " JOIN workhorse.task_outcome o ON o.task_id = t.id"
              + " WHERE t.queue_name = ? AND o.state = 'succeeded'",
          queueName);
    } catch (SQLException error) {
      throw new AssertionError(error);
    }
  }

  /** Takes every connection that the pool still has, so the pool is full. */
  private static List<Connection> fill(HikariDataSource pool) throws SQLException {
    HikariPoolMXBean bean = pool.getHikariPoolMXBean();
    List<Connection> held = new ArrayList<>();
    while (bean.getTotalConnections() < pool.getMaximumPoolSize()
        || bean.getIdleConnections() > 0) {
      held.add(pool.getConnection());
    }
    return held;
  }

  private static void closeAll(List<Connection> connections) {
    for (Connection connection : connections) {
      try {
        connection.close();
      } catch (SQLException ignored) {
        // The pool replaces a broken connection.
      }
    }
  }

  /**
   * The SM-1565 lease loss: eight listening workers on a pool of six. Before SM-1569 the listener
   * connections of the workers filled the pool, and the heartbeat waited for HikariCP's 30 s, so
   * the leases of 3 s expired. With one shared listener connection and one shared heartbeat
   * connection, every worker claims, renews, and completes its tasks, with one attempt each.
   */
  @Test
  void manyWorkersOnASmallPoolKeepEveryLease() throws Exception {
    try (HikariDataSource pool = pool(6)) {
      keepEveryLease(pool);
    }
  }

  /**
   * SM-1633: the same workers when each round trip to PostgreSQL takes 80 ms more. The shared
   * heartbeat sends one transaction for all 8 workers in each round: BEGIN with the settings
   * statement, one {@code heartbeat_pool_v1} statement, and {@code COMMIT}. So a round needs 3
   * round trips, about 0.25 s, for any number of workers. Each idle gap of 80 ms stays inside the
   * idle budget, one quarter of the time that remains. Before SM-1633, a round needed 3 round trips
   * for each worker, so the rounds could not renew every lease of 3 s.
   */
  @Test
  void manyWorkersOnASmallPoolKeepEveryLeaseWhenEachRoundTripTakes80Ms() throws Exception {
    try (HikariDataSource pool = pool(6)) {
      // The test measures round trips, not the disk. Other test databases on the same server can
      // make a WAL flush wait for seconds, so a COMMIT of the workers does not wait for its flush.
      pool.setConnectionInitSql(
          "SET application_name = '" + applicationName + "'; SET synchronous_commit = off");
      keepEveryLease(DelayedDataSource.wrap(pool, Duration.ofMillis(80)));
    }
  }

  /**
   * Eight workers with two slots each on {@code pool}, a pool of 6. Each worker claims, renews, and
   * completes its tasks, with one attempt each.
   */
  private void keepEveryLease(DataSource pool) throws Exception {
    int workers = 8;
    int concurrency = 2;
    // Two waves fill every slot, so each worker claims and refills.
    int tasks = 2 * workers * concurrency;
    for (int task = 0; task < tasks; task++) {
      enqueue("held");
    }
    List<Worker> started = new ArrayList<>();
    try {
      for (int index = 0; index < workers; index++) {
        Worker worker =
            worker(pool, "jvm-pool-" + index)
                .concurrency(concurrency)
                .handle(
                    "held",
                    Object.class,
                    (ctx, payload) -> {
                      // Longer than the lease, so only renewals keep it.
                      Thread.sleep(4_000);
                      return Map.of();
                    })
                .build();
        started.add(worker);
        worker.start();
      }
      waitUntil("every task succeeded", () -> succeeded() == tasks);
    } finally {
      started.forEach(Worker::stop);
      for (Worker worker : started) {
        worker.close();
      }
    }
    assertEquals(
        0,
        count(
            "SELECT count(*) FROM workhorse.attempt_history h"
                + " JOIN workhorse.task t ON t.id = h.task_id"
                + " WHERE t.queue_name = ? AND h.outcome = 'lease_expired'",
            queueName),
        "no lease expired");
    assertEquals(
        1,
        count(
            "SELECT max(r.current_attempt) FROM workhorse.task t"
                + " JOIN workhorse.task_outcome r ON r.task_id = t.id WHERE t.queue_name = ?",
            queueName),
        "every task ran once");
    Set<String> expected = new HashSet<>();
    for (int index = 0; index < workers; index++) {
      expected.add("jvm-pool-" + index);
    }
    assertEquals(expected, completedBy(), "every worker completed tasks");
  }

  /**
   * Two workers on one {@code DataSource} object hold one listener connection and one heartbeat
   * connection between them, while both run a handler.
   */
  @Test
  void workersOnOneDataSourceHoldOneListenerAndOneHeartbeatConnection() throws Exception {
    CountDownLatch running = new CountDownLatch(2);
    CountDownLatch release = new CountDownLatch(1);
    enqueue("held");
    enqueue("held");
    List<Worker> started = new ArrayList<>();
    try (HikariDataSource pool = pool(10)) {
      try {
        for (int index = 0; index < 2; index++) {
          Worker worker =
              worker(pool, "jvm-pool-share-" + index)
                  .handle(
                      "held",
                      Object.class,
                      (ctx, payload) -> {
                        running.countDown();
                        release.await(60, TimeUnit.SECONDS);
                        return Map.of();
                      })
                  .build();
          started.add(worker);
          worker.start();
        }
        assertTrue(running.await(30, TimeUnit.SECONDS), "both handlers run");
        // Two heartbeat intervals, so the heartbeat renewed both leases in its rounds.
        Thread.sleep(2_000);
        HikariPoolMXBean bean = pool.getHikariPoolMXBean();
        int fewest = Integer.MAX_VALUE;
        for (int sample = 0; sample < 50; sample++) {
          fewest = Math.min(fewest, bean.getActiveConnections());
          Thread.sleep(20);
        }
        assertEquals(2, fewest, "the pool lends one listener and one heartbeat connection");
        assertEquals(
            1,
            count(
                "SELECT count(*) FROM pg_stat_activity WHERE datname = current_database()"
                    + " AND application_name = ? AND query = 'LISTEN workhorse_tasks'",
                applicationName),
            "one session listens");
      } finally {
        started.forEach(Worker::stop);
        release.countDown();
        for (Worker worker : started) {
          worker.close();
        }
      }
    }
  }

  /**
   * A stop finishes within its grace and one unwind window, even when the pool keeps no free
   * connection for the stop's own statements. Three waiters queue for the pool before the stop, so
   * each connection that the stop gives back goes to a waiter, and the pool stays full.
   */
  @Test
  void stopsWithinTheGraceWhenThePoolIsFull() throws Exception {
    long graceMs = 2_000;
    try (HikariDataSource pool = pool(4)) {
      Worker worker =
          worker(pool, "jvm-pool-stop")
              .disableRegistry(false)
              .registryInterval(Duration.ofMillis(100))
              .shutdownGrace(Duration.ofMillis(graceMs))
              .handle("held", Object.class, (ctx, payload) -> Map.of())
              .build();
      worker.start();
      List<Connection> held = new CopyOnWriteArrayList<>();
      List<Thread> waiters = new ArrayList<>();
      try {
        Admin admin = new Admin(ConnectionSource.of(new ScratchDataSource(true)));
        waitUntil(
            "the worker registers",
            () ->
                admin.listWorkers().stream()
                    .anyMatch(info -> info.workerId().equals(worker.workerId())));
        held.addAll(fill(pool));
        for (int index = 0; index < 3; index++) {
          waiters.add(
              Thread.ofVirtual()
                  .start(
                      () -> {
                        try {
                          held.add(pool.getConnection());
                        } catch (SQLException closed) {
                          // The pool closed at the end of the test.
                        }
                      }));
        }
        HikariPoolMXBean bean = pool.getHikariPoolMXBean();
        waitUntil("three waiters queue", () -> bean.getThreadsAwaitingConnection() >= 3);
        long stopAt = System.nanoTime();
        worker.close();
        double stopMs = (System.nanoTime() - stopAt) / 1e6;
        // The total stop time is the grace plus the unwind window of 250 ms. The margin covers
        // thread scheduling on a loaded machine.
        assertTrue(stopMs < graceMs + 250 + 150, "the stop took " + stopMs + " ms");
      } finally {
        closeAll(held);
        worker.close();
      }
      for (Thread waiter : waiters) {
        waiter.join(Duration.ofSeconds(5));
      }
      closeAll(held);
    }
  }

  /**
   * A worker that cannot get its heartbeat connection within its startup budget, max(interval, 5
   * s), does not start. It does not wait for the 30 s of HikariCP, and its error names the budget,
   * the unknown pool size, and the next step.
   */
  @Test
  void refusesToStartWithoutItsHeartbeatConnection() throws Exception {
    try (HikariDataSource pool = pool(2)) {
      List<Connection> held = new ArrayList<>();
      try {
        held.add(pool.getConnection());
        held.add(pool.getConnection());
        Worker worker =
            Worker.builder(pool)
                .queues(queueName)
                .disableRegistry(true)
                .lease(Duration.ofSeconds(1))
                .heartbeat(Duration.ofMillis(300))
                .handle("held", Object.class, (ctx, payload) -> Map.of())
                .build();
        long startAt = System.nanoTime();
        WorkhorseException error = assertThrows(WorkhorseException.class, worker::run);
        double waitedMs = (System.nanoTime() - startAt) / 1e6;
        assertTrue(waitedMs >= 4_900 && waitedMs < 10_000, "the worker waited " + waitedMs + " ms");
        String message = String.valueOf(error.getMessage());
        assertTrue(message.contains("no heartbeat connection"), message);
        assertTrue(message.contains("at least 3 connections"), message);
        assertTrue(message.contains("no poolMaxSize is declared"), message);
        assertTrue(
            message.contains("Grow the pool, or check that the database accepts connections."),
            message);
        assertFalse(message.contains("sharedHeartbeats"), message);
      } finally {
        closeAll(held);
      }
    }
  }

  /**
   * A pool of 2 gives the heartbeat and the listener one connection each, and leaves none for a
   * statement. The readiness check finds that, and the worker refuses to start. The refusal gives
   * both reserved connections back.
   */
  @Test
  void refusesToStartOnAPoolOfTwo() throws Exception {
    try (HikariDataSource pool = pool(2)) {
      Worker worker =
          worker(pool, "jvm-pool-two")
              .handle("held", Object.class, (ctx, payload) -> Map.of())
              .build();
      long startAt = System.nanoTime();
      worker.start();
      try {
        waitUntil("the worker refuses to start", () -> !worker.isRunning());
      } finally {
        worker.stop();
      }
      double waitedMs = (System.nanoTime() - startAt) / 1e6;
      assertTrue(waitedMs < 10_000, "the worker waited " + waitedMs + " ms");
      WorkhorseException error = assertThrows(WorkhorseException.class, worker::close);
      String message = String.valueOf(error.getMessage());
      assertTrue(message.contains("startup check"), message);
      assertTrue(
          message.contains(
              "at least 3 connections: the listener, the heartbeat, and one for each statement"),
          message);
      assertTrue(message.contains("no poolMaxSize is declared"), message);
      assertTrue(
          message.contains("Grow the pool, or check that the database accepts connections."),
          message);
      assertFalse(message.contains("sharedHeartbeats"), message);
      HikariPoolMXBean bean = pool.getHikariPoolMXBean();
      waitUntil("the refusal gave every connection back", () -> bean.getActiveConnections() == 0);
    }
  }

  /**
   * SM-1902: a pool of 2 whose own checkout timeout, 250 ms, ends the readiness borrow long before
   * the startup budget. The refusal still names the size rule, the unknown size, and the next step,
   * and it keeps the pool error as its cause.
   */
  @Test
  void refusesToStartWhenThePoolRefusesTheReadinessBorrowFirst() throws Exception {
    try (HikariDataSource pool = pool(2)) {
      pool.setConnectionTimeout(250);
      Worker worker =
          worker(pool, "jvm-pool-two-early")
              .handle("held", Object.class, (ctx, payload) -> Map.of())
              .build();
      long startAt = System.nanoTime();
      WorkhorseException error = assertThrows(WorkhorseException.class, worker::run);
      double waitedMs = (System.nanoTime() - startAt) / 1e6;
      assertTrue(waitedMs < 4_900, "the worker waited " + waitedMs + " ms");
      String message = String.valueOf(error.getMessage());
      assertTrue(message.contains("The startup check of the worker failed"), message);
      assertTrue(message.contains("no poolMaxSize is declared"), message);
      assertTrue(
          message.endsWith("Grow the pool, or check that the database accepts connections."),
          message);
      assertFalse(message.contains("sharedHeartbeats"), message);
      assertTrue(error.getCause() != null, "the pool error is the cause");
      HikariPoolMXBean bean = pool.getHikariPoolMXBean();
      waitUntil("the refusal gave every connection back", () -> bean.getActiveConnections() == 0);
    }
  }

  /**
   * A pool of 3 leaves one connection beside the listener and the heartbeat, so the worker runs.
   */
  @Test
  void startsOnAPoolOfThree() throws Exception {
    enqueue("quick");
    try (HikariDataSource pool = pool(3)) {
      Worker worker =
          worker(pool, "jvm-pool-three")
              .handle("quick", Object.class, (ctx, payload) -> Map.of())
              .build();
      worker.start();
      try {
        waitUntil("the task succeeded", () -> succeeded() == 1);
      } finally {
        worker.close();
      }
    }
  }

  /**
   * A pool that opens each connection on demand, slower than a heartbeat interval of 100 ms, still
   * starts the worker. The startup budget is max(interval, 5 s), not one interval.
   */
  @Test
  void startsOnAWarmingPoolAtAShortInterval() throws Exception {
    enqueue("quick");
    DataSource slow = slowConnections(new ScratchDataSource(true), 700);
    try (HikariDataSource pool = new HikariDataSource()) {
      pool.setDataSource(slow);
      pool.setMaximumPoolSize(6);
      pool.setMinimumIdle(0);
      pool.setPoolName(applicationName);
      Worker worker =
          Worker.builder(pool)
              .queues(queueName)
              .workerId("jvm-pool-warming")
              .disableRegistry(true)
              .lease(Duration.ofSeconds(1))
              .heartbeat(Duration.ofMillis(100))
              .handle("quick", Object.class, (ctx, payload) -> Map.of())
              .build();
      worker.start();
      try {
        waitUntil("the task succeeded", () -> succeeded() == 1);
      } finally {
        worker.close();
      }
    }
  }

  /**
   * Round 2, P2: the heartbeat reservation and the readiness check share one startup budget, 5 s
   * here. Each new connection takes 3 s to open, so each step fits in the budget alone, but the two
   * together take 6 s. The worker refuses to start when the budget ends.
   */
  @Test
  void refusesToStartWhenTheTwoStartupStepsTogetherExceedTheBudget() throws Exception {
    Worker worker =
        Worker.builder(slowConnections(new ScratchDataSource(true), 3_000))
            .queues(queueName)
            .workerId("jvm-pool-cumulative")
            .pollingOnly(true)
            .disableRegistry(true)
            .lease(Duration.ofSeconds(3))
            .heartbeat(Duration.ofSeconds(1))
            .handle("quick", Object.class, (ctx, payload) -> Map.of())
            .build();
    long startAt = System.nanoTime();
    worker.start();
    try {
      waitUntil("the worker refuses to start", () -> !worker.isRunning());
    } finally {
      worker.stop();
    }
    double waitedMs = (System.nanoTime() - startAt) / 1e6;
    WorkhorseException error = assertThrows(WorkhorseException.class, worker::close);
    String message = String.valueOf(error.getMessage());
    assertTrue(message.contains("startup check"), message);
    assertTrue(message.contains("5000 ms"), message);
    // The refusal comes when the one budget ends, before the second step could end at 6 s.
    assertTrue(
        waitedMs >= 4_900 && waitedMs < 5_900, "the worker refused after " + waitedMs + " ms");
  }

  /** A source over {@code source} whose every new connection takes {@code delayMs} to open. */
  private static DataSource slowConnections(DataSource source, long delayMs) {
    return (DataSource)
        Proxy.newProxyInstance(
            DataSource.class.getClassLoader(),
            new Class<?>[] {DataSource.class},
            (proxy, method, arguments) -> {
              if (method.getName().equals("getConnection")) {
                Thread.sleep(delayMs);
              }
              try {
                return method.invoke(source, arguments);
              } catch (InvocationTargetException error) {
                throw error.getCause();
              }
            });
  }

  /**
   * P2: the listener's {@code LISTEN} stalls on a pool of 3. The listener holds its connection, so
   * the readiness check still finds one free connection in its own budget. The worker starts, logs
   * one warning, and claims by polling.
   */
  @Test
  void startsAndPollsWhileItsListenerStalls() throws Exception {
    enqueue("quick");
    CountDownLatch listen = new CountDownLatch(1);
    Warnings warnings = new Warnings();
    try (HikariDataSource pool = new HikariDataSource()) {
      pool.setDataSource(stallingListen(new ScratchDataSource(true), listen));
      pool.setMaximumPoolSize(3);
      pool.setMinimumIdle(0);
      pool.setPoolName(applicationName);
      Worker worker =
          worker(pool, "jvm-pool-stalled-listen")
              .pollInterval(Duration.ofMillis(100))
              .logger(warnings)
              .handle("quick", Object.class, (ctx, payload) -> Map.of())
              .build();
      worker.start();
      try {
        waitUntil("the task succeeded by polling", () -> succeeded() == 1);
        assertEquals(
            1,
            warnings.count("event.name=workhorse.worker.polling_only"),
            "the worker warned once that it polls");
      } finally {
        listen.countDown();
        worker.close();
      }
    }
  }

  /** Keeps each warning message. */
  private static final class Warnings implements System.Logger {
    final List<String> messages = new CopyOnWriteArrayList<>();

    long count(String text) {
      return messages.stream().filter(message -> message.contains(text)).count();
    }

    @Override
    public String getName() {
      return "warnings";
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
      if (level == Level.WARNING) {
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

  /** A source over {@code source} whose {@code LISTEN} waits until {@code listen} counts down. */
  static DataSource stallingListen(DataSource source, CountDownLatch listen) {
    return (DataSource)
        Proxy.newProxyInstance(
            DataSource.class.getClassLoader(),
            new Class<?>[] {DataSource.class},
            (proxy, method, arguments) -> {
              Object result = invoke(method, source, arguments);
              if (!method.getName().equals("getConnection")) {
                return result;
              }
              Connection connection = (Connection) result;
              return Proxy.newProxyInstance(
                  Connection.class.getClassLoader(),
                  new Class<?>[] {Connection.class},
                  (inner, call, values) -> {
                    Object answer = invoke(call, connection, values);
                    if (!call.getName().equals("createStatement")) {
                      return answer;
                    }
                    Statement statement = (Statement) answer;
                    return Proxy.newProxyInstance(
                        Statement.class.getClassLoader(),
                        new Class<?>[] {Statement.class},
                        (statementProxy, statementCall, statementValues) -> {
                          if (statementCall.getName().equals("execute")
                              && String.valueOf(statementValues[0]).startsWith("LISTEN")) {
                            listen.await(60, TimeUnit.SECONDS);
                          }
                          return invoke(statementCall, statement, statementValues);
                        });
                  });
            });
  }

  private static @Nullable Object invoke(
      java.lang.reflect.Method method, Object target, @Nullable Object[] arguments)
      throws Throwable {
    try {
      return method.invoke(target, arguments);
    } catch (InvocationTargetException error) {
      throw error.getCause();
    }
  }
}
