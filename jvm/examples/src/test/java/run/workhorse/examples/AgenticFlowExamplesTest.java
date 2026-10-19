package run.workhorse.examples;

import static org.junit.jupiter.api.Assertions.assertEquals;

import java.time.Duration;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import javax.sql.DataSource;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.extension.ExtendWith;
import run.workhorse.Admin;
import run.workhorse.ConnectionSource;
import run.workhorse.TaskDetail;
import run.workhorse.TaskState;
import run.workhorse.Worker;
import run.workhorse.testing.ScratchDatabase;

/** Runs the Java handlers of the site page about the durable agentic flow. */
@ExtendWith(ScratchDatabase.class)
@Timeout(value = 120, unit = TimeUnit.SECONDS)
class AgenticFlowExamplesTest {
  private final DataSource dataSource = ExampleDatabase.dataSource();
  private final DurableFlowDriver driver = new DurableFlowDriver(dataSource);

  @Test
  void theLoopPlansOneTimeRunsItsToolsAndWaitsForApproval() throws Exception {
    AtomicInteger modelCalls = new AtomicInteger();
    AgenticFlowExamples examples =
        new AgenticFlowExamples(
            prompt -> {
              modelCalls.incrementAndGet();
              return "plan for " + prompt;
            },
            driver.queueName(),
            Duration.ofMillis(200));
    try (Worker worker = examples.register(driver.builder(dataSource)).build()) {
      UUID taskId =
          driver.enqueue(
              "agent.loop", Map.of("conversationId", "conv-12", "prompt", "Plan the trip"));
      driver.deliverSignal(worker, taskId, "approval", Map.of("approved", true));
      TaskDetail task = driver.finish(worker, taskId);
      assertEquals(TaskState.SUCCEEDED, task.state());
      assertEquals(
          Map.of(
              "plan", "plan for Plan the trip",
              "tools", Map.of("research", Map.of("sources", 3L), "calculate", Map.of("total", 42L)),
              "approval", Map.of("approved", true)),
          task.result());
      assertEquals(1, modelCalls.get(), "each replay returns the stored plan");
      assertEquals(
          Map.of("stage", "planned"),
          new Admin(ConnectionSource.of(dataSource)).getProgress(taskId).orElseThrow().value());
    }
  }
}
