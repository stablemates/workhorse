package run.workhorse.spring;

import java.lang.invoke.MethodHandle;
import java.lang.invoke.MethodHandles;
import java.lang.invoke.MethodType;
import java.sql.Connection;
import java.sql.SQLException;
import java.util.Objects;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import javax.sql.DataSource;
import org.apache.commons.logging.Log;
import org.apache.commons.logging.LogFactory;
import org.jspecify.annotations.Nullable;
import org.springframework.jdbc.CannotGetJdbcConnectionException;
import org.springframework.jdbc.datasource.ConnectionHolder;
import org.springframework.jdbc.datasource.DataSourceUtils;
import org.springframework.transaction.support.TransactionSynchronizationManager;
import run.workhorse.ConnectionSource;

/**
 * A {@link ConnectionSource} that joins the current Spring transaction (ADR 0103, "Connection
 * model").
 *
 * <p>Inside a Spring transaction of this {@code DataSource}, such as one that {@code
 * DataSourceTransactionManager} began, {@link #acquire} returns the connection that holds the
 * transaction, so an enqueue commits and rolls back with the caller's work. Outside such a
 * transaction, it returns a connection from the pool in autocommit, as {@link ConnectionSource#of}
 * does: if the pool gives a connection with autocommit off, the source turns autocommit on for the
 * call and restores the earlier value before it releases the connection. That includes a {@code
 * SUPPORTS} or {@code NOT_SUPPORTED} scope, and a transaction of another transaction manager, for
 * example one of a second {@code DataSource}.
 *
 * <p>A {@code JtaTransactionManager} binds no holder of its own. The container enlists the
 * connection that {@code DataSourceUtils} binds for synchronization. So when the starter finds a
 * {@code JtaTransactionManager} bean, the source joins any actual transaction that holds the
 * connection, as before SM-1518.
 *
 * <p>The source never begins, commits, or rolls back a transaction, and it changes no session state
 * of a transaction's connection.
 */
public final class TransactionAwareConnectionSource implements ConnectionSource {
  private static final Log LOG = LogFactory.getLog(TransactionAwareConnectionSource.class);

  /**
   * {@code ConnectionHolder.isTransactionActive}, or {@code null} when the lookup failed. Spring
   * publishes no public accessor. Its jars are automatic or unnamed modules, which open every
   * package to a private lookup.
   */
  private static final @Nullable MethodHandle TRANSACTION_ACTIVE =
      findTransactionActive(MethodHandles.lookup());

  private final DataSource dataSource;
  private final boolean jta;
  private final @Nullable MethodHandle transactionActive;
  private final Set<Connection> restore = ConcurrentHashMap.newKeySet();

  /**
   * A source over {@code dataSource}, the same {@code DataSource} the transaction manager uses.
   *
   * <p>A source built with this constructor does not join a JTA transaction: under a {@code
   * JtaTransactionManager}, it runs the call in autocommit. A JTA application uses the {@code
   * ConnectionSource} bean of the starter, which finds the {@code JtaTransactionManager}.
   */
  public TransactionAwareConnectionSource(DataSource dataSource) {
    this(dataSource, false);
  }

  /**
   * A source that, when {@code jta} is true, joins any actual transaction that holds the
   * connection. The auto-configuration sets it when the context has a {@code
   * JtaTransactionManager}.
   */
  TransactionAwareConnectionSource(DataSource dataSource, boolean jta) {
    this(dataSource, jta, TRANSACTION_ACTIVE);
  }

  /** The seam of a test: a {@code null} {@code transactionActive} acts as a failed lookup. */
  TransactionAwareConnectionSource(
      DataSource dataSource, boolean jta, @Nullable MethodHandle transactionActive) {
    this.dataSource = Objects.requireNonNull(dataSource, "dataSource");
    this.jta = jta;
    this.transactionActive = transactionActive;
  }

  /** Whether this source joins any actual transaction that holds the connection (JTA mode). */
  boolean joinsAnyTransaction() {
    return jta;
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
      // Only a transaction of this DataSource commits the call's statements. Under SUPPORTS,
      // NOT_SUPPORTED, or another transaction manager, Spring binds the connection for
      // synchronization only, so the binding alone does not mean that a transaction owns it.
      boolean owned =
          TransactionSynchronizationManager.isActualTransactionActive()
              && DataSourceUtils.isConnectionTransactional(connection, dataSource)
              && (jta
                  || ownedByTransaction(
                      (ConnectionHolder)
                          TransactionSynchronizationManager.getResource(dataSource)));
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

  /**
   * Whether a transaction of this {@code DataSource} bound {@code holder}. A synchronization-only
   * holder is the one kind that a transaction does not own. {@code DataSourceUtils.getConnection}
   * binds it with {@code synchronizedWithTransaction} set and {@code transactionActive} clear.
   * {@code DataSourceTransactionManager} sets both flags on its holder. {@code
   * JpaTransactionManager} and {@code HibernateTransactionManager} set neither on the holder they
   * bind for the {@code DataSource}. Without the lookup, every holder counts as owned, as before
   * SM-1518.
   */
  private boolean ownedByTransaction(@Nullable ConnectionHolder holder) {
    MethodHandle active = transactionActive;
    if (active == null) {
      return true;
    }
    if (holder == null) {
      return false;
    }
    if (!holder.isSynchronizedWithTransaction()) {
      return true;
    }
    try {
      return (boolean) active.invokeExact(holder);
    } catch (RuntimeException | Error error) {
      throw error;
    } catch (Throwable error) {
      throw new IllegalStateException(error);
    }
  }

  /**
   * Looks up {@code ConnectionHolder.isTransactionActive} through {@code caller}. If the lookup
   * fails, it logs one warning and returns {@code null}, and each source then treats every
   * transactional connection as owned, as before SM-1518.
   */
  static @Nullable MethodHandle findTransactionActive(MethodHandles.Lookup caller) {
    try {
      return MethodHandles.privateLookupIn(ConnectionHolder.class, caller)
          .findVirtual(
              ConnectionHolder.class, "isTransactionActive", MethodType.methodType(boolean.class));
    } catch (ReflectiveOperationException | RuntimeException error) {
      LOG.warn(
          "Workhorse cannot read ConnectionHolder.isTransactionActive, so it treats every"
              + " connection that an actual Spring transaction holds as owned. An enqueue under"
              + " another transaction manager then does not commit on its own.",
          error);
      return null;
    }
  }
}
