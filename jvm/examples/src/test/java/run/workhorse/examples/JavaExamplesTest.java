package run.workhorse.examples;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;

import java.sql.Connection;
import java.sql.SQLException;
import java.time.Duration;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.TimeUnit;
import javax.sql.DataSource;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.extension.ExtendWith;
import run.workhorse.Admin;
import run.workhorse.ConnectionSource;
import run.workhorse.EnqueueResult;
import run.workhorse.Queue;
import run.workhorse.TaskDetail;
import run.workhorse.TaskState;
import run.workhorse.Worker;
import run.workhorse.testing.ScratchDatabase;

/** Runs each Java snippet that needs no Spring context, no servlet container, and no child JVM. */
@ExtendWith(ScratchDatabase.class)
@Timeout(value = 120, unit = TimeUnit.SECONDS)
class JavaExamplesTest {
  private final DataSource dataSource = ExampleDatabase.dataSource();
  private final Queue queue = new Queue(ConnectionSource.of(dataSource));

  @BeforeAll
  static void accountTable() throws SQLException {
    ExampleDatabase.createAccountTable();
  }

  @Test
  void theJdbcTransactionCommitsTheAccountAndTheTaskTogether() throws SQLException {
    String id = "java-" + UUID.randomUUID();
    new JdbcTransaction(dataSource, queue).createAccount(id, "person@example.com");
    assertEquals(1, ExampleDatabase.accounts(id));
    assertEquals(1, ExampleDatabase.tasks("account.created", "accountId", id).size());
  }

  @Test
  void theJdbcTransactionRollsBackTheTaskWithTheAccount() throws SQLException {
    String id = "java-" + UUID.randomUUID();
    // The commit fails after the insert and the enqueue ran on the connection.
    JdbcTransaction example = new JdbcTransaction(new FailingCommitDataSource(), queue);
    assertThrows(SQLException.class, () -> example.createAccount(id, "person@example.com"));
    assertEquals(0, ExampleDatabase.accounts(id));
    assertEquals(0, ExampleDatabase.tasks("account.created", "accountId", id).size());
  }

  @Test
  void theShortTransactionFormCommitsOnTheCallersConnection() throws SQLException {
    String id = "java-" + UUID.randomUUID();
    try (Connection connection = dataSource.getConnection()) {
      new JdbcTransaction(dataSource, queue)
          .enqueueInTransaction(connection, id, "person@example.com");
    }
    assertEquals(1, ExampleDatabase.accounts(id));
    assertEquals(1, ExampleDatabase.tasks("account.created", "accountId", id).size());
  }

  @Test
  void anEnqueueWithARunTimeIsScheduledOnItsQueue() throws SQLException {
    String invoiceId = "java-" + UUID.randomUUID();
    examples().enqueueNowOrLater(invoiceId, Instant.now().plus(3, ChronoUnit.DAYS));
    TaskDetail reminder = ExampleDatabase.task("invoice.remind", "invoiceId", invoiceId);
    assertEquals("billing", reminder.queue());
    assertEquals(TaskState.SCHEDULED, reminder.state());
    assertFalse(ExampleDatabase.tasks("email.send", "to", "person@example.com").isEmpty());
  }

  @Test
  void theEnqueueOptionsReachTheTask() throws SQLException {
    Instant endOfMonth = Instant.now().plus(30, ChronoUnit.DAYS).truncatedTo(ChronoUnit.SECONDS);
    examples().enqueueWithOptions(endOfMonth);
    TaskDetail report =
        ExampleDatabase.detail(
            ExampleDatabase.tasks("report.generate", "month", "2026-08").getLast());
    assertEquals("reports", report.queue());
    assertEquals(List.of("tenant:acme"), report.tags());
    assertEquals("acme", report.concurrencyKey());
    assertEquals(10, report.priority());
    assertEquals(5, report.maxAttempts());
    assertEquals(endOfMonth, report.deadlineAt());
    assertEquals(Duration.ofMinutes(2), report.executionTimeout());
  }

  @Test
  void enqueueManyReturnsOneResultForEachRecipientInOrder() throws SQLException {
    String first = UUID.randomUUID() + "@example.com";
    String second = UUID.randomUUID() + "@example.com";
    List<EnqueueResult> results =
        examples().enqueueMany(List.of(new Recipient(first), new Recipient(second)));
    assertEquals(2, results.size());
    assertEquals(results.get(0).taskId(), ExampleDatabase.task("email.digest", "to", first).id());
    assertEquals(results.get(1).taskId(), ExampleDatabase.task("email.digest", "to", second).id());
    assertEquals("mail", ExampleDatabase.detail(results.get(0).taskId()).queue());
  }

  @Test
  void pauseAndResumeLeaveTheQueueRunning() {
    String requestId = "java-" + UUID.randomUUID();
    examples().pauseAndResume("dana", "maintenance", requestId, requestId + "-resume");
  }

  @Test
  void theSchemaCheckAcceptsTheInstalledSchema() {
    InstallationExample.check(dataSource);
  }

  @Test
  void theWorkerOptionsReachTheWorker() {
    try (Worker worker =
        new WorkerExamples(dataSource, ExampleProcess.mailer(), 3, Duration.ofSeconds(45))
            .withOptions()) {
      assertEquals("email-worker-1", worker.workerId());
      assertEquals(3, worker.concurrency());
      assertEquals(List.of("email", "billing"), worker.queues());
    }
  }

  @Test
  void theReadmeSnippetRunsOneTask() throws SQLException {
    EnqueueResult enqueued = ReadmeExample.run(new String[] {ExampleDatabase.jdbcUrl()});
    TaskDetail task = ExampleDatabase.detail(enqueued.taskId());
    assertEquals(TaskState.SUCCEEDED, task.state());
    assertEquals(Map.of("echo", Map.of("packaged", true)), task.result());
  }

  private EnqueueExamples examples() {
    return new EnqueueExamples(queue, new Admin(ConnectionSource.of(dataSource)));
  }
}
