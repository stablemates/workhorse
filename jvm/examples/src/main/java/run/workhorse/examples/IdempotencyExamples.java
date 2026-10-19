package run.workhorse.examples;

import java.time.Duration;
import java.util.Map;
import java.util.UUID;
import run.workhorse.EnqueueOptions;
import run.workhorse.EnqueueResult;
import run.workhorse.Idempotency;
import run.workhorse.Queue;

/** The Java tabs of the site page about enqueue idempotency. */
public final class IdempotencyExamples {
  private final Queue queue;

  /** The snippets run on this queue. */
  public IdempotencyExamples(Queue queue) {
    this.queue = queue;
  }

  UUID enqueueOnce(String invoiceId) {
    // docs:start java-idempotency-enqueue
    UUID taskId =
        queue
            .enqueue(
                "invoice.capture",
                Map.of("invoiceId", invoiceId),
                EnqueueOptions.builder()
                    .queue("billing")
                    .idempotency(
                        new Idempotency(
                            "capture:" + invoiceId, "invoice-capture", Duration.ofDays(1)))
                    .build())
            .taskId();
    // docs:end
    return taskId;
  }

  EnqueueResult enqueueWithResult(String invoiceId, String key) {
    // docs:start java-idempotency-outcome
    EnqueueResult result =
        queue.enqueue(
            "invoice.capture",
            Map.of("invoiceId", invoiceId),
            EnqueueOptions.builder()
                .idempotency(new Idempotency(key, "invoice-capture", Duration.ofDays(1)))
                .build());
    // docs:end
    return result;
  }
}
