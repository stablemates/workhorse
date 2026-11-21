package run.workhorse.examples;

// The Java tab of step 3 of the site quickstart. The region is a whole program: a reader pastes it
// into Quickstart.java, and QuickstartExamplesTest runs its main method in a child JVM.

// docs:start java-quickstart-run-task
import java.util.Map;
import java.util.Objects;
import java.util.UUID;
import org.postgresql.ds.PGSimpleDataSource;
import run.workhorse.Admin;
import run.workhorse.ConnectionSource;
import run.workhorse.Queue;
import run.workhorse.TaskDetail;
import run.workhorse.Worker;

public final class Quickstart {
  public static void main(String[] args) {
    // A JDBC URL, such as jdbc:postgresql://localhost/app?user=app&password=secret
    String databaseUrl =
        Objects.requireNonNull(System.getenv("JDBC_DATABASE_URL"), "set JDBC_DATABASE_URL");
    PGSimpleDataSource dataSource = new PGSimpleDataSource();
    dataSource.setURL(databaseUrl);
    Queue queue = new Queue(ConnectionSource.of(dataSource));
    UUID taskId = queue.enqueue("email.welcome", Map.of("to", "ada@example.com")).taskId();

    try (Worker worker =
        Worker.builder(dataSource)
            .handle(
                "email.welcome",
                Map.class,
                (context, payload) -> Map.of("deliveredTo", String.valueOf(payload.get("to"))))
            .build()) {
      worker.runOnce(); // one claim-and-run pass; production uses WorkerProcess.runWorkerProcess
    }

    TaskDetail task = new Admin(ConnectionSource.of(dataSource)).getTask(taskId).orElseThrow();
    System.out.println(task.state() + " " + task.result());
  }
}
// docs:end
