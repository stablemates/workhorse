package consumer;

import dev.stablemates.workhorse.Admin;
import dev.stablemates.workhorse.ConnectionSource;
import dev.stablemates.workhorse.EnqueueResult;
import dev.stablemates.workhorse.Queue;
import dev.stablemates.workhorse.QueueOptions;
import dev.stablemates.workhorse.TaskDetail;
import dev.stablemates.workhorse.TaskState;
import dev.stablemates.workhorse.Worker;
import java.nio.file.Path;
import java.util.Map;
import org.postgresql.ds.PGSimpleDataSource;

/**
 * Without an argument, prints the file name of the jar that holds the core. With a PostgreSQL JDBC URL, enqueues one
 * task, runs it through a worker, checks its outcome, and prints the task id for the check to read
 * back.
 */
public final class Main {
  private static final String QUEUE = "release-consumer";
  private static final String TASK_TYPE = "release.consumer";

  public static void main(String[] args) {
    System.out.println(
        Path.of(Queue.class.getProtectionDomain().getCodeSource().getLocation().getPath())
            .getFileName());
    if (args.length == 0) return;

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
    TaskDetail task = new Admin(ConnectionSource.of(dataSource)).getTask(enqueued.taskId()).orElseThrow();
    if (task.state() != TaskState.SUCCEEDED
        || !Map.of("echo", Map.of("packaged", true)).equals(task.result())) {
      throw new IllegalStateException("task " + task.id() + " is " + task.state());
    }
    System.out.println(enqueued.taskId());
  }
}
