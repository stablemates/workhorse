package run.workhorse.examples;

import static org.junit.jupiter.api.Assertions.assertEquals;

import java.util.Map;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.extension.ExtendWith;
import run.workhorse.TaskDetail;
import run.workhorse.TaskState;
import run.workhorse.testing.ScratchDatabase;

/** Runs the Java snippet of the site page for AI agents. */
@ExtendWith(ScratchDatabase.class)
@Timeout(value = 120, unit = TimeUnit.SECONDS)
class ForAiAgentsExamplesTest {
  @Test
  void theIntegrationCommitsTheOrderAndStoresTheResult() throws Exception {
    try (IsolatedExampleDatabase database = IsolatedExampleDatabase.create("for_ai_agents_java")) {
      TaskDetail task = ForAiAgentsExamples.integrate(database.jdbcUrl());
      assertEquals(1, database.orders("order-42"));
      assertEquals(TaskState.SUCCEEDED, task.state());
      assertEquals(5, task.maxAttempts());
      assertEquals(Map.of("type", "fixed", "delayMs", 1_000L), task.retryPolicy());
      assertEquals(
          Map.of("processedOrderId", "order-42", "receipt", "receipt-for-order-42"), task.result());
    }
  }
}
