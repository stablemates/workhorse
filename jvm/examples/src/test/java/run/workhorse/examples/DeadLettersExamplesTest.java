package run.workhorse.examples;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.sql.SQLException;
import java.util.Map;
import java.util.Objects;
import java.util.UUID;
import java.util.concurrent.TimeUnit;
import javax.sql.DataSource;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.extension.ExtendWith;
import run.workhorse.Admin;
import run.workhorse.AdminAudit;
import run.workhorse.BulkRedrivePage;
import run.workhorse.DeadLetter;
import run.workhorse.DeadLetterPage;
import run.workhorse.EnqueueOptions;
import run.workhorse.Queue;
import run.workhorse.RedriveResult;
import run.workhorse.RedriveStatus;
import run.workhorse.TaskDetail;
import run.workhorse.TaskState;
import run.workhorse.Worker;
import run.workhorse.testing.ScratchDatabase;

/** Runs the Java snippets of the site page about dead letters and redrive. */
@ExtendWith(ScratchDatabase.class)
@Timeout(value = 120, unit = TimeUnit.SECONDS)
class DeadLettersExamplesTest {
  // The worker reads `payments`, and each redrive leaves a ready copy there, so each test has its
  // own database.
  private final IsolatedExampleDatabase database;
  private final DataSource dataSource;
  private final Queue queue;
  private final Admin admin;
  private final DeadLettersExamples examples;

  DeadLettersExamplesTest() throws Exception {
    database = IsolatedExampleDatabase.create("dead-letters-java");
    dataSource = database.dataSource();
    queue = database.queue();
    admin = database.admin();
    examples = new DeadLettersExamples(admin);
  }

  @AfterEach
  void dropDatabase() throws SQLException {
    database.close();
  }

  @Test
  void theListHoldsTheFailedCharge() throws InterruptedException {
    UUID taskId = failedCharge();
    DeadLetterPage page = examples.listFailures();
    DeadLetter letter =
        page.items().stream()
            .filter(item -> item.taskId().equals(taskId))
            .findFirst()
            .orElseThrow();
    assertEquals("payments", letter.queue());
    assertEquals(
        "ProviderTimeout", ((Map<?, ?>) Objects.requireNonNull(letter.error())).get("name"));
  }

  @Test
  void theRedriveCreatesANewReadyTaskAndReplaysTheSameRequest() throws InterruptedException {
    UUID sourceTaskId = failedCharge();
    RedriveResult result = examples.redriveOne(sourceTaskId);
    assertEquals(RedriveStatus.REDRIVEN, result.status());
    assertEquals(TaskState.FAILED, result.sourceState());
    assertEquals(TaskState.READY, result.targetState());
    UUID target = Objects.requireNonNull(result.targetTaskId());
    TaskDetail copy = database.detail(target);
    assertEquals("payments", copy.queue());
    assertEquals("payment.charge", copy.type());
    RedriveResult replay = examples.redriveOne(sourceTaskId);
    assertEquals(RedriveStatus.REPLAYED, replay.status());
    assertEquals(target, replay.targetTaskId());
  }

  @Test
  void theBacklogRedrivesEveryPageAfterTheDryRun() throws InterruptedException {
    UUID first = failedCharge();
    UUID second = failedCharge();
    BulkRedrivePage preview = examples.redriveBacklog();
    for (UUID source : new UUID[] {first, second}) {
      assertTrue(
          preview.results().stream()
              .anyMatch(
                  item ->
                      item.sourceTaskId().equals(source)
                          && item.status() == RedriveStatus.ELIGIBLE),
          "the dry run lists " + source);
      // The loop redrove the source with this request, so the same request only replays it.
      RedriveResult replay =
          admin.redrive(
              source, new AdminAudit("ops@example.com", "Provider outage ended", "outage-0314"));
      assertEquals(RedriveStatus.REPLAYED, replay.status());
      assertNotNull(replay.targetTaskId());
    }
  }

  /** Runs one {@code payment.charge} task on {@code payments} that fails with ProviderTimeout. */
  private UUID failedCharge() throws InterruptedException {
    UUID taskId =
        queue
            .enqueue(
                "payment.charge",
                Map.of("chargeId", "java-" + UUID.randomUUID()),
                EnqueueOptions.builder().queue("payments").maxAttempts(1).build())
            .taskId();
    try (Worker worker =
        Worker.builder(dataSource)
            .queues("payments")
            .handle(
                "payment.charge",
                Map.class,
                (context, payload) -> {
                  throw new ProviderTimeout();
                })
            .build()) {
      worker.runOnce();
    }
    assertEquals(TaskState.FAILED, database.awaitTerminal(taskId).state());
    return taskId;
  }

  /** The error of the payment provider in the outage. */
  static final class ProviderTimeout extends RuntimeException {
    private static final long serialVersionUID = 1L;

    ProviderTimeout() {
      super("the payment provider did not answer");
    }
  }
}
