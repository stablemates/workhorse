package run.workhorse.examples;

import static org.junit.jupiter.api.Assertions.assertEquals;

import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import javax.sql.DataSource;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.extension.ExtendWith;
import run.workhorse.ConcurrencyPolicy;
import run.workhorse.ConnectionSource;
import run.workhorse.Queue;
import run.workhorse.TaskDetail;
import run.workhorse.TaskState;
import run.workhorse.Worker;
import run.workhorse.testing.ScratchDatabase;

/** Runs the Java fulfillment of the site page "What is Workhorse?". */
@ExtendWith(ScratchDatabase.class)
@Timeout(value = 120, unit = TimeUnit.SECONDS)
class OverviewExamplesTest {
  private final DataSource dataSource = ExampleDatabase.dataSource();
  private final Queue queue = new Queue(ConnectionSource.of(dataSource));
  private final DurableFlowDriver driver = new DurableFlowDriver(dataSource);
  private final List<String> calls = new CopyOnWriteArrayList<>();
  private final AtomicInteger receipts = new AtomicInteger();

  @Test
  void theFulfillmentWaitsForTheParcelAndChargesTheCardOneTime() throws Exception {
    String enqueued = "java-" + UUID.randomUUID();
    OverviewExamples examples =
        new OverviewExamples(
            (orderId, idempotencyKey) -> {
              calls.add("charge " + orderId + " " + idempotencyKey);
              return Map.of("id", "ch-" + orderId);
            },
            (email, charge, trackingNumber) -> {
              calls.add("receipt " + email + " " + trackingNumber);
              if (receipts.incrementAndGet() == 1) {
                throw new IllegalStateException("the mail service is not available");
              }
              return Map.of("sent", true);
            });
    try (Worker worker =
        examples
            .fulfill(queue, driver.builder(dataSource), enqueued, "ada@example.com", "merchant-42")
            .build()) {
      ConcurrencyPolicy policy = queue.listConcurrencyPolicies(List.of("fulfillment")).get(0);
      assertEquals("shop", policy.namespace());
      assertEquals(3, policy.maxActivePerKey());
      TaskDetail stored = ExampleDatabase.task("order.fulfill", "orderId", enqueued);
      assertEquals("fulfillment", stored.queue());
      assertEquals("merchant-42", stored.concurrencyKey());

      UUID taskId =
          driver.enqueue("order.fulfill", Map.of("orderId", "order-9", "email", "ada@example.com"));
      driver.deliverSignal(worker, taskId, "order-shipped", Map.of("trackingNumber", "TRK-1"));
      TaskDetail task = driver.finish(worker, taskId);
      assertEquals(TaskState.SUCCEEDED, task.state());
      assertEquals(2, task.currentAttempt(), "the first receipt failed");
      assertEquals(
          List.of(
              "charge order-9 charge:order-9",
              "receipt ada@example.com TRK-1",
              "receipt ada@example.com TRK-1"),
          calls);
      assertEquals(
          Map.of("charge", Map.of("id", "ch-order-9"), "trackingNumber", "TRK-1"), task.result());
    }
  }
}
