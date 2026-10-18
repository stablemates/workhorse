package run.workhorse.examples;

import java.time.Duration;
import java.util.List;
import java.util.Map;
import javax.sql.DataSource;
import run.workhorse.BatchFailed;
import run.workhorse.BatchHandlerItem;
import run.workhorse.BatchHandlerOutcome;
import run.workhorse.BatchOptions;
import run.workhorse.BatchSucceeded;
import run.workhorse.Queue;
import run.workhorse.Worker;

/** The Java tabs of the site page about batch handlers. */
public final class BatchHandlersExamples {
  private final DataSource dataSource;
  private final Queue queue;
  private final BatchEmailProvider emailProvider;

  /** The snippets enqueue on this queue, and their worker sends to this provider. */
  public BatchHandlersExamples(
      DataSource dataSource, Queue queue, BatchEmailProvider emailProvider) {
    this.dataSource = dataSource;
    this.queue = queue;
    this.emailProvider = emailProvider;
  }

  /** Builds a worker with a batch handler for {@code email.send}, and does not run it. */
  public Worker batchWorker() {
    // docs:start java-batch-handlers-handle-batch
    Worker worker =
        Worker.builder(dataSource)
            .queues("email")
            .concurrency(32)
            .handleBatch(
                "email.send",
                Object.class,
                new BatchOptions(20, Duration.ofMillis(50)),
                items -> {
                  List<BatchDelivery> deliveries =
                      emailProvider.sendMany(
                          items.stream().map(BatchHandlerItem::payload).toList());
                  return deliveries.stream()
                      .<BatchHandlerOutcome>map(
                          delivery -> {
                            Exception error = delivery.error();
                            return error != null
                                ? new BatchFailed(error)
                                : new BatchSucceeded(Map.of("providerId", delivery.id()));
                          })
                      .toList();
                })
            .build();
    // docs:end
    return worker;
  }

  /** Enqueues one ordinary task for the batch handler. */
  public void enqueueEmail() {
    // docs:start java-batch-handlers-enqueue
    queue.enqueue("email.send", Map.of("to", "person@example.com"));
    // docs:end
  }
}
