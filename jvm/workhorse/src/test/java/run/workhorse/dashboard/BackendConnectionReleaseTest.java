package run.workhorse.dashboard;

import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertSame;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.lang.reflect.Proxy;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.SQLException;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicInteger;
import org.jspecify.annotations.Nullable;
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
        new Backend(source, "test", List.of(), Map.of(), true, Duration.ofSeconds(15), false);

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
        new Backend(source, "test", List.of(), Map.of(), true, Duration.ofSeconds(15), false);

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
        new Backend(source, "test", List.of(), Map.of(), true, Duration.ofSeconds(15), false);

    OutOfMemoryError thrown =
        assertThrows(
            OutOfMemoryError.class,
            () -> backend.procedures().get("taskCounts").call(Map.of(), "operator"));

    assertSame(failure, thrown);
    assertSame(rollbackFailure, thrown.getSuppressed()[0]);
    assertEquals(1, releases.get());
  }

  @Test
  void throwsTheFirstCleanupErrorOfAnOwnedReadThatSucceeded() {
    SQLException rollbackFailure = new SQLException("the rollback failed");
    SQLException autocommitFailure = new SQLException("the autocommit reset failed");
    AtomicInteger releases = new AtomicInteger();
    Backend backend = ownedReadBackend(rollbackFailure, autocommitFailure, releases);

    RuntimeException thrown =
        assertThrows(
            RuntimeException.class,
            () -> backend.procedures().get("taskCounts").call(Map.of(), "operator"));

    assertTrue(causeChain(thrown).contains(rollbackFailure));
    assertArrayEquals(new Throwable[] {autocommitFailure}, rollbackFailure.getSuppressed());
    assertEquals(1, releases.get());
  }

  @Test
  void throwsTheAutocommitErrorOfAnOwnedReadThatSucceededWhenOnlyItFails() {
    SQLException autocommitFailure = new SQLException("the autocommit reset failed");
    AtomicInteger releases = new AtomicInteger();
    Backend backend = ownedReadBackend(null, autocommitFailure, releases);

    RuntimeException thrown =
        assertThrows(
            RuntimeException.class,
            () -> backend.procedures().get("taskCounts").call(Map.of(), "operator"));

    assertTrue(causeChain(thrown).contains(autocommitFailure));
    assertEquals(0, autocommitFailure.getSuppressed().length);
    assertEquals(1, releases.get());
  }

  /** {@code thrown} and each cause under it. */
  private static List<Throwable> causeChain(Throwable thrown) {
    List<Throwable> chain = new ArrayList<>();
    for (Throwable cause = thrown; cause != null; cause = cause.getCause()) {
      chain.add(cause);
    }
    return chain;
  }

  /**
   * A backend on one connection that the host can own. Each statement on it succeeds and returns no
   * result set, so the read succeeds. Then {@code rollback()} throws {@code rollbackFailure} and
   * {@code setAutoCommit(true)} throws {@code autocommitFailure}, where each is not null.
   */
  private static Backend ownedReadBackend(
      @Nullable SQLException rollbackFailure,
      @Nullable SQLException autocommitFailure,
      AtomicInteger releases) {
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
    Object statement =
        Proxy.newProxyInstance(
            PreparedStatement.class.getClassLoader(),
            new Class<?>[] {PreparedStatement.class},
            (proxy, method, arguments) ->
                switch (method.getName()) {
                  case "execute" -> false;
                  case "setString", "setObject", "setNull", "close" -> null;
                  default -> throw new UnsupportedOperationException(method.getName());
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
                      case "createStatement", "prepareStatement" -> statement;
                      case "setAutoCommit" -> {
                        if (Boolean.TRUE.equals(arguments[0]) && autocommitFailure != null) {
                          throw autocommitFailure;
                        }
                        yield null;
                      }
                      case "rollback" -> {
                        if (rollbackFailure != null) {
                          throw rollbackFailure;
                        }
                        yield null;
                      }
                      default -> throw new UnsupportedOperationException(method.getName());
                    });
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
    return new Backend(source, "test", List.of(), Map.of(), true, Duration.ofSeconds(15), false);
  }
}
