package run.workhorse.examples;

import java.util.Map;
import run.workhorse.Queue;
import run.workhorse.QueueHealth;

/** The Java tabs of the site page about queue health. */
public final class QueueHealthExamples {
  private final Queue queue;

  /** The snippets run on this queue. */
  public QueueHealthExamples(Queue queue) {
    this.queue = queue;
  }

  QueueHealth checkHealth() {
    // docs:start java-queue-health-verdict
    QueueHealth health = queue.health();
    if (health.snapshot().get("status") instanceof Map<?, ?> status
        && !"healthy".equals(status.get("level"))) {
      System.err.println(status.get("reasons"));
    }
    // docs:end
    return health;
  }
}
