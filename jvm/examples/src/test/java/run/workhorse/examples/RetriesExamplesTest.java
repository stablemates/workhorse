package run.workhorse.examples;

import static org.junit.jupiter.api.Assertions.assertEquals;

import java.sql.SQLException;
import java.util.Map;
import java.util.Objects;
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

/** Runs the Java snippets of the site page about retries. */
@ExtendWith(ScratchDatabase.class)
@Timeout(value = 120, unit = TimeUnit.SECONDS)
class RetriesExamplesTest {
  private final DataSource dataSource = ExampleDatabase.dataSource();
  private final RetriesExamples examples =
      new RetriesExamples(new Queue(ConnectionSource.of(dataSource)));

  @Test
  void theAttemptBudgetReachesTheTask() throws SQLException {
    String accountId = "java-" + UUID.randomUUID();
    examples.attemptBudget(accountId);
    assertEquals(5, ExampleDatabase.task("provider.sync", "accountId", accountId).maxAttempts());
  }

  @Test
  void theRetryPolicyReachesTheTask() throws SQLException {
    String accountId = "java-" + UUID.randomUUID();
    examples.retryPolicy(accountId);
    TaskDetail task = ExampleDatabase.task("provider.sync", "accountId", accountId);
    assertEquals(5, task.maxAttempts());
    Map<String, ?> policy = Objects.requireNonNull(task.retryPolicy());
    assertEquals("decorrelated-jitter", policy.get("type"));
    assertEquals(1_000L, ((Number) Objects.requireNonNull(policy.get("baseDelayMs"))).longValue());
    assertEquals(60_000L, ((Number) Objects.requireNonNull(policy.get("maxDelayMs"))).longValue());
  }
}
