package run.workhorse;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;
import java.lang.reflect.Proxy;
import java.sql.Connection;
import java.sql.SQLException;
import java.sql.Statement;
import java.time.Duration;
import java.util.List;
import java.util.Map;
import java.util.ResourceBundle;
import java.util.UUID;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import javax.sql.DataSource;
import org.jspecify.annotations.Nullable;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.extension.ExtendWith;
import run.workhorse.testing.ScratchDataSource;
import run.workhorse.testing.ScratchDatabase;

/**
 * SM-1696: a reporter callback that throws never stops the worker, and the worker logs its failures
 * at most once in each interval.
 */
@ExtendWith(ScratchDatabase.class)
@Timeout(value = 60, unit = TimeUnit.SECONDS)
class WorkerReporterDatabaseTest {
  private final ScratchDataSource source = new ScratchDataSource(true);
  private final String queueName = "jvm-reporters-" + UUID.randomUUID();

  /**
   * A source over the scratch database whose every registration and every {@code LISTEN} fails
   * before it goes out.
   */
  private DataSource offlineRegistry() {
    return (DataSource)
        Proxy.newProxyInstance(
            DataSource.class.getClassLoader(),
            new Class<?>[] {DataSource.class},
            (proxy, method, arguments) -> {
              Object result = invoke(method, source, arguments);
              return method.getName().equals("getConnection")
                  ? withoutRegistry((Connection) result)
                  : result;
            });
  }

  private static Connection withoutRegistry(Connection connection) {
    return (Connection)
        Proxy.newProxyInstance(
            Connection.class.getClassLoader(),
            new Class<?>[] {Connection.class},
            (proxy, method, arguments) -> {
              if (method.getName().equals("prepareStatement")
                  && String.valueOf(arguments[0]).contains("workhorse.register_worker_v1(")) {
                throw new SQLException("registry is offline");
              }
              Object result = invoke(method, connection, arguments);
              return method.getName().equals("createStatement")
                  ? withoutListen((Statement) result)
                  : result;
            });
  }

  private static Statement withoutListen(Statement statement) {
    return (Statement)
        Proxy.newProxyInstance(
            Statement.class.getClassLoader(),
            new Class<?>[] {Statement.class},
            (proxy, method, arguments) -> {
              if (method.getName().equals("execute")
                  && String.valueOf(arguments[0]).startsWith("LISTEN ")) {
                throw new SQLException("listener is offline");
              }
              return invoke(method, statement, arguments);
            });
  }

  private static @Nullable Object invoke(Method method, Object target, @Nullable Object[] arguments)
      throws Throwable {
    try {
      return method.invoke(target, arguments);
    } catch (InvocationTargetException error) {
      throw error.getCause();
    }
  }

  /** A logger that keeps each message at or above WARNING. */
  private static final class RecordingLogger implements System.Logger {
    final List<String> messages = new CopyOnWriteArrayList<>();

    @Override
    public String getName() {
      return "recording";
    }

    @Override
    public boolean isLoggable(Level level) {
      return level.getSeverity() >= Level.WARNING.getSeverity();
    }

    @Override
    public void log(
        Level level, @Nullable ResourceBundle bundle, @Nullable String message, Throwable thrown) {
      if (isLoggable(level)) {
        messages.add(message + ": " + thrown.getMessage());
      }
    }

    @Override
    public void log(
        Level level, @Nullable ResourceBundle bundle, @Nullable String format, Object... params) {
      if (isLoggable(level)) {
        messages.add(String.valueOf(format));
      }
    }

    long reports(String name) {
      return messages.stream()
          .filter(message -> message.startsWith("Workhorse worker " + name + " reporter failed"))
          .count();
    }
  }

