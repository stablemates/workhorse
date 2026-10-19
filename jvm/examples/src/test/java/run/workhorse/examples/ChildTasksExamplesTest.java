package run.workhorse.examples;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertInstanceOf;
import static org.junit.jupiter.api.Assertions.assertNotNull;

import java.sql.SQLException;
import java.time.Duration;
import java.util.Map;
import java.util.Objects;
import java.util.UUID;
import java.util.concurrent.TimeUnit;
import javax.sql.DataSource;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.extension.ExtendWith;
import run.workhorse.EnqueueOptions;
import run.workhorse.Queue;
import run.workhorse.TaskDetail;
import run.workhorse.TaskState;
import run.workhorse.Worker;
import run.workhorse.testing.ScratchDatabase;

/** Runs the Java snippets of the site page about child tasks under a real worker. */
@ExtendWith(ScratchDatabase.class)
// Each test creates and drops its own database, which is slow on a loaded host.
@Timeout(value = 240, unit = TimeUnit.SECONDS)
class ChildTasksExamplesTest {
  // The worker reads `orders` and `payments`, which other snippet tests also use, so each test has
  // its own database.
  private final IsolatedExampleDatabase database;
  private final DataSource dataSource;
  private final Queue queue;

  ChildTasksExamplesTest() throws Exception {
    database = IsolatedExampleDatabase.create("child-tasks-java");
    dataSource = database.dataSource();
    queue = database.queue();
  }

  @AfterEach
  void dropDatabase() throws SQLException {
    database.close();
  }

  @Test
  void runChildGivesTheParentTheReceiptOfTheChild() throws Exception {
    UUID parentId = enqueue("orders.charge-java", Map.of("id", "ord-7"));
    try (Worker worker =
        worker()
            .handle(
                "orders.charge-java",
                Map.class,
                (context, order) ->
                    ChildTasksExamples.charge(
                        context,
                        new ChildTasksOrder(Objects.requireNonNull((String) order.get("id")))))
            .handle(
                "payments.charge",
                Map.class,
                (context, payment) -> Map.of("receiptId", "rcpt-" + payment.get("orderId")))
            .build()) {
      worker.start();
      TaskDetail parent = database.awaitTerminal(parentId);
      assertEquals(TaskState.SUCCEEDED, parent.state());
      assertEquals(Map.of("receiptId", "rcpt-ord-7"), parent.result());
      assertEquals(1, parent.childTaskIds().size());
      assertEquals("payments", database.detail(parent.childTaskIds().get(0)).queue());
    }
  }

  @Test
  void runChildrenGivesTheParentTheFailedFraudCheck() throws Exception {
    UUID parentId = enqueue("orders.checkout-java", Map.of("orderId", "ord-9"));
    try (Worker worker =
        worker()
            .handle(
                "orders.checkout-java",
                Map.class,
                (context, order) ->
                    ChildTasksExamples.checkout(
                        context, Objects.requireNonNull((String) order.get("orderId"))))
            .handle(
                "orders.check-fraud",
                Map.class,
                (context, payload) -> {
                  throw new IllegalStateException("the card is on a block list");
                })
            .handle("orders.reserve", Map.class, (context, payload) -> Map.of("reserved", true))
            .build()) {
      worker.start();
      TaskDetail parent = database.awaitTerminal(parentId);
      assertEquals(TaskState.SUCCEEDED, parent.state());
      Map<?, ?> result = assertInstanceOf(Map.class, parent.result());
      assertEquals(false, result.get("accepted"));
      assertNotNull(result.get("reason"));
      assertEquals(2, parent.childTaskIds().size());
      for (UUID childId : parent.childTaskIds()) {
        assertEquals("orders", database.detail(childId).queue());
      }
    }
  }

  private UUID enqueue(String taskType, Map<String, String> payload) {
    return queue
        .enqueue(taskType, payload, EnqueueOptions.builder().queue("orders").build())
        .taskId();
  }

  /** A worker that retries a failed child at once, so the fraud child fails fast. */
  private Worker.Builder worker() {
    return Worker.builder(dataSource)
        .queues("orders", "payments")
        .pollInterval(Duration.ofMillis(50))
        .retryDelay((attempt, task) -> Duration.ZERO);
  }
}
