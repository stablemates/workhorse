package run.workhorse.examples;

import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.SQLException;
import java.util.Map;
import java.util.UUID;
import javax.sql.DataSource;
import org.postgresql.ds.PGSimpleDataSource;
import run.workhorse.Admin;
import run.workhorse.ConnectionSource;
import run.workhorse.Queue;
import run.workhorse.TaskDetail;
import run.workhorse.Worker;

/** The Java tabs of the site quickstart. */
public final class QuickstartExamples {
  private QuickstartExamples() {}

  /**
   * Enqueues one {@code email.welcome} task, runs it, and returns its detail. {@code databaseUrl}
   * is a PostgreSQL JDBC URL.
   */
  public static TaskDetail runTask(String databaseUrl) {
    // docs:start java-quickstart-run-task
    PGSimpleDataSource dataSource = new PGSimpleDataSource();
    dataSource.setURL(databaseUrl); // a JDBC URL, such as jdbc:postgresql://localhost/app
    Queue queue = new Queue(ConnectionSource.of(dataSource));
    UUID taskId = queue.enqueue("email.welcome", Map.of("to", "ada@example.com")).taskId();

    try (Worker worker =
        Worker.builder(dataSource)
            .handle(
                "email.welcome",
                Map.class,
                (context, payload) -> Map.of("deliveredTo", String.valueOf(payload.get("to"))))
            .build()) {
      worker.runOnce(); // one claim-and-run pass; production uses WorkerProcess.runWorkerProcess
    }

    TaskDetail task = new Admin(ConnectionSource.of(dataSource)).getTask(taskId).orElseThrow();
    System.out.println(task.state() + " " + task.result());
    // docs:end
    return task;
  }

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
