package run.workhorse.examples;

import java.time.Duration;
import java.util.Map;
import run.workhorse.EnqueueOptions;
import run.workhorse.EnqueueResult;
import run.workhorse.Queue;
import run.workhorse.Throttle;

/** The Java tabs of the site page about throttle. */
public final class ThrottleExamples {
  private final Queue queue;

  /** The snippets run on this queue. */
  public ThrottleExamples(Queue queue) {
    this.queue = queue;
  }

  EnqueueResult throttle(String accountId, Duration digestWindow) {
    // docs:start java-throttle-enqueue
    EnqueueResult result =
        queue.enqueue(
            "email.digest",
            Map.of("accountId", accountId),
            EnqueueOptions.builder()
                .throttle(new Throttle(accountId, digestWindow, "digest"))
                .build());
    // docs:end
    return result;
  }
}
