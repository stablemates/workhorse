package run.workhorse;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.zaxxer.hikari.HikariDataSource;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Proxy;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Statement;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.function.UnaryOperator;
import javax.sql.DataSource;
import org.jspecify.annotations.Nullable;
import run.workhorse.testing.ScratchDataSource;
import run.workhorse.testing.ScratchDatabase;

/**
 * SM-1585: one worker with {@code sharedHeartbeats(true)} on a fresh HikariCP pool. Two tasks exist
 * before the start. A third arrives once both ran, so it needs a later claim. Every wait ends long
 * before the pool's own acquisition timeout, so a listener that holds the only connection fails a
 * wait, not with a pool timeout.
 */
final class SmallPoolRun {
  static final String TASK_TYPE = "small-pool";
  static final String POLLING_ONLY = "event.name=workhorse.worker.polling_only";
  private static final long WAIT_SECONDS = 10;

  final String queueName = "jvm-small-pool-" + UUID.randomUUID();
  final HikariDataSource pool = new HikariDataSource();
  final Warnings warnings;
  // The LISTEN statements that returned on a connection of the pool.
  final AtomicInteger listens = new AtomicInteger();
  final CountDownLatch listened = new CountDownLatch(1);
  private final List<CountDownLatch> handled =
      List.of(new CountDownLatch(1), new CountDownLatch(1), new CountDownLatch(1));
  private final AtomicInteger runs = new AtomicInteger();
  private final Queue queue = new Queue(ConnectionSource.of(new ScratchDataSource(true)));

  /** A pool of {@code size} connections that waits {@code acquisition} for a connection. */
  SmallPoolRun(int size, Duration acquisition, Warnings warnings) {
    this.warnings = warnings;
    pool.setDataSource(observingListen(new ScratchDataSource(true)));
    pool.setMaximumPoolSize(size);
    pool.setMinimumIdle(0);
    pool.setConnectionTimeout(acquisition.toMillis());
    pool.setPoolName(queueName);
  }

  SmallPoolRun(int size, Warnings warnings) {
    this(size, Duration.ofSeconds(30), warnings);
  }

  /** A worker builder over {@code dataSource}, which is the pool or a view of it. */
  Worker.Builder worker(DataSource dataSource) {
    return Worker.builder(dataSource)
        .queues(queueName)
        .workerId(queueName)
        .sharedHeartbeats(true)
        .pollInterval(Duration.ofMillis(50))
        .lease(Duration.ofSeconds(5))
        .heartbeat(Duration.ofMillis(200))
        .logger(warnings)
        .handle(
            TASK_TYPE,
            Object.class,
            (ctx, payload) -> {
              try (Connection connection = pool.getConnection();
                  Statement statement = connection.createStatement()) {
                statement.execute("SELECT 1");
              }
              handled.get(runs.getAndIncrement()).countDown();
              return Map.of();
            });
  }

  /**
   * Runs the three tasks on the worker that {@code configure} builds from {@link #worker}, stops
   * it, and checks that each task succeeded and that the pool lends every connection again. When
   * {@code listens} is true, the run first waits until the shared listener's {@code LISTEN} has
   * returned.
   */
  void completeThreeTasks(
      DataSource dataSource, UnaryOperator<Worker.Builder> configure, boolean listens)
      throws Exception {
    List<UUID> tasks = new ArrayList<>(List.of(enqueue(), enqueue()));
    Worker worker = configure.apply(worker(dataSource)).build();
    worker.start();
    try {
      if (listens) {
        assertTrue(listened.await(WAIT_SECONDS, TimeUnit.SECONDS), "the worker never listened");
      }
      assertTrue(
          handled.get(1).await(WAIT_SECONDS, TimeUnit.SECONDS), "the first two tasks did not run");
      tasks.add(enqueue());
      assertTrue(
          handled.get(2).await(WAIT_SECONDS, TimeUnit.SECONDS), "the third task did not run");
    } finally {
      worker.close();
    }
    for (UUID task : tasks) {
      assertEquals("succeeded", state(task), "task " + task);
    }
    // After the stop, the pool lends every connection at once.
    assertEquals(0, pool.getHikariPoolMXBean().getActiveConnections());
    List<Connection> held = new ArrayList<>();
    try {
      for (int index = 0; index < pool.getMaximumPoolSize(); index++) {
        held.add(pool.getConnection());
      }
    } finally {
      for (Connection connection : held) {
        connection.close();
      }
    }
  }

  void completeThreeTasks(DataSource dataSource, UnaryOperator<Worker.Builder> configure)
      throws Exception {
    completeThreeTasks(dataSource, configure, false);
  }

  void completeThreeTasks() throws Exception {
    completeThreeTasks(pool, UnaryOperator.identity());
  }

  void close() {
    pool.close();
  }

  private UUID enqueue() {
    return queue
        .enqueue(
            TASK_TYPE, Map.of(), EnqueueOptions.builder().queue(queueName).maxAttempts(1).build())
        .taskId();
  }

  private static String state(UUID task) throws SQLException {
    try (Connection connection = ScratchDatabase.connect();
        PreparedStatement statement =
            connection.prepareStatement(
                "SELECT state FROM workhorse.task_outcome WHERE task_id = ?")) {
      statement.setObject(1, task);
      try (ResultSet result = statement.executeQuery()) {
        return result.next() ? result.getString(1) : "pending";
      }
    }
  }

  /** A source over {@code source} that counts each {@code LISTEN} once it has returned. */
  private DataSource observingListen(DataSource source) {
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
                          Object executed = invoke(statementCall, statement, statementValues);
                          if (statementCall.getName().equals("execute")
                              && String.valueOf(statementValues[0]).startsWith("LISTEN")) {
                            listens.incrementAndGet();
                            listened.countDown();
                          }
                          return executed;
                        });
                  });
            });
  }

  /** A view of the pool that is only a {@code DataSource}, so nothing can read its size. */
  DataSource opaque() {
    DataSource source = pool;
    return (DataSource)
        Proxy.newProxyInstance(
            DataSource.class.getClassLoader(),
            new Class<?>[] {DataSource.class},
            (proxy, method, arguments) -> invoke(method, source, arguments));
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

  /** Keeps each warning message. */
  static final class Warnings implements System.Logger {
    final List<String> messages = new CopyOnWriteArrayList<>();

    List<String> pollingOnly() {
      return messages.stream().filter(message -> message.contains(POLLING_ONLY)).toList();
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
}
