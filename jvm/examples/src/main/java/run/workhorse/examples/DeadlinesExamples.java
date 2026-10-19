package run.workhorse.examples;

import java.time.Duration;
import java.time.Instant;
import java.util.Map;
import run.workhorse.EnqueueOptions;
import run.workhorse.Queue;

/** The Java tabs of the site page about deadlines and execution timeouts. */
public final class DeadlinesExamples {
  private final Queue queue;

  /** The snippets run on this queue. */
  public DeadlinesExamples(Queue queue) {
    this.queue = queue;
  }

  void deadline(String quoteId, Instant quoteExpiresAt) {
    // docs:start java-deadlines-deadline
    queue.enqueue(
        "price.quote",
        Map.of("quoteId", quoteId),
        EnqueueOptions.builder().deadline(quoteExpiresAt).build());
    // docs:end
  }

  void executionTimeout(String reportId, Duration attemptTimeout, int attemptBudget) {
    // docs:start java-deadlines-execution-timeout
    queue.enqueue(
        "report.build",
        Map.of("reportId", reportId),
        EnqueueOptions.builder()
            .executionTimeout(attemptTimeout)
            .maxAttempts(attemptBudget)
            .build());
    // docs:end
  }
}
