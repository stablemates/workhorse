package run.workhorse.examples;

import java.util.Map;
import run.workhorse.EnqueueOptions;
import run.workhorse.Queue;

/** The Java tab of the site page about priority. */
public final class PriorityExamples {
  private final Queue queue;

  /** The snippet runs on this queue. */
  public PriorityExamples(Queue queue) {
    this.queue = queue;
  }

  void enqueueUrgent(String invoiceId) {
    // docs:start java-priority-enqueue
    queue.enqueue(
        "invoice.remind",
        Map.of("invoiceId", invoiceId),
        EnqueueOptions.builder().queue("billing").priority(10).build());
    // docs:end
  }
}
