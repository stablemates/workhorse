package run.workhorse.examples;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import javax.sql.DataSource;
import org.jspecify.annotations.Nullable;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.extension.ExtendWith;
import run.workhorse.CancelResult;
import run.workhorse.CancelStatus;
import run.workhorse.ConnectionSource;
import run.workhorse.EnqueueOptions;
import run.workhorse.Queue;
import run.workhorse.TaskState;
import run.workhorse.Worker;
import run.workhorse.testing.ScratchDatabase;

/** Runs the Java snippets of the site page about cancellation. */
@ExtendWith(ScratchDatabase.class)
@Timeout(value = 120, unit = TimeUnit.SECONDS)
class CancellationExamplesTest {
  private final DataSource dataSource = ExampleDatabase.dataSource();
  private final Queue queue = new Queue(ConnectionSource.of(dataSource));
  private final List<@Nullable Object> uploaded = Collections.synchronizedList(new ArrayList<>());
  private final CountDownLatch started = new CountDownLatch(1);
  private final CancellationExamples examples =
      new CancellationExamples(
          queue,
          dataSource,
          (part, cancellation) -> {
            uploaded.add(part);
            started.countDown();
            // The first part is slow: it ends only when the cancellation reaches the handler.
            cancellation.await(ExampleDatabase.WAIT);
          });

  @Test
  void aScheduledTaskIsCanceledAtOnce() {
    UUID taskId =
        queue
            .enqueue(
                "order.upload",
                Map.of("parts", List.of("part-1")),
                EnqueueOptions.builder()
                    .queue("uploads-" + UUID.randomUUID())
                    .runAt(Instant.now().plus(10, ChronoUnit.MINUTES))
                    .build())
            .taskId();
    CancelResult result =
        examples.cancelBeforeStart(taskId, new CancellationActor("dana@example.com"));
    assertEquals(CancelStatus.CANCELED, result.status());
    assertEquals("dana@example.com", result.requestedBy());
    assertEquals("customer withdrew the order", result.reason());
    assertEquals(TaskState.CANCELED, ExampleDatabase.detail(taskId).state());
  }

  @Test
  void theHandlerStopsBeforeTheNextPart() throws InterruptedException {
    String queueName = "uploads-" + UUID.randomUUID();
    UUID taskId =
        queue
            .enqueue(
                "order.upload",
                Map.of("parts", List.of("part-1", "part-2", "part-3")),
                EnqueueOptions.builder().queue(queueName).build())
            .taskId();
    try (Worker worker = examples.uploadWorker(queueName)) {
      worker.start();
      assertTrue(started.await(ExampleDatabase.WAIT.toMillis(), TimeUnit.MILLISECONDS));
      assertEquals(
          CancelStatus.CANCEL_REQUESTED,
          queue.cancel(taskId, "dana@example.com", "customer withdrew the order").status());
      assertEquals(TaskState.CANCELED, ExampleDatabase.awaitTerminal(taskId).state());
    }
    assertEquals(List.of("part-1"), uploaded);
  }
}
