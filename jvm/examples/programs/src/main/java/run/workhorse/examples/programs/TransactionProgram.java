package run.workhorse.examples.programs;

import java.sql.Connection;
import java.sql.SQLException;
import java.util.Map;
import org.postgresql.ds.PGSimpleDataSource;
import run.workhorse.ConnectionSource;
import run.workhorse.EnqueueOptions;
import run.workhorse.EnqueueResult;
import run.workhorse.Queue;
import run.workhorse.QueueOptions;

/**
 * Enqueues a task inside a caller-owned transaction, so it exists only if the caller commits.
 *
 * <p>Documentation: https://workhorse.run/docs/enqueue
 */
public final class TransactionProgram {
  private TransactionProgram() {}

  public static void main(String[] arguments) throws SQLException {
    PGSimpleDataSource dataSource = Programs.dataSource("WORKHORSE_DATABASE_URL");
    Queue queue =
        new Queue(
            ConnectionSource.of(dataSource), QueueOptions.builder().defaultQueue("orders").build());
    EnqueueOptions options =
        EnqueueOptions.builder()
            .maxAttempts(3)
            .retryPolicy(
                Map.of(
                    "type",
                    "exponential",
                    "initialDelayMs",
                    1_000,
                    "multiplier",
                    2,
                    "maxDelayMs",
                    60_000))
            .build();

    try (Connection connection = dataSource.getConnection()) {
      connection.setAutoCommit(false);
      try {
        // Application writes can use the connection here. The task becomes visible only if the
        // caller commits the same transaction.
        EnqueueResult result =
            queue.enqueue(connection, "order.accepted", Map.of("orderId", "order-42"), options);
        connection.commit();
        System.out.println(result.taskId());
      } catch (SQLException | RuntimeException error) {
        connection.rollback();
        throw error;
      }
    }
  }
}
