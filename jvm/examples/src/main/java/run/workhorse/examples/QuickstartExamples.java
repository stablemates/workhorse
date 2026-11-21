package run.workhorse.examples;

import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.SQLException;
import java.util.Map;
import javax.sql.DataSource;
import run.workhorse.Queue;

/** The Java tab of step 5 of the site quickstart. {@link Quickstart} holds the tab of step 3. */
public final class QuickstartExamples {
  private QuickstartExamples() {}

  // docs:start java-quickstart-enqueue-with-data
  static void createOrder(DataSource dataSource, Queue queue, String orderId) throws SQLException {
    try (Connection connection = dataSource.getConnection()) {
      connection.setAutoCommit(false);
      try {
        try (PreparedStatement insert =
            connection.prepareStatement("INSERT INTO orders (id) VALUES (?)")) {
          insert.setString(1, orderId);
          insert.executeUpdate();
        }
        queue.enqueue(connection, "order.fulfill", Map.of("orderId", orderId));
        connection.commit();
      } catch (SQLException | RuntimeException error) {
        connection.rollback();
        throw error;
      }
    }
  }
  // docs:end
}
