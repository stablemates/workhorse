package run.workhorse.examples;

import java.util.Map;
import run.workhorse.EnqueueOptions;
import run.workhorse.Queue;

/** The Java tabs of the site page about retries. */
public final class RetriesExamples {
  private final Queue queue;

  /** The snippets run on this queue. */
  public RetriesExamples(Queue queue) {
    this.queue = queue;
  }

  void attemptBudget(String accountId) {
    // docs:start java-retries-attempt-budget
    queue.enqueue(
        "provider.sync",
        Map.of("accountId", accountId),
        EnqueueOptions.builder().maxAttempts(5).build());
    // docs:end
  }

  void retryPolicy(String accountId) {
    // docs:start java-retries-retry-policy
    Map<String, Object> jitter =
        Map.of("type", "decorrelated-jitter", "baseDelayMs", 1_000, "maxDelayMs", 60_000);
    queue.enqueue(
        "provider.sync",
        Map.of("accountId", accountId),
        EnqueueOptions.builder().retryPolicy(jitter).maxAttempts(5).build());
    // docs:end
  }
}
