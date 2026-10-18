package run.workhorse.examples;

import static org.junit.jupiter.api.Assertions.assertEquals;

import java.sql.SQLException;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.extension.ExtendWith;
import run.workhorse.ConnectionSource;
import run.workhorse.DependencyPolicy;
import run.workhorse.Queue;
import run.workhorse.TaskDependencyPolicy;
import run.workhorse.TaskDetail;
import run.workhorse.TaskState;
import run.workhorse.testing.ScratchDatabase;

/** Runs the Java snippet of the site page about task dependencies. */
@ExtendWith(ScratchDatabase.class)
@Timeout(value = 120, unit = TimeUnit.SECONDS)
class TaskDependenciesExamplesTest {
  private final Queue queue = new Queue(ConnectionSource.of(ExampleDatabase.dataSource()));

  @Test
  void theNotificationWaitsForTheImportWithItsPolicies() throws SQLException, InterruptedException {
    UUID importId = new TaskDependenciesExamples(queue).enqueueImportAndNotify();
    TaskDetail notify = ExampleDatabase.task("contacts.notify", "importId", importId.toString());
    assertEquals(TaskState.BLOCKED, notify.state());
    assertEquals(List.of(importId), notify.prerequisiteTaskIds());
    assertEquals(
        new TaskDependencyPolicy(
            DependencyPolicy.RELEASE, DependencyPolicy.FAIL, DependencyPolicy.CANCEL),
        notify.dependencyPolicy());

    // A cancellation of the import cancels the notification, as `onCancellation` says.
    queue.cancel(importId, "docs-example", "the test ends");
    assertEquals(TaskState.CANCELED, ExampleDatabase.awaitTerminal(notify.id()).state());
  }
}
