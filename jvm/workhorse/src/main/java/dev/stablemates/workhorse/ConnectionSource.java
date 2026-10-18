package dev.stablemates.workhorse;

import java.sql.Connection;
import java.sql.SQLException;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import javax.sql.DataSource;

/**
 * Supplies the connection for each call of the source form of {@link Queue} (ADR 0103, "Connection
 * model").
 *
 * <p>The SDK calls {@link #acquire} once for each call, runs its statements on that connection, and
 * then calls {@link #release}. The SDK never begins, commits, or rolls back a transaction on the
 * connection, and it changes no session state.
 */
public interface ConnectionSource {
  /** A connection for one call. */
  Connection acquire() throws SQLException;

  /**
   * Gives back the connection of one call.
   *
   * @param connection the connection that {@link #acquire} gave
   * @param transactional {@code true} when the connection held a transaction that the source owns
   *     while the call ran, so the source must not end it; {@code false} when the call ran in
   *     autocommit
   */
  void release(Connection connection, boolean transactional) throws SQLException;

  /**
   * A source that runs each call in autocommit on a connection from {@code dataSource}.
   *
   * <p>If the pool gives a connection with autocommit off, the source turns autocommit on for the
   * call. It restores the earlier value before it closes the connection.
   */
  static ConnectionSource of(DataSource dataSource) {
    Set<Connection> restore = ConcurrentHashMap.newKeySet();
    return new ConnectionSource() {
      @Override
      public Connection acquire() throws SQLException {
        Connection connection = dataSource.getConnection();
        try {
          if (!connection.getAutoCommit()) {
            connection.setAutoCommit(true);
            restore.add(connection);
          }
          return connection;
        } catch (SQLException | RuntimeException error) {
          connection.close();
          throw error;
        }
      }

      @Override
      public void release(Connection connection, boolean transactional) throws SQLException {
        try {
          if (restore.remove(connection)) {
            connection.setAutoCommit(false);
          }
        } finally {
          connection.close();
        }
      }
    };
  }
}
