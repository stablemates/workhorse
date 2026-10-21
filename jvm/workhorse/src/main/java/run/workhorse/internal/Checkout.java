package run.workhorse.internal;

import java.sql.Connection;
import java.sql.SQLException;
import java.util.concurrent.CompletableFuture;
import java.util.function.BiConsumer;
import javax.sql.DataSource;
import org.jspecify.annotations.Nullable;

/**
 * Checks out one connection from a {@link DataSource} on its own daemon thread (ADR 0071). A pool
 * can make {@code getConnection} wait for its own timeout, for example the 30 s of HikariCP, and
 * that is longer than a lease. So the caller waits for a checkout only until its own deadline, and
 * the checkout continues without it. A connection that nobody wants when it arrives is closed, so
 * it goes back to the pool.
 */
final class Checkout {
  private Checkout() {}

  /**
   * Starts a checkout, and gives its connection or its failure to {@code done} on the checkout
   * thread. Exactly one of the two arguments is {@code null}.
   */
  static void start(
      DataSource dataSource,
      String name,
      BiConsumer<@Nullable Connection, @Nullable Throwable> done) {
    Thread.ofPlatform()
        .daemon()
        .name(name)
        .start(
            () -> {
              Connection connection;
              try {
                connection = dataSource.getConnection();
              } catch (Throwable error) {
                done.accept(null, error);
                return;
              }
              done.accept(connection, null);
            });
  }

  /** Starts a checkout, and returns its result. */
  static CompletableFuture<Connection> start(DataSource dataSource, String name) {
    CompletableFuture<Connection> result = new CompletableFuture<>();
    start(
        dataSource,
        name,
        (connection, error) -> {
          if (connection != null) {
            result.complete(connection);
          } else {
            result.completeExceptionally(
                error != null ? error : new SQLException("The checkout gave no connection"));
          }
        });
    return result;
  }

  /** Closes {@code connection}, and ignores a failure: the pool replaces a broken connection. */
  static void closeQuietly(@Nullable Connection connection) {
    if (connection == null) {
      return;
    }
    try {
      connection.close();
    } catch (SQLException | RuntimeException ignored) {
      // Nothing else can use the connection.
    }
  }
}
