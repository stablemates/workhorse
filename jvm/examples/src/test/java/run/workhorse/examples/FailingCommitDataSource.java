package run.workhorse.examples;

import java.io.PrintWriter;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Proxy;
import java.sql.Connection;
import java.sql.SQLException;
import java.sql.SQLFeatureNotSupportedException;
import java.util.logging.Logger;
import javax.sql.DataSource;
import org.jspecify.annotations.Nullable;

/**
 * A {@link DataSource} whose connections throw at {@code commit()}. A snippet that enqueues in its
 * transaction has then written its row and its task, and must roll back both.
 */
final class FailingCommitDataSource implements DataSource {
  private final DataSource delegate = ExampleDatabase.dataSource();

  @Override
  public Connection getConnection() throws SQLException {
    Connection connection = delegate.getConnection();
    return (Connection)
        Proxy.newProxyInstance(
            Connection.class.getClassLoader(),
            new Class<?>[] {Connection.class},
            (proxy, method, arguments) -> {
              if (method.getName().equals("commit")) {
                throw new SQLException("the commit fails");
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
