package run.workhorse.examples;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.extension.ExtendWith;
import run.workhorse.EnqueueOptions;
import run.workhorse.Queue;
import run.workhorse.TaskDetail;
import run.workhorse.TaskState;
import run.workhorse.Worker;
import run.workhorse.testing.ScratchDatabase;

/** Runs the Java snippets of the site page about batch handlers under a real worker. */
@ExtendWith(ScratchDatabase.class)
// Each test creates and drops its own database, which is slow on a loaded host.
@Timeout(value = 240, unit = TimeUnit.SECONDS)
class BatchHandlersExamplesTest {
  private final List<Integer> requests = new CopyOnWriteArrayList<>();
  private final BatchEmailProvider emailProvider =
      emails -> {
        requests.add(emails.size());
        List<BatchDelivery> deliveries = new ArrayList<>();
        for (Object email : emails) {
          String to = String.valueOf(((Map<?, ?>) email).get("to"));
          deliveries.add(
              to.startsWith("bounce")
                  ? new BatchDelivery(to, new IllegalStateException("the mailbox is full"))
                  : new BatchDelivery("msg-" + to, null));
        }
        return deliveries;
      };

  @Test
  void theBatchHandlerSendsTwentySevenTasksInBatchesOfAtMostTwenty() throws Exception {
    // The worker reads `email`, which other snippet tests also use, so the test has its own
    // database. The batch sizes then count only the tasks of this test.
    try (IsolatedExampleDatabase database = IsolatedExampleDatabase.create("batch-handlers-java")) {
      Queue isolated = database.queue();
      String run = UUID.randomUUID().toString();
      List<UUID> tasks = new ArrayList<>();
      EnqueueOptions email = EnqueueOptions.builder().queue("email").maxAttempts(1).build();
      for (int index = 0; index < 27; index++) {
        String to = (index == 0 ? "bounce-" : "user-") + index + "-" + run + "@example.com";
        tasks.add(isolated.enqueue("email.send", Map.of("to", to), email).taskId());
      }
      try (Worker worker =
          new BatchHandlersExamples(database.dataSource(), isolated, emailProvider).batchWorker()) {
        worker.start();
        for (int index = 0; index < tasks.size(); index++) {
          TaskDetail task = database.awaitTerminal(tasks.get(index));
          if (index == 0) {
            assertEquals(TaskState.FAILED, task.state());
          } else {
            assertEquals(TaskState.SUCCEEDED, task.state());
            assertEquals(
                Map.of("providerId", "msg-user-" + index + "-" + run + "@example.com"),
                task.result());
          }
        }
      }
    }
    // A slow claim can split the tasks into more batches, so the test checks the bounds.
    assertEquals(27, requests.stream().mapToInt(Integer::intValue).sum());
    assertTrue(requests.size() >= 2, "requests: " + requests);
    assertTrue(requests.stream().allMatch(size -> size <= 20), "requests: " + requests);
  }

  @Test
  void theWorkerOfThePageClaimsTheTaskOfTheProducer() throws Exception {
    // The worker reads only `email`, so the producer must enqueue there. The test has its own
    // database, because other snippet tests also use `email`.
    try (IsolatedExampleDatabase database =
        IsolatedExampleDatabase.create("batch-handlers-producer-java")) {
      BatchHandlersExamples isolated =
          new BatchHandlersExamples(database.dataSource(), database.queue(), emailProvider);
      isolated.enqueueEmail();
      List<UUID> tasks = database.tasks("email.send", "to", "person@example.com");
      assertEquals(1, tasks.size());
      try (Worker worker = isolated.batchWorker()) {
        worker.start();
        TaskDetail task = database.awaitTerminal(tasks.getFirst());
        assertEquals(TaskState.SUCCEEDED, task.state());
        assertEquals(Map.of("providerId", "msg-person@example.com"), task.result());
      }
    }
  }
}
