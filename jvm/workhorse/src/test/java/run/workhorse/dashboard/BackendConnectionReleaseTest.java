package run.workhorse.dashboard;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertSame;
import static org.junit.jupiter.api.Assertions.assertThrows;

import java.lang.reflect.Proxy;
import java.sql.Connection;
import java.sql.SQLException;
import java.time.Duration;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.Test;
import org.postgresql.core.BaseConnection;
import org.postgresql.core.TransactionState;
import run.workhorse.ConnectionSource;

/**
 * A dashboard read gives its connection back on each path out of the read (SM-1948). An {@link
 * Error} from the statement, such as {@link OutOfMemoryError}, must not take a connection out of
 * the pool that the worker shares.
 */
class BackendConnectionReleaseTest {
  @Test
  void releasesTheConnectionWhenTheStatementThrowsAnError() {
    OutOfMemoryError failure = new OutOfMemoryError("the statement ran out of memory");
    Connection connection =
        (Connection)
            Proxy.newProxyInstance(
                Connection.class.getClassLoader(),
                new Class<?>[] {Connection.class},
                (proxy, method, arguments) -> {
                  if (method.getName().equals("getAutoCommit")) {
                    // A connection the host cannot own, so the read takes the direct path.
                    return false;
                  }
                  if (method.getName().equals("prepareStatement")) {
                    throw failure;
                  }
                  throw new UnsupportedOperationException(method.getName());
                });
    AtomicInteger releases = new AtomicInteger();
    ConnectionSource source =
        new ConnectionSource() {
          @Override
          public Connection acquire() {
            return connection;
          }

          @Override
          public void release(Connection released, boolean transactional) {
            assertSame(connection, released);
            releases.incrementAndGet();
          }
        };
    Backend backend =
        new Backend(source, "test", List.of(), Map.of(), true, Duration.ofSeconds(15));

    OutOfMemoryError thrown =
        assertThrows(
            OutOfMemoryError.class,
            () -> backend.procedures().get("taskCounts").call(Map.of(), "operator"));

    assertSame(failure, thrown);
    assertEquals(1, releases.get());
  }

  @Test
  void keepsTheOriginalErrorWhenTheReleaseAlsoThrowsAnError() {
    AssertionError failure = new AssertionError("the statement failed");
    AssertionError releaseFailure = new AssertionError("the release failed");
    Connection connection =
        (Connection)
            Proxy.newProxyInstance(
                Connection.class.getClassLoader(),
                new Class<?>[] {Connection.class},
                (proxy, method, arguments) -> {
                  if (method.getName().equals("getAutoCommit")) {
                    // A connection the host cannot own, so the read takes the direct path.
                    return false;
                  }
                  if (method.getName().equals("prepareStatement")) {
                    throw failure;
                  }
                  throw new UnsupportedOperationException(method.getName());
                });
    ConnectionSource source =
        new ConnectionSource() {
          @Override
          public Connection acquire() {
            return connection;
          }

          @Override
          public void release(Connection released, boolean transactional) {
            throw releaseFailure;
          }
        };
    Backend backend =
        new Backend(source, "test", List.of(), Map.of(), true, Duration.ofSeconds(15));

    AssertionError thrown =
        assertThrows(
            AssertionError.class,
            () -> backend.procedures().get("taskCounts").call(Map.of(), "operator"));

    assertSame(failure, thrown);
    assertSame(releaseFailure, thrown.getSuppressed()[0]);
  }

  @Test
  void keepsTheOriginalErrorOfAnOwnedReadWhenItsCleanupFails() {
    OutOfMemoryError failure = new OutOfMemoryError("the read ran out of memory");
    SQLException rollbackFailure = new SQLException("the rollback failed");
    Object driver =
        Proxy.newProxyInstance(
            BaseConnection.class.getClassLoader(),
            new Class<?>[] {BaseConnection.class},
            (proxy, method, arguments) -> {
              if (method.getName().equals("getTransactionState")) {
                return TransactionState.IDLE;
              }
              throw new UnsupportedOperationException(method.getName());
            });
    Connection connection =
        (Connection)
            Proxy.newProxyInstance(
                Connection.class.getClassLoader(),
                new Class<?>[] {Connection.class},
                (proxy, method, arguments) ->
                    switch (method.getName()) {
                      case "getAutoCommit", "isWrapperFor" -> true;
                      case "unwrap" -> driver;
                      case "setAutoCommit" -> null;
                      case "createStatement" -> throw failure;
                      case "rollback" -> throw rollbackFailure;
                      default -> throw new UnsupportedOperationException(method.getName());
                    });
    AtomicInteger releases = new AtomicInteger();
    ConnectionSource source =
        new ConnectionSource() {
          @Override
          public Connection acquire() {
            return connection;
          }

          @Override
          public void release(Connection released, boolean transactional) {
            releases.incrementAndGet();
          }
        };
    Backend backend =
        new Backend(source, "test", List.of(), Map.of(), true, Duration.ofSeconds(15));

    OutOfMemoryError thrown =
        assertThrows(
            OutOfMemoryError.class,
            () -> backend.procedures().get("taskCounts").call(Map.of(), "operator"));

    assertSame(failure, thrown);
    assertSame(rollbackFailure, thrown.getSuppressed()[0]);
    assertEquals(1, releases.get());
  }
}
