package run.workhorse.examples;

import static org.junit.jupiter.api.Assertions.assertEquals;

import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import javax.sql.DataSource;
import org.jspecify.annotations.Nullable;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.extension.ExtendWith;
import run.workhorse.TaskDetail;
import run.workhorse.TaskState;
import run.workhorse.Worker;
import run.workhorse.testing.ScratchDatabase;

/** Runs the Java handlers of the site page about durable execution. */
@ExtendWith(ScratchDatabase.class)
@Timeout(value = 120, unit = TimeUnit.SECONDS)
class DurableExecutionExamplesTest {
  private final DataSource dataSource = ExampleDatabase.dataSource();
  private final DurableFlowDriver driver = new DurableFlowDriver(dataSource);
  private final List<String> calls = new CopyOnWriteArrayList<>();
  private final AtomicInteger shipments = new AtomicInteger();

  @Test
  void aRetryReturnsTheStoredChargeAndDoesNotChargeAgain() throws Exception {
    try (Worker worker = examples().registerCheckpoints(driver.builder(dataSource)).build()) {
      UUID taskId = driver.enqueue("order.fulfill", Map.of("orderId", "ord-7"));
      TaskDetail task = driver.finish(worker, taskId);
      assertEquals(TaskState.SUCCEEDED, task.state());
      assertEquals(2, task.currentAttempt(), "the first shipment call failed");
      assertEquals(List.of("charge ord-7 charge:ord-7", "ship ord-7", "ship ord-7"), calls);
      assertEquals(Map.of("shipmentId", "ship-ord-7", "chargeId", "ch-ord-7"), task.result());
    }
  }

  @Test
  void theFollowUpWaitsForItsTimeAndTheWelcomeRunsOneTime() throws Exception {
    try (Worker worker = examples().registerFollowUp(driver.builder(dataSource)).build()) {
      Instant followUpAt = Instant.now().plusMillis(500);
      UUID taskId =
          driver.enqueue(
              "trial.follow-up",
              Map.of("to", "person@example.com", "followUpAt", followUpAt.toString()));
      TaskDetail task = driver.finish(worker, taskId);
      assertEquals(TaskState.SUCCEEDED, task.state());
      assertEquals(1, task.currentAttempt(), "a wait keeps the attempt");
      assertEquals(List.of("welcome person@example.com", "follow-up person@example.com"), calls);
    }
  }

  @Test
  void theReviewReturnsTheSignalAndTheDecision() throws Exception {
    try (Worker worker = examples().registerExternalWaits(driver.builder(dataSource)).build()) {
      UUID taskId = driver.enqueue("order.review", null);
      driver.deliverSignal(worker, taskId, "provider-event", Map.of("id", "evt-5"));
      driver.completeHumanWait(worker, taskId, "operator-review", Map.of("approved", true));
      TaskDetail task = driver.finish(worker, taskId);
      assertEquals(TaskState.SUCCEEDED, task.state());
      assertEquals(
          Map.of("event", Map.of("id", "evt-5"), "review", Map.of("approved", true)),
          task.result());
    }
  }

  private DurableExecutionExamples examples() {
    return new DurableExecutionExamples(
        (orderId, idempotencyKey) -> {
          calls.add("charge " + orderId + " " + idempotencyKey);
          return Map.of("id", "ch-" + orderId);
        },
        (orderId, charge) -> {
          calls.add("ship " + orderId);
          if (shipments.incrementAndGet() == 1) {
            throw new IllegalStateException("the shipment service is not available");
          }
          return Map.of("shipmentId", "ship-" + orderId, "chargeId", chargeId(charge));
        },
        new DurableExecutionExamples.TrialMailer() {
          @Override
          public Map<String, @Nullable Object> welcome(String to) {
            calls.add("welcome " + to);
            return Map.of("sent", true);
          }

          @Override
          public Map<String, @Nullable Object> followUp(String to) {
            calls.add("follow-up " + to);
            return Map.of("sent", true);
          }
        });
  }

  private static Object chargeId(@Nullable Object charge) {
    return String.valueOf(((Map<?, ?>) charge).get("id"));
  }
}
