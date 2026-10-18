package run.workhorse.examples;

import static org.junit.jupiter.api.Assertions.assertEquals;

import java.sql.SQLException;
import java.time.Duration;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.UUID;
import java.util.concurrent.TimeUnit;
import javax.sql.DataSource;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.extension.ExtendWith;
import run.workhorse.ConnectionSource;
import run.workhorse.Queue;
import run.workhorse.TaskDetail;
import run.workhorse.testing.ScratchDatabase;

/** Runs the Java snippets of the site page about deadlines and execution timeouts. */
@ExtendWith(ScratchDatabase.class)
@Timeout(value = 120, unit = TimeUnit.SECONDS)
class DeadlinesExamplesTest {
  private final DataSource dataSource = ExampleDatabase.dataSource();
  private final DeadlinesExamples examples =
      new DeadlinesExamples(new Queue(ConnectionSource.of(dataSource)));

  @Test
  void theDeadlineReachesTheTask() throws SQLException {
    String quoteId = "java-" + UUID.randomUUID();
    Instant quoteExpiresAt =
        Instant.now().plus(1, ChronoUnit.HOURS).truncatedTo(ChronoUnit.SECONDS);
    examples.deadline(quoteId, quoteExpiresAt);
    assertEquals(
        quoteExpiresAt, ExampleDatabase.task("price.quote", "quoteId", quoteId).deadlineAt());
  }

  @Test
  void theExecutionTimeoutAndTheBudgetReachTheTask() throws SQLException {
    String reportId = "java-" + UUID.randomUUID();
    examples.executionTimeout(reportId, Duration.ofMinutes(2), 3);
    TaskDetail task = ExampleDatabase.task("report.build", "reportId", reportId);
    assertEquals(Duration.ofMinutes(2), task.executionTimeout());
    assertEquals(3, task.maxAttempts());
  }
}
