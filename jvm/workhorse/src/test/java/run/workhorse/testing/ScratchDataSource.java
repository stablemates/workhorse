package run.workhorse.testing;

import java.io.PrintWriter;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Proxy;
import java.sql.Connection;
import java.sql.SQLException;
import java.sql.SQLFeatureNotSupportedException;
import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.logging.Logger;
import javax.sql.DataSource;
import org.jspecify.annotations.Nullable;

/**
 * A {@link DataSource} over {@link ScratchDatabase}, as a pool gives connections. It can give each
 * connection with autocommit off, and it records the autocommit mode of each connection when the
 * caller closes it.
 */
public final class ScratchDataSource implements DataSource {
  private final boolean autoCommit;
  private final List<Boolean> autoCommitAtClose = new CopyOnWriteArrayList<>();

  /** A source whose connections start with {@code autoCommit}. */
  public ScratchDataSource(boolean autoCommit) {
    this.autoCommit = autoCommit;
  }

  /** The autocommit mode of each closed connection, in close order. */
  public List<Boolean> autoCommitAtClose() {
    return List.copyOf(autoCommitAtClose);
  }

  @Override
  public Connection getConnection() throws SQLException {
    Connection connection = ScratchDatabase.connect();
    connection.setAutoCommit(autoCommit);
    return (Connection)
        Proxy.newProxyInstance(
            Connection.class.getClassLoader(),
            new Class<?>[] {Connection.class},
            (proxy, method, arguments) -> {
              if (method.getName().equals("close")) {
                autoCommitAtClose.add(connection.getAutoCommit());
              }
              try {
                return method.invoke(connection, arguments);
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
}
