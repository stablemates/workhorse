package dev.stablemates.workhorse.conformance;

import dev.stablemates.workhorse.ConnectionSource;
import java.io.PrintWriter;
import java.sql.Connection;
import java.sql.SQLException;
import java.sql.SQLFeatureNotSupportedException;
import java.util.logging.Logger;
import javax.sql.DataSource;
import org.jspecify.annotations.Nullable;

/** The connection shapes the runner hands to the SDK. */
final class Connections {
  /** Opens one new connection. */
  @FunctionalInterface
  interface Opener {
    Connection open() throws SQLException;
  }

  private Connections() {}

  /**
   * A {@link ConnectionSource} that always gives {@code connection} and never closes it, so a
   * client call runs on the runner's own session, as the Ruby client runs on the caller's
   * connection.
   */
  static ConnectionSource borrowed(Connection connection) {
    return new ConnectionSource() {
      @Override
      public Connection acquire() {
        return connection;
      }

      @Override
      public void release(Connection released, boolean transactional) {}
    };
  }

  /** A {@link DataSource} that opens a new connection for each call, as an unpooled source does. */
  static DataSource dataSource(Opener opener) {
    return new DataSource() {
      @Override
      public Connection getConnection() throws SQLException {
        return opener.open();
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
    };
  }
}
