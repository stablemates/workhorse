package run.workhorse.examples;

import static org.junit.jupiter.api.Assertions.assertEquals;

import java.util.Map;
import java.util.UUID;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import javax.sql.DataSource;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.extension.ExtendWith;
import run.workhorse.TaskDetail;
import run.workhorse.TaskState;
import run.workhorse.Worker;
import run.workhorse.testing.ScratchDatabase;

/** Runs the Java handler of the site page about signals. */
@ExtendWith(ScratchDatabase.class)
@Timeout(value = 120, unit = TimeUnit.SECONDS)
class SignalsExamplesTest {
  private final DataSource dataSource = ExampleDatabase.dataSource();
  private final DurableFlowDriver driver = new DurableFlowDriver(dataSource);

  @Test
  void anApprovalSignalPublishesTheOrderOneTime() throws Exception {
    AtomicInteger published = new AtomicInteger();
    try (Worker worker =
        new SignalsExamples(published::incrementAndGet)
            .register(driver.builder(dataSource))
            .build()) {
      UUID taskId = driver.enqueue("order.publish", Map.of("orderId", "ord-381"));
      driver.deliverSignal(worker, taskId, "approval", Map.of("approved", true));
      TaskDetail task = driver.finish(worker, taskId);
      assertEquals(TaskState.SUCCEEDED, task.state());
      assertEquals(1, task.currentAttempt());
      assertEquals(Map.of("approved", true), task.result());
      assertEquals(1, published.get());
    }
  }
}
