package run.workhorse.examples;

import static org.junit.jupiter.api.Assertions.assertEquals;

import java.sql.SQLException;
import java.util.UUID;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.extension.ExtendWith;
import run.workhorse.ConnectionSource;
import run.workhorse.Queue;
import run.workhorse.TaskDetail;
import run.workhorse.testing.ScratchDatabase;

/** Runs the Java snippet of the site page about priority. */
@ExtendWith(ScratchDatabase.class)
@Timeout(value = 120, unit = TimeUnit.SECONDS)
class PriorityExamplesTest {
  private final Queue queue = new Queue(ConnectionSource.of(ExampleDatabase.dataSource()));

  @Test
  void thePriorityReachesTheTask() throws SQLException {
    String invoiceId = "java-" + UUID.randomUUID();
    new PriorityExamples(queue).enqueueUrgent(invoiceId);
    TaskDetail task = ExampleDatabase.task("invoice.remind", "invoiceId", invoiceId);
    assertEquals("billing", task.queue());
    assertEquals(10, task.priority());
  }
}
