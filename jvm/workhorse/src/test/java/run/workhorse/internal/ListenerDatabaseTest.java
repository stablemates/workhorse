package run.workhorse.internal;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotSame;
import static org.junit.jupiter.api.Assertions.assertSame;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.io.PrintWriter;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Proxy;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.SQLException;
import java.sql.SQLFeatureNotSupportedException;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.function.BooleanSupplier;
import java.util.logging.Logger;
import javax.sql.DataSource;
import org.jspecify.annotations.Nullable;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.extension.ExtendWith;
import org.postgresql.PGConnection;
import run.workhorse.testing.ScratchDatabase;

/**
 * SM-1569: every worker on one {@link DataSource} object shares one listener connection. Each
 * subscriber's queues filter its wakes, and the last subscriber gives the connection back.
 */
@ExtendWith(ScratchDatabase.class)
@Timeout(value = 60, unit = TimeUnit.SECONDS)
class ListenerDatabaseTest {
  /**
   * Gives scratch connections, and counts the open ones. It equals every other counting source, as
   * a pool configuration object can, so a registry that uses {@code equals} merges two of them.
   */
  private static final class Counted implements DataSource {
    final AtomicInteger open = new AtomicInteger();
    final List<Integer> backends = new CopyOnWriteArrayList<>();
    final AtomicInteger waiting = new AtomicInteger();

    /** While it has not counted down, each checkout waits for it. */
    volatile CountDownLatch gate = new CountDownLatch(0);

    @Override
    public Connection getConnection() throws SQLException {
      CountDownLatch current = gate;
      if (current.getCount() > 0) {
        waiting.incrementAndGet();
        try {
          current.await(30, TimeUnit.SECONDS);
        } catch (InterruptedException interrupted) {
          Thread.currentThread().interrupt();
          throw new SQLException("interrupted", interrupted);
        } finally {
          waiting.decrementAndGet();
        }
      }
      Connection physical = ScratchDatabase.connect();
      backends.add(physical.unwrap(PGConnection.class).getBackendPID());
      open.incrementAndGet();
      AtomicBoolean closed = new AtomicBoolean();
      return (Connection)
          Proxy.newProxyInstance(
              Connection.class.getClassLoader(),
              new Class<?>[] {Connection.class},
              (proxy, method, arguments) -> {
                if (method.getName().equals("close") && closed.compareAndSet(false, true)) {
                  open.decrementAndGet();
                }
                try {
                  return method.invoke(physical, arguments);
                } catch (InvocationTargetException error) {
                  throw error.getCause();
                }
              });
    }

    @Override
    public Connection getConnection(String username, String password) throws SQLException {
      throw new SQLFeatureNotSupportedException();
    }

    @Override
    public @Nullable PrintWriter getLogWriter() {
      return null;
    }

    @Override
    public void setLogWriter(@Nullable PrintWriter out) {}

    @Override
    public void setLoginTimeout(int seconds) {}

    @Override
    public int getLoginTimeout() {
      return 0;
    }

    @Override
    public Logger getParentLogger() throws SQLFeatureNotSupportedException {
      throw new SQLFeatureNotSupportedException();
    }

    @Override
    public <T> T unwrap(Class<T> type) throws SQLException {
      throw new SQLException("not a wrapper");
    }

    @Override
    public boolean isWrapperFor(Class<?> type) {
      return false;
    }

    @Override
    public boolean equals(@Nullable Object other) {
      return other instanceof Counted;
    }

