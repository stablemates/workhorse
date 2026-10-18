package run.workhorse.examples;

import static org.junit.jupiter.api.Assertions.assertEquals;

import java.sql.SQLException;
import java.time.Duration;
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

/** Runs the Java snippets of the site page about throttle. */
@ExtendWith(ScratchDatabase.class)
@Timeout(value = 120, unit = TimeUnit.SECONDS)
class ThrottleExamplesTest {
  private final DataSource dataSource = ExampleDatabase.dataSource();
  private final ThrottleExamples examples =
      new ThrottleExamples(new Queue(ConnectionSource.of(dataSource)));

  @Test
  void aSecondRequestInTheWindowIsCoalesced() throws SQLException {
    String accountId = "java-" + UUID.randomUUID();
    EnqueueResult first = examples.throttle(accountId, Duration.ofMinutes(10));
    EnqueueResult second = examples.throttle(accountId, Duration.ofMinutes(10));
    assertEquals(EnqueueOutcome.ACCEPTED, first.outcome());
    assertEquals(EnqueueOutcome.COALESCED, second.outcome());
    assertEquals(first.taskId(), second.taskId());
    assertEquals(first.taskId(), ExampleDatabase.task("email.digest", "accountId", accountId).id());
  }
}
