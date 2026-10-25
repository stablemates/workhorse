package run.workhorse.examples;

import static org.junit.jupiter.api.Assertions.assertEquals;

import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import javax.sql.DataSource;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.extension.ExtendWith;
import run.workhorse.ConcurrencyPolicy;
import run.workhorse.ConnectionSource;
import run.workhorse.Queue;
import run.workhorse.TaskDetail;
import run.workhorse.TaskState;
import run.workhorse.Worker;
import run.workhorse.testing.ScratchDatabase;

/** Runs the Java onboarding of the site page "What is Workhorse?". */
@ExtendWith(ScratchDatabase.class)
@Timeout(value = 120, unit = TimeUnit.SECONDS)
class OverviewExamplesTest {
  private final DataSource dataSource = ExampleDatabase.dataSource();
  private final Queue queue = new Queue(ConnectionSource.of(dataSource));
  private final DurableFlowDriver driver = new DurableFlowDriver(dataSource);
  private final List<String> calls = new CopyOnWriteArrayList<>();
  private final AtomicInteger welcomes = new AtomicInteger();

  @Test
  void theOnboardingWaitsForTheEmailAndCreatesOneWorkspace() throws Exception {
    String enqueued = "java-" + UUID.randomUUID();
    OverviewExamples examples =
        new OverviewExamples(
            (accountId, idempotencyKey) -> {
              calls.add("workspace " + accountId + " " + idempotencyKey);
              return Map.of("id", "ws-" + accountId);
            },
            (email, workspace) -> {
              calls.add("welcome " + email);
              if (welcomes.incrementAndGet() == 1) {
                throw new IllegalStateException("the mail service is not available");
              }
              return Map.of("sent", true);
            });
    try (Worker worker =
        examples
            .onboard(queue, driver.builder(dataSource), enqueued, "ada@example.com", "tenant-42")
            .build()) {
      ConcurrencyPolicy policy = queue.listConcurrencyPolicies(List.of("onboarding")).get(0);
      assertEquals("accounts", policy.namespace());
      assertEquals(3, policy.maxActivePerKey());
      TaskDetail stored = ExampleDatabase.task("account.onboard", "accountId", enqueued);
      assertEquals("onboarding", stored.queue());
      assertEquals("tenant-42", stored.concurrencyKey());

      UUID taskId =
          driver.enqueue(
              "account.onboard", Map.of("accountId", "acct-9", "email", "ada@example.com"));
      driver.deliverSignal(worker, taskId, "email-verified", Map.of("verified", true));
      TaskDetail task = driver.finish(worker, taskId);
      assertEquals(TaskState.SUCCEEDED, task.state());
      assertEquals(2, task.currentAttempt(), "the first welcome email failed");
      assertEquals(
          List.of(
              "workspace acct-9 workspace:acct-9",
              "welcome ada@example.com",
              "welcome ada@example.com"),
          calls);
      assertEquals(Map.of("id", "ws-acct-9"), task.result());
    }
  }
}
