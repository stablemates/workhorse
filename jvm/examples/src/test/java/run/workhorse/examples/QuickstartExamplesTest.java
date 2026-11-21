package run.workhorse.examples;

import static org.junit.jupiter.api.Assertions.assertEquals;

import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.extension.ExtendWith;
import run.workhorse.ConnectionSource;
import run.workhorse.Queue;
import run.workhorse.TaskDetail;
import run.workhorse.TaskState;
import run.workhorse.testing.ScratchDatabase;

/**
 * Runs the Java snippets of the site quickstart. Each test has its own database, because the worker
 * of the step 3 program claims every task of the queue {@code default}.
 */
@ExtendWith(ScratchDatabase.class)
@Timeout(value = 120, unit = TimeUnit.SECONDS)
class QuickstartExamplesTest {
  @Test
  void theProgramRunsTheWelcomeTask() throws Exception {
    try (IsolatedExampleDatabase database = IsolatedExampleDatabase.create("quickstart_java_run")) {
      String output = ExampleProgram.run(Quickstart.class.getName(), database.jdbcUrl());
      assertEquals("SUCCEEDED {deliveredTo=ada@example.com}\n", output);
      List<UUID> tasks = database.tasks("email.welcome", "to", "ada@example.com");
      assertEquals(1, tasks.size());
      TaskDetail task = database.detail(tasks.get(0));
      assertEquals(TaskState.SUCCEEDED, task.state());
      assertEquals(Map.of("deliveredTo", "ada@example.com"), task.result());
    }
  }

  @Test
  void theOrderAndItsTaskCommitTogether() throws Exception {
    try (IsolatedExampleDatabase database =
        IsolatedExampleDatabase.create("quickstart_java_order")) {
      String orderId = "java-" + UUID.randomUUID();
      Queue queue = new Queue(ConnectionSource.of(database.dataSource()));
      QuickstartExamples.createOrder(database.dataSource(), queue, orderId);
      assertEquals(1, database.orders(orderId));
      assertEquals(1, database.orderTasks("order.fulfill", orderId));
    }
  }
}
