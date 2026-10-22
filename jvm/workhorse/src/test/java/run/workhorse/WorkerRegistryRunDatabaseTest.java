package run.workhorse;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;
import java.lang.reflect.Proxy;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.SQLException;
import java.time.Duration;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.function.BooleanSupplier;
import javax.sql.DataSource;
import org.jspecify.annotations.Nullable;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.extension.ExtendWith;
import run.workhorse.internal.Sql;
import run.workhorse.internal.SqlCatalogue;
import run.workhorse.testing.ScratchDataSource;
import run.workhorse.testing.ScratchDatabase;

/**
 * SM-1580: a registry response applies only to the run that sent it. A late response of an ended
 * run does not change the remote pause of a later run of the same worker.
 */
@ExtendWith(ScratchDatabase.class)
@Timeout(value = 60, unit = TimeUnit.SECONDS)
class WorkerRegistryRunDatabaseTest {
  /**
   * A source over the scratch database that watches the registration statement.
   *
   * <ul>
   *   <li>It counts the registrations that returned ({@link #registered}).
   *   <li>Once {@link #holdNext} is true, the next registration runs, counts down {@link #held},
   *       and then waits until {@link #release} counts down before it returns.
   *   <li>Once {@link #failNext} is true, the next registration fails before it goes out.
   * </ul>
   */
  private static final class Registry {
    final ScratchDataSource source = new ScratchDataSource(true);
    final AtomicInteger registered = new AtomicInteger();
    final AtomicBoolean holdNext = new AtomicBoolean();
    final CountDownLatch held = new CountDownLatch(1);
    final CountDownLatch release = new CountDownLatch(1);
    final AtomicBoolean failNext = new AtomicBoolean();

    DataSource dataSource() {
      return (DataSource)
          Proxy.newProxyInstance(
              DataSource.class.getClassLoader(),
              new Class<?>[] {DataSource.class},
              (proxy, method, arguments) -> {
                Object result = invoke(method, source, arguments);
                return method.getName().equals("getConnection")
                    ? watched((Connection) result)
                    : result;
              });
    }

    private Connection watched(Connection connection) {
      return (Connection)
          Proxy.newProxyInstance(
              Connection.class.getClassLoader(),
              new Class<?>[] {Connection.class},
              (proxy, method, arguments) -> {
                Object result = invoke(method, connection, arguments);
                // The deregistration calls deregister_worker_v2, which this text does not match.
                boolean registration =
                    method.getName().equals("prepareStatement")
                        && String.valueOf(arguments[0]).contains("workhorse.register_worker_v1(");
                return registration ? registration((PreparedStatement) result) : result;
              });
    }

    private PreparedStatement registration(PreparedStatement statement) {
      return (PreparedStatement)
          Proxy.newProxyInstance(
              PreparedStatement.class.getClassLoader(),
              new Class<?>[] {PreparedStatement.class},
              (proxy, method, arguments) -> {
                if (!method.getName().equals("execute")) {
                  return invoke(method, statement, arguments);
                }
                if (failNext.compareAndSet(true, false)) {
                  throw new SQLException("injected registration failure");
                }
                Object result = invoke(method, statement, arguments);
                if (holdNext.compareAndSet(true, false)) {
                  held.countDown();
                  release.await(30, TimeUnit.SECONDS);
                }
                registered.incrementAndGet();
                return result;
              });
    }

    private static @Nullable Object invoke(
        Method method, Object target, @Nullable Object[] arguments) throws Throwable {
      try {
        return method.invoke(target, arguments);
      } catch (InvocationTargetException error) {
        throw error.getCause();
      }
    }
  }

  private static void waitUntil(String what, BooleanSupplier condition) {
    long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(20);
    while (!condition.getAsBoolean()) {
      if (System.nanoTime() > deadline) {
        throw new AssertionError("timed out waiting until " + what);
      }
      try {
        Thread.sleep(10);
      } catch (InterruptedException interrupted) {
        Thread.currentThread().interrupt();
        throw new AssertionError("interrupted waiting until " + what, interrupted);
      }
    }
  }

  private static void pauseRemotely(String workerId) throws SQLException {
    try (Connection connection = ScratchDatabase.connect()) {
      Sql.rows(
          connection,
          SqlCatalogue.SET_WORKER_PAUSED_V1,
          workerId,
          "true",
          "jvm-test",
          "test",
          UUID.randomUUID().toString());
    }
  }

  /**
   * Run A sends its draining registration after an operator paused the worker, and the response
   * waits. Run B starts and has its generation, and only then does A's response arrive with the
   * pause. It belongs to run A, so run B stays unpaused. B's own first registration fails, so no
   * response of run B changes the pause.
   */
  @Test
  void aLateRegistryResponseOfAnEndedRunDoesNotPauseALaterRun() throws Exception {
    Registry registry = new Registry();
    String workerId = "jvm-registry-runs-" + UUID.randomUUID();
    CountDownLatch registrationFailed = new CountDownLatch(1);
    AtomicBoolean watchFailures = new AtomicBoolean();
    Worker worker =
        Worker.builder(registry.dataSource())
            .queues("jvm-registry-runs")
            .workerId(workerId)
            .pollingOnly(true)
            .registryInterval(Duration.ofHours(1))
            .shutdownGrace(Duration.ZERO)
            .onRegistrationError(
                error -> {
                  if (watchFailures.get()) {
                    registrationFailed.countDown();
                  }
                })
            .handle("quick", Object.class, (ctx, payload) -> Map.of())
            .build();
    worker.start();
    try {
      waitUntil("run A registered", () -> registry.registered.get() == 1);
      pauseRemotely(workerId);
      registry.holdNext.set(true);
      worker.close();
      assertTrue(
          registry.held.await(20, TimeUnit.SECONDS), "the draining registration of run A waits");

      registry.failNext.set(true);
      watchFailures.set(true);
      // The checkpoint: run B has its generation, so the response of run A is late when the hook
      // releases it.
      worker.afterRunStarted = registry.release::countDown;
      worker.start();
      // A completion checkpoint: the registry writes run in order, so the response of run A was
      // refused before the registration of run B fails.
      assertTrue(
          registrationFailed.await(20, TimeUnit.SECONDS), "the registration of run B failed");
      assertFalse(worker.isPaused(), "the late response of run A does not pause run B");
    } finally {
      registry.release.countDown();
      worker.close();
    }
  }
}
