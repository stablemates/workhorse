package run.workhorse.examples;

import java.util.Map;
import org.postgresql.ds.PGSimpleDataSource;
import run.workhorse.ConnectionSource;
import run.workhorse.EnqueueResult;
import run.workhorse.Queue;
import run.workhorse.QueueOptions;
import run.workhorse.Worker;

/**
 * The Java snippet of {@code jvm/README.md}, an excerpt of {@code jvm/release-consumer/java}. The
 * build does not format this file, so the region keeps the layout of the release consumer.
 */
public final class ReadmeExample {
  static final String QUEUE = "readme-java";
  static final String TASK_TYPE = "readme.java";

  private ReadmeExample() {}

  /** Enqueues one task and runs it. {@code args[0]} is a PostgreSQL JDBC URL. */
  public static EnqueueResult run(String[] args) {
    // docs:start java-readme-run-one-task
    PGSimpleDataSource dataSource = new PGSimpleDataSource();
    dataSource.setURL(args[0]);
    Queue queue =
        new Queue(ConnectionSource.of(dataSource), QueueOptions.builder().defaultQueue(QUEUE).build());
    EnqueueResult enqueued = queue.enqueue(TASK_TYPE, Map.of("packaged", true));

    try (Worker worker =
        Worker.builder(dataSource)
            .queues(QUEUE)
            .disableRegistry(true)
            .handle(TASK_TYPE, Map.class, (context, payload) -> Map.of("echo", payload))
            .build()) {
      if (!worker.runOnce()) throw new IllegalStateException("the worker ran no handler");
    }
    // docs:end
    return enqueued;
  }
}
