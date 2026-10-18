package run.workhorse.examples;

import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.SQLException;
import java.util.Map;
import javax.sql.DataSource;
import run.workhorse.Queue;

/** Enqueue in a JDBC transaction: guide 200 and the site page about enqueue. */
public final class JdbcTransaction {
  private final DataSource dataSource;
  private final Queue queue;

  /** The queue is {@code new Queue(ConnectionSource.of(dataSource))}. */
  public JdbcTransaction(DataSource dataSource, Queue queue) {
    this.dataSource = dataSource;
    this.queue = queue;
  }

  // docs:start java-jdbc-transaction
  void createAccount(String id, String email) throws SQLException {
    try (Connection connection = dataSource.getConnection()) {
      connection.setAutoCommit(false);
      try {
        try (PreparedStatement insert =
            connection.prepareStatement("INSERT INTO account (id, email) VALUES (?, ?)")) {
          insert.setString(1, id);
          insert.setString(2, email);
          insert.executeUpdate();
        }
        queue.enqueue(connection, "account.created", Map.of("accountId", id));
        connection.commit();
      } catch (SQLException | RuntimeException error) {
        connection.rollback();
        throw error;
      }
    }
  }

  // docs:end

  /** The short form in the tab group of the site page. The caller owns the connection. */
  void enqueueInTransaction(Connection connection, String id, String email) throws SQLException {
    // docs:start java-enqueue-in-transaction
    connection.setAutoCommit(false);
    try (PreparedStatement insert =
        connection.prepareStatement("INSERT INTO account (id, email) VALUES (?, ?)")) {
      insert.setString(1, id);
      insert.setString(2, email);
      insert.executeUpdate();
    }
    queue.enqueue(connection, "account.created", Map.of("accountId", id));
    connection.commit();
    // docs:end
  }
}
