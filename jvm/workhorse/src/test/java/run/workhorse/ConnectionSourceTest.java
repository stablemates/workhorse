package run.workhorse;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertSame;
import static org.junit.jupiter.api.Assertions.assertThrows;

import java.io.PrintWriter;
import java.lang.reflect.Proxy;
import java.sql.Connection;
import java.sql.SQLException;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.logging.Logger;
import javax.sql.DataSource;
import org.junit.jupiter.api.Test;

/**
 * {@link ConnectionSource#of} closes the connection on each path out of {@code acquire} that does
 * not return it (SM-1948).
 */
class ConnectionSourceTest {
  @Test
  void closesTheConnectionWhenGetAutoCommitThrowsAnError() {
    StackOverflowError failure = new StackOverflowError("getAutoCommit overflowed");
    AtomicInteger closes = new AtomicInteger();
    Connection connection =
        (Connection)
            Proxy.newProxyInstance(
                Connection.class.getClassLoader(),
                new Class<?>[] {Connection.class},
                (proxy, method, arguments) ->
                    switch (method.getName()) {
                      case "getAutoCommit" -> throw failure;
                      case "close" -> {
                        closes.incrementAndGet();
                        yield null;
                      }
                      default -> throw new UnsupportedOperationException(method.getName());
                    });
    ConnectionSource source = ConnectionSource.of(new OneConnection(connection));

    StackOverflowError thrown = assertThrows(StackOverflowError.class, source::acquire);

    assertSame(failure, thrown);
    assertEquals(1, closes.get());
  }

  @Test
  void keepsTheOriginalErrorWhenTheCloseAlsoFails() {
    AssertionError failure = new AssertionError("setAutoCommit failed");
    SQLException closeFailure = new SQLException("the close failed");
    Connection connection =
        (Connection)
            Proxy.newProxyInstance(
                Connection.class.getClassLoader(),
                new Class<?>[] {Connection.class},
                (proxy, method, arguments) ->
                    switch (method.getName()) {
                      case "getAutoCommit" -> false;
                      case "setAutoCommit" -> throw failure;
                      case "close" -> throw closeFailure;
                      default -> throw new UnsupportedOperationException(method.getName());
                    });
    ConnectionSource source = ConnectionSource.of(new OneConnection(connection));

    AssertionError thrown = assertThrows(AssertionError.class, source::acquire);

    assertSame(failure, thrown);
    assertSame(closeFailure, thrown.getSuppressed()[0]);
  }

  @Test
  void keepsTheOriginalErrorWhenTheCloseThrowsAnError() {
    StackOverflowError failure = new StackOverflowError("getAutoCommit overflowed");
    AssertionError closeFailure = new AssertionError("the close failed");
    Connection connection =
        (Connection)
            Proxy.newProxyInstance(
                Connection.class.getClassLoader(),
                new Class<?>[] {Connection.class},
                (proxy, method, arguments) -> {
                  switch (method.getName()) {
                    case "getAutoCommit" -> throw failure;
                    case "close" -> throw closeFailure;
                    default -> throw new UnsupportedOperationException(method.getName());
                  }
                });
    ConnectionSource source = ConnectionSource.of(new OneConnection(connection));

    StackOverflowError thrown = assertThrows(StackOverflowError.class, source::acquire);

    assertSame(failure, thrown);
    assertSame(closeFailure, thrown.getSuppressed()[0]);
  }

  /** A data source that gives one connection. */
  private record OneConnection(Connection connection) implements DataSource {
    @Override
    public Connection getConnection() {
      return connection;
    }

    @Override
    public Connection getConnection(String username, String password) {
      return connection;
    }

    @Override
    public PrintWriter getLogWriter() {
      throw new UnsupportedOperationException();
    }

    @Override
    public void setLogWriter(PrintWriter out) {
      throw new UnsupportedOperationException();
    }

    @Override
    public void setLoginTimeout(int seconds) {
      throw new UnsupportedOperationException();
    }

    @Override
    public int getLoginTimeout() {
      throw new UnsupportedOperationException();
    }

    @Override
    public Logger getParentLogger() {
      throw new UnsupportedOperationException();
    }

    @Override
    public <T> T unwrap(Class<T> type) throws SQLException {
      throw new SQLException("not a wrapper");
    }

    @Override
    public boolean isWrapperFor(Class<?> type) {
      return false;
    }
  }
}
