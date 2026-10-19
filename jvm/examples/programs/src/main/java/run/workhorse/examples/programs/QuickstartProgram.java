package run.workhorse.examples.programs;

import java.util.Locale;
import java.util.Map;
import java.util.UUID;
import org.postgresql.ds.PGSimpleDataSource;
import run.workhorse.Admin;
import run.workhorse.ConnectionSource;
import run.workhorse.JsonCodec;
import run.workhorse.Queue;
import run.workhorse.TaskDetail;
import run.workhorse.Worker;

/**
 * Enqueues one task, runs the worker once, and prints the task's outcome.
 *
 * <p>Documentation: https://workhorse.run/docs/quickstart
 */
public final class QuickstartProgram {
  private QuickstartProgram() {}

  public static void main(String[] arguments) {
    PGSimpleDataSource dataSource = Programs.dataSource("WORKHORSE_DATABASE_URL");
    Queue queue = new Queue(ConnectionSource.of(dataSource));
    UUID taskId = queue.enqueue("email.welcome", Map.of("to", "ada@example.com")).taskId();

    try (Worker worker =
        Worker.builder(dataSource)
            .handle(
                "email.welcome",
                Map.class,
                (context, payload) -> Map.of("deliveredTo", String.valueOf(payload.get("to"))))
            .build()) {
      worker.runOnce(); // production uses WorkerProcess.runWorkerProcess(worker)
    }

    TaskDetail task = new Admin(ConnectionSource.of(dataSource)).getTask(taskId).orElseThrow();
    System.out.println(
        task.state().name().toLowerCase(Locale.ROOT)
            + " "
            + JsonCodec.standard().encode(task.result()));
  }
}
