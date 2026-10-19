package run.workhorse.examples;

import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.SQLException;
import java.util.Map;
import java.util.UUID;
import org.postgresql.ds.PGSimpleDataSource;
import run.workhorse.Admin;
import run.workhorse.ConnectionSource;
import run.workhorse.EnqueueOptions;
import run.workhorse.Queue;
import run.workhorse.TaskDetail;
import run.workhorse.Worker;

/** The Java tab of the site page for AI agents. */
public final class ForAiAgentsExamples {
  private ForAiAgentsExamples() {}

  // docs:start java-for-ai-agents-integrate
  static String sendConfirmationEmail(String orderId) {
    return "receipt-for-" + orderId;
  }

  static TaskDetail integrate(String databaseUrl) throws SQLException {
    PGSimpleDataSource dataSource = new PGSimpleDataSource();
    dataSource.setURL(databaseUrl); // a JDBC URL, such as jdbc:postgresql://localhost/app
    Queue queue = new Queue(ConnectionSource.of(dataSource));

    UUID taskId;
    try (Connection connection = dataSource.getConnection()) {
      connection.setAutoCommit(false);
      try {
        try (PreparedStatement insert =
            connection.prepareStatement("INSERT INTO orders (id, status) VALUES (?, ?)")) {
          insert.setString(1, "order-42");
          insert.setString(2, "new");
          insert.executeUpdate();
        }
        taskId =
            queue
                .enqueue(
                    connection,
                    "order.created",
                    Map.of("orderId", "order-42"),
                    EnqueueOptions.builder()
                        .maxAttempts(5)
                        .retryPolicy(Map.of("type", "fixed", "delayMs", 1_000))
                        .build())
                .taskId();
        connection.commit();
      } catch (SQLException | RuntimeException error) {
        connection.rollback();
        throw error;
      }
    }

    try (Worker worker =
        Worker.builder(dataSource)
            .pollingOnly(true)
            .handle(
                "order.created",
                Map.class,
                (context, payload) -> {
                  String orderId = String.valueOf(payload.get("orderId"));
                  // The send runs once. A replay reuses the recorded receipt.
                  String receipt =
                      context.checkpoint(
                          "confirmation-email", String.class, () -> sendConfirmationEmail(orderId));
                  return Map.of("processedOrderId", orderId, "receipt", receipt);
                })
            .build()) {
      worker.runOnce(); // Production workers call WorkerProcess.runWorkerProcess(worker).
    }

    TaskDetail task = new Admin(ConnectionSource.of(dataSource)).getTask(taskId).orElseThrow();
    System.out.println(task.state() + " " + task.result());
    return task;
  }
  // docs:end
}
