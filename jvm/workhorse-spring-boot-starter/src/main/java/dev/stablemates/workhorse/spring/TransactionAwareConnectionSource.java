package dev.stablemates.workhorse.spring;

import dev.stablemates.workhorse.ConnectionSource;
import java.sql.Connection;
import java.sql.SQLException;
import java.util.Objects;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import javax.sql.DataSource;
import org.springframework.jdbc.CannotGetJdbcConnectionException;
import org.springframework.jdbc.datasource.DataSourceUtils;
import org.springframework.transaction.support.TransactionSynchronizationManager;

/**
 * A {@link ConnectionSource} that joins the current Spring transaction (ADR 0103, "Connection
 * model").
 *
 * <p>Inside a Spring transaction, {@link #acquire} returns the connection that holds the
 * transaction, so an enqueue commits and rolls back with the caller's work. Outside an actual
 * transaction, including a {@code SUPPORTS} or {@code NOT_SUPPORTED} scope, it returns a connection
 * from the pool in autocommit, as {@link ConnectionSource#of} does: if the pool gives a connection
 * with autocommit off, the source turns autocommit on for the call and restores the earlier value
 * before it releases the connection. The source never begins, commits, or rolls back a transaction,
 * and it changes no session state of a transaction's connection.
 */
public final class TransactionAwareConnectionSource implements ConnectionSource {
  private final DataSource dataSource;
  private final Set<Connection> restore = ConcurrentHashMap.newKeySet();

  /** A source over {@code dataSource}, the same {@code DataSource} the transaction manager uses. */
  public TransactionAwareConnectionSource(DataSource dataSource) {
    this.dataSource = Objects.requireNonNull(dataSource, "dataSource");
  }

  @Override
  public Connection acquire() throws SQLException {
    Connection connection;
    try {
      connection = DataSourceUtils.getConnection(dataSource);
    } catch (CannotGetJdbcConnectionException error) {
      if (error.getCause() instanceof SQLException cause) {
        throw cause;
      }
      throw error;
    }
    try {
      // Without an actual Spring transaction, nothing commits the call's statements. Under
      // SUPPORTS or NOT_SUPPORTED, Spring binds the connection for synchronization only, so the
      // binding alone does not mean that a transaction owns it.
      boolean owned =
          TransactionSynchronizationManager.isActualTransactionActive()
              && DataSourceUtils.isConnectionTransactional(connection, dataSource);
      if (!owned && !connection.getAutoCommit()) {
        connection.setAutoCommit(true);
        restore.add(connection);
      }
      return connection;
    } catch (SQLException | RuntimeException error) {
      DataSourceUtils.releaseConnection(connection, dataSource);
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
      // DataSourceUtils closes the connection only when no Spring transaction holds it.
      DataSourceUtils.releaseConnection(connection, dataSource);
    }
  }
}
