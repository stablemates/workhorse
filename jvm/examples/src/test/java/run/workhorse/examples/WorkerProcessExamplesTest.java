package run.workhorse.examples;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.SQLException;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.TimeUnit;
import org.jspecify.annotations.Nullable;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.extension.ExtendWith;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import run.workhorse.EnqueueOptions;
import run.workhorse.TaskDetail;
import run.workhorse.TaskState;
import run.workhorse.testing.ScratchDatabase;

/**
 * Runs each worker snippet that runs until the process ends in a child JVM ({@link
 * ExampleProcess}). The worker runs one {@code email.send} task, and then the test sends {@code
 * SIGTERM}. The worker claims every task of {@code email} and {@code billing}, so each run has its
 * own database.
 */
@ExtendWith(ScratchDatabase.class)
@Timeout(value = 180, unit = TimeUnit.SECONDS)
class WorkerProcessExamplesTest {
  /** The JVM's exit status for {@code SIGTERM}: 128 plus signal 15. */
  private static final int SIGTERM_STATUS = 143;

  private @Nullable Process child;
  private @Nullable Path errors;
  private @Nullable IsolatedExampleDatabase database;

  @AfterEach
  void killChild() throws IOException, SQLException, InterruptedException {
    try {
      if (child != null && child.isAlive()) {
        child.destroyForcibly();
        // The database drop waits for the connections of the child to end.
        assertTrue(
            child.waitFor(ExampleDatabase.WAIT.toSeconds(), TimeUnit.SECONDS),
            "the child JVM ends before the test drops its database");
      }
      if (errors != null) {
        Files.deleteIfExists(errors);
      }
    } finally {
      if (database != null) {
        database.close();
      }
    }
  }

  @ParameterizedTest
  @ValueSource(
      strings = {
        "java-register-handler",
        "java-worker-process",
        "kotlin-register-handler",
        "kotlin-worker-process"
      })
  void theWorkerRunsTheTaskAndEndsOnSigterm(String snippet) throws Exception {
    IsolatedExampleDatabase db = IsolatedExampleDatabase.create("worker-process");
    database = db;
    String to = snippet + "-" + UUID.randomUUID() + "@example.com";
    UUID taskId =
        db.queue()
            .enqueue(
                "email.send", Map.of("to", to), EnqueueOptions.builder().queue("email").build())
            .taskId();

    Process process = start(snippet, db.jdbcUrl());
    TaskDetail task = db.awaitTerminal(taskId);
    assertEquals(TaskState.SUCCEEDED, task.state(), errorText());
    assertEquals(Map.of("deliveredTo", to), task.result());

    process.destroy();
    assertTrue(
        process.waitFor(ExampleDatabase.WAIT.toSeconds(), TimeUnit.SECONDS), "the child exits");
    assertEquals(SIGTERM_STATUS, process.exitValue(), errorText());
  }

  private Process start(String snippet, String jdbcUrl) throws IOException {
    Path java = Path.of(System.getProperty("java.home"), "bin", "java");
    List<String> command = new ArrayList<>(List.of(java.toString()));
    command.add("-cp");
    command.add(System.getProperty("java.class.path"));
    command.addAll(List.of(ExampleProcess.class.getName(), snippet, jdbcUrl));
    ProcessBuilder builder = new ProcessBuilder(command);
    Path file = Files.createTempFile("workhorse-example-process", ".err");
    errors = file;
    builder.redirectError(file.toFile());
    builder.redirectOutput(ProcessBuilder.Redirect.DISCARD);
    Process process = builder.start();
    child = process;
    return process;
  }

  private String errorText() {
    try {
      return errors == null ? "" : "child standard error: " + Files.readString(errors);
    } catch (IOException error) {
      return error.toString();
    }
  }
}