  @Test
  void aThrowingRegistrationReporterDoesNotStopClaims() throws Exception {
    AtomicInteger calls = new AtomicInteger();
    CountDownLatch handled = new CountDownLatch(1);
    RecordingLogger logger = new RecordingLogger();
    Worker worker =
        Worker.builder(offlineRegistry())
            .queues(queueName)
            .pollingOnly(true)
            .pollInterval(Duration.ofMillis(10))
            .registryInterval(Duration.ofMillis(100))
            .shutdownGrace(Duration.ZERO)
            .logger(logger)
            .onRegistrationError(
                error -> {
                  calls.incrementAndGet();
                  throw new IllegalStateException("alert client is offline");
                })
            .handle(
                "reporter.task",
                Object.class,
                (ctx, payload) -> {
                  handled.countDown();
                  return Map.of();
                })
            .build();
    worker.start();
    try {
      long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(20);
      while (calls.get() < 3 && System.nanoTime() < deadline) {
        Thread.sleep(10);
      }
      assertTrue(calls.get() >= 3, "the reporter receives each failed registration");
      new Queue(ConnectionSource.of(source))
          .enqueue("reporter.task", Map.of(), EnqueueOptions.builder().queue(queueName).build());
      assertTrue(handled.await(20, TimeUnit.SECONDS), "the worker still claims");
    } finally {
      worker.close();
    }

    assertEquals(1, logger.reports("onRegistrationError"), String.valueOf(logger.messages));
    assertTrue(
        logger.messages.contains(
            "Workhorse worker onRegistrationError reporter failed: alert client is offline"),
        String.valueOf(logger.messages));

    // After the interval, the next report states the failures that the worker did not log.
    Worker.ReporterFailures failures = worker.reporterFailures.get("onRegistrationError");
    failures.reportedAt -= Worker.REPORTER_FAILURE_REPORT_NANOS;
    worker.start();
    try {
      long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(20);
      while (logger.reports("onRegistrationError") < 2 && System.nanoTime() < deadline) {
        Thread.sleep(10);
      }
    } finally {
      worker.close();
    }
    assertTrue(
        logger.messages.stream().anyMatch(message -> message.contains(" unreported failures")),
        String.valueOf(logger.messages));
  }

  @Test
  void aThrowingNotificationReporterDoesNotStopPollingAndHasItsOwnLimit() throws Exception {
    AtomicInteger notificationCalls = new AtomicInteger();
    CountDownLatch handled = new CountDownLatch(1);
    RecordingLogger logger = new RecordingLogger();
    Worker worker =
        Worker.builder(offlineRegistry())
            .queues(queueName)
            .pollInterval(Duration.ofMillis(10))
            .registryInterval(Duration.ofMillis(100))
            // SM-1807: the handler signals before its attempt ends. A zero grace gives that attempt
            // only the unwind window, which a loaded host can exceed, so close() waits for it.
            .shutdownGrace(Duration.ofSeconds(20))
            .logger(logger)
            .onRegistrationError(
                error -> {
                  throw new IllegalStateException("registration alert is offline");
                })
            .onNotificationError(
                error -> {
                  notificationCalls.incrementAndGet();
                  throw new IllegalStateException("notification alert is offline");
                })
            .handle(
                "reporter.task",
                Object.class,
                (ctx, payload) -> {
                  handled.countDown();
                  return Map.of();
                })
            .build();
    worker.start();
    try {
      // The listener retries after 100 ms, 200 ms, and 400 ms.
      long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(20);
      while (notificationCalls.get() < 3 && System.nanoTime() < deadline) {
        Thread.sleep(10);
      }
      assertTrue(notificationCalls.get() >= 3, "the reporter receives each listener failure");
      new Queue(ConnectionSource.of(source))
          .enqueue("reporter.task", Map.of(), EnqueueOptions.builder().queue(queueName).build());
      assertTrue(handled.await(20, TimeUnit.SECONDS), "the worker still claims by polling");
    } finally {
      worker.close();
    }

    assertEquals(1, logger.reports("onNotificationError"), String.valueOf(logger.messages));
    assertTrue(
        logger.messages.contains(
            "Workhorse worker onNotificationError reporter failed: notification alert is offline"),
        String.valueOf(logger.messages));
    // Each callback has its own limit, so the notification reports do not hide this one.
    assertEquals(1, logger.reports("onRegistrationError"), String.valueOf(logger.messages));
  }
}
