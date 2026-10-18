package run.workhorse.examples;

import static org.junit.jupiter.api.Assertions.assertEquals;

import java.sql.SQLException;
import java.util.UUID;
import java.util.concurrent.TimeUnit;
import javax.sql.DataSource;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.extension.ExtendWith;
import run.workhorse.ConnectionSource;
import run.workhorse.EnqueueOutcome;
import run.workhorse.EnqueueResult;
import run.workhorse.Queue;
import run.workhorse.testing.ScratchDatabase;

/** Runs the Java snippets of the site page about enqueue idempotency. */
@ExtendWith(ScratchDatabase.class)
@Timeout(value = 120, unit = TimeUnit.SECONDS)
class IdempotencyExamplesTest {
  private final DataSource dataSource = ExampleDatabase.dataSource();
  private final IdempotencyExamples examples =
      new IdempotencyExamples(new Queue(ConnectionSource.of(dataSource)));

  @Test
  void aSecondRequestWithTheSameKeyReturnsTheSameTask() throws SQLException {
    String invoiceId = "java-" + UUID.randomUUID();
    UUID first = examples.enqueueOnce(invoiceId);
    UUID second = examples.enqueueOnce(invoiceId);
    assertEquals(first, second);
    assertEquals(first, ExampleDatabase.task("invoice.capture", "invoiceId", invoiceId).id());
    assertEquals("billing", ExampleDatabase.detail(first).queue());
  }

  @Test
  void theResultSaysIfTheRequestWasADuplicate() {
    String invoiceId = "java-" + UUID.randomUUID();
    String key = "capture:" + invoiceId;
    EnqueueResult first = examples.enqueueWithResult(invoiceId, key);
    EnqueueResult second = examples.enqueueWithResult(invoiceId, key);
    assertEquals(EnqueueOutcome.ACCEPTED, first.outcome());
    assertEquals(EnqueueOutcome.REPLAYED, second.outcome());
    assertEquals(first.taskId(), second.taskId());
  }
}
