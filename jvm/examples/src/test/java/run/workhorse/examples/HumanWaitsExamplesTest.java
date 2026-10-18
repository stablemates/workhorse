package run.workhorse.examples;

import static org.junit.jupiter.api.Assertions.assertEquals;

import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.TimeUnit;
import javax.sql.DataSource;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.extension.ExtendWith;
import run.workhorse.TaskDetail;
import run.workhorse.TaskState;
import run.workhorse.Worker;
import run.workhorse.testing.ScratchDatabase;

/** Runs the Java handler of the site page about human waits. */
@ExtendWith(ScratchDatabase.class)
@Timeout(value = 120, unit = TimeUnit.SECONDS)
class HumanWaitsExamplesTest {
  private final DataSource dataSource = ExampleDatabase.dataSource();
  private final DurableFlowDriver driver = new DurableFlowDriver(dataSource);

  @Test
  void anApprovalActivatesTheAccountInTheSameAttempt() throws Exception {
    List<String> activated = new CopyOnWriteArrayList<>();
    try (Worker worker =
        new HumanWaitsExamples(activated::add).register(driver.builder(dataSource)).build()) {
      UUID taskId = driver.enqueue("account.activate", Map.of("accountId", "acct-19"));
      driver.completeHumanWait(worker, taskId, "account-review", Map.of("approved", true));
      TaskDetail task = driver.finish(worker, taskId);
      assertEquals(TaskState.SUCCEEDED, task.state());
      assertEquals(1, task.currentAttempt());
      assertEquals(List.of("acct-19"), activated);
    }
  }

  @Test
  void aRejectionDoesNotActivateTheAccount() throws Exception {
    List<String> activated = new CopyOnWriteArrayList<>();
    try (Worker worker =
        new HumanWaitsExamples(activated::add).register(driver.builder(dataSource)).build()) {
      UUID taskId = driver.enqueue("account.activate", Map.of("accountId", "acct-19"));
      driver.completeHumanWait(worker, taskId, "account-review", Map.of("approved", false));
      assertEquals(TaskState.SUCCEEDED, driver.finish(worker, taskId).state());
      assertEquals(List.of(), activated);
    }
  }
}