    @Override
    public int hashCode() {
      return 1;
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

  private static void notifyTasks(String payload) throws SQLException {
    try (Connection connection = ScratchDatabase.connect();
        PreparedStatement statement =
            connection.prepareStatement("SELECT pg_notify('workhorse_tasks', ?)")) {
      statement.setString(1, payload);
      statement.execute();
    }
  }

  private static void terminate(int backend) throws SQLException {
    try (Connection connection = ScratchDatabase.connect();
        PreparedStatement statement =
            connection.prepareStatement("SELECT pg_terminate_backend(?)")) {
      statement.setInt(1, backend);
      statement.execute();
    }
  }

  @Test
  void sharesOneListenerForEachDataSourceObjectByIdentity() {
    Counted first = new Counted();
    Counted second = new Counted();
    assertEquals(first, second, "the two sources compare equal");
    assertSame(Listener.shared(first), Listener.shared(first));
    assertNotSame(Listener.shared(first), Listener.shared(second));
  }

  @Test
  void wakesEachSubscriberForItsQueuesOnOneConnection() throws Exception {
    Counted source = new Counted();
    Listener listener = Listener.shared(source);
    String queueA = "jvm-listener-a-" + UUID.randomUUID();
    String queueB = "jvm-listener-b-" + UUID.randomUUID();
    AtomicInteger wakesA = new AtomicInteger();
    AtomicInteger wakesB = new AtomicInteger();
    AtomicInteger errors = new AtomicInteger();
    Listener.Subscription a =
        listener.subscribe(
            List.of(queueA),
            () -> {
              wakesA.incrementAndGet();
              // A subscriber whose callback throws keeps the other subscribers' wakes.
              throw new IllegalStateException("injected wake failure");
            },
            error -> errors.incrementAndGet());
    Listener.Subscription b =
        listener.subscribe(List.of(queueB), wakesB::incrementAndGet, error -> {});
    try {
      waitUntil("the listener listens", a::isListening);
      waitUntil(
          "both subscribers have the connect wake", () -> wakesA.get() > 0 && wakesB.get() > 0);
      assertEquals(1, source.open.get(), "two subscribers hold one connection");

      int beforeA = wakesA.get();
      int beforeB = wakesB.get();
      notifyTasks(queueB);
      waitUntil("the queue B notification wakes B", () -> wakesB.get() > beforeB);
      // A negative check: the notification arrived for B, and A has no wake from it.
      Thread.sleep(200);
      assertEquals(beforeA, wakesA.get(), "a notification for queue B does not wake A");
      int everyA = wakesA.get();
      int everyB = wakesB.get();
      notifyTasks("*");
      waitUntil(
          "the * notification wakes both subscribers",
          () -> wakesA.get() > everyA && wakesB.get() > everyB);

      // After a lost connection the listener reconnects, and wakes every subscriber again.
      int backend = source.backends.get(source.backends.size() - 1);
      int reconnectA = wakesA.get();
      int reconnectB = wakesB.get();
      terminate(backend);
      waitUntil("the lost connection reaches every subscriber", () -> errors.get() > 0);
      waitUntil(
          "the reconnect wakes both subscribers",
          () -> wakesA.get() > reconnectA && wakesB.get() > reconnectB);
      waitUntil("the listener listens again", b::isListening);
      int listeningB = wakesB.get();
      notifyTasks(queueB);
      waitUntil("queue B wakes B after the reconnect", () -> wakesB.get() > listeningB);
      waitUntil("one connection is open after the reconnect", () -> source.open.get() == 1);

      a.close();
      assertTrue(b.isListening(), "the listener listens while B is subscribed");
      assertEquals(1, source.open.get(), "the listener keeps its connection for B");
    } finally {
      a.close();
      b.close();
    }
    waitUntil("the last subscriber gave the connection back", () -> source.open.get() == 0);
    assertFalse(a.isListening(), "the listener stopped");
  }

  /**
   * SM-1569: a checkout that gives its connection after the last subscriber left has one owner,
   * which gives the connection back to the pool. The listener never listens on it.
   */
  @Test
  void closesAConnectionThatArrivesAfterTheLastSubscriberLeft() throws Exception {
    Counted source = new Counted();
    CountDownLatch release = new CountDownLatch(1);
    source.gate = release;
    Listener.Subscription subscription =
        Listener.shared(source).subscribe(List.of("jvm-listener-late"), () -> {}, error -> {});
    try {
      waitUntil("the listener checkout waits", () -> source.waiting.get() == 1);
      subscription.close();
      assertFalse(subscription.isListening(), "the listener stopped before it got a connection");
    } finally {
      release.countDown();
    }
    waitUntil("the late connection arrived", () -> source.backends.size() == 1);
    waitUntil("the late connection went back to the pool", () -> source.open.get() == 0);
    assertFalse(subscription.isListening(), "the listener never listened");
  }

  /**
   * SM-1569: workers that subscribe and leave again and again, while the pool gives no connection,
   * share one pending checkout. Each new listener thread adopts it, so restarts add no checkout and
   * no helper thread.
   */
  @Test
  void keepsOneCheckoutAcrossRestartsWhileThePoolGivesNoConnection() throws Exception {
    Counted source = new Counted();
    CountDownLatch release = new CountDownLatch(1);
    source.gate = release;
    Listener listener = Listener.shared(source);
    try {
      for (int cycle = 0; cycle < 4; cycle++) {
        Listener.Subscription subscription =
            listener.subscribe(List.of("jvm-listener-restart"), () -> {}, error -> {});
        waitUntil("the checkout waits", () -> source.waiting.get() == 1);
        subscription.close();
      }
      assertEquals(1, source.waiting.get(), "four restarts share one checkout");
    } finally {
      release.countDown();
    }
    waitUntil("the late connection arrived", () -> source.backends.size() == 1);
    waitUntil("the late connection went back to the pool", () -> source.open.get() == 0);
    // A negative check: a second checkout would open a second connection in this time.
    Thread.sleep(200);
    assertEquals(1, source.backends.size(), "the pool opened one connection");
  }
}
