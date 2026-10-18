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
 * Runs each landing snippet that runs a worker until the process ends in a child JVM ({@link
 * LandingProcess}), on a database of its own. The test checks the effect of the snippet, and then
 * sends {@code SIGTERM}.
 */
@ExtendWith(ScratchDatabase.class)
@Timeout(value = 180, unit = TimeUnit.SECONDS)
class LandingProcessExamplesTest {
  /** The JVM's exit status for {@code SIGTERM}: 128 plus signal 15. */
  private static final int SIGTERM_STATUS = 143;

  private @Nullable Process child;
  private @Nullable Path errors;
  private @Nullable LandingDatabase database;

  @AfterEach
  void cleanUp() throws Exception {
    try {
      if (child != null && child.isAlive()) {
        child.destroyForcibly();
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
  @ValueSource(strings = {"landing-hero-java", "landing-hero-kotlin"})
  void theHeroWorkerRunsTheWelcomeTask(String snippet) throws Exception {
    LandingDatabase db = database(snippet);
    Process process = start(snippet, db);
    LandingDatabase.await(() -> !tasks(db, "email.welcome", "to", "ada@example.com").isEmpty());
    UUID taskId = tasks(db, "email.welcome", "to", "ada@example.com").getFirst();
    LandingDatabase.await(() -> terminal(db.detail(taskId)));
    TaskDetail task = db.detail(taskId);
    assertEquals(TaskState.SUCCEEDED, task.state(), errorText());
    assertEquals(Map.of("deliveredTo", "ada@example.com"), task.result());
    stop(process);
  }

  @ParameterizedTest
  @ValueSource(strings = {"landing-schedules-java", "landing-schedules-kotlin"})
  void theScheduleIsStoredAndTheWorkerRuns(String snippet) throws Exception {
    LandingDatabase db = database(snippet);
    Process process = start(snippet, db);
    LandingDatabase.await(() -> hasSchedule(db) && !db.admin().listWorkers().isEmpty());
    assertTrue(process.isAlive(), errorText());
    stop(process);
  }

  @ParameterizedTest
  @ValueSource(strings = {"landing-deploy-java", "landing-deploy-kotlin"})
  void theDeployedWorkerSendsTheEmail(String snippet) throws Exception {
    LandingDatabase db = database(snippet);
    String to = snippet + "@example.com";
    UUID taskId =
        db.queue()
            .enqueue(
                "email.send", Map.of("to", to), EnqueueOptions.builder().queue("email").build())
            .taskId();
    Process process = start(snippet, db);
    LandingDatabase.await(() -> terminal(db.detail(taskId)));
    TaskDetail task = db.detail(taskId);
    assertEquals(TaskState.SUCCEEDED, task.state(), errorText());
    assertEquals(Map.of("sent", to), task.result());
    stop(process);
  }

  private LandingDatabase database(String snippet) throws Exception {
    LandingDatabase db = LandingDatabase.create(snippet);
    database = db;
    return db;
  }

  private static boolean terminal(TaskDetail task) {
    return task.state() == TaskState.SUCCEEDED
        || task.state() == TaskState.FAILED
        || task.state() == TaskState.CANCELED;
  }

  private static List<UUID> tasks(LandingDatabase db, String taskType, String key, String value) {
    try {
      return db.tasks(taskType, key, value);
    } catch (SQLException error) {
      throw new IllegalStateException(error);
    }
  }

  private static boolean hasSchedule(LandingDatabase db) {
    try {
      return db.hasSchedule("billing", "nightly-invoice-run");
    } catch (SQLException error) {
      throw new IllegalStateException(error);
    }
  }

  private void stop(Process process) throws InterruptedException {
    process.destroy();
    assertTrue(
        process.waitFor(ExampleDatabase.WAIT.toSeconds(), TimeUnit.SECONDS), "the child exits");
    assertEquals(SIGTERM_STATUS, process.exitValue(), errorText());
  }

  private Process start(String snippet, LandingDatabase db) throws IOException {
    Path java = Path.of(System.getProperty("java.home"), "bin", "java");
    List<String> command = new ArrayList<>(List.of(java.toString()));
    command.add("-cp");
    command.add(System.getProperty("java.class.path"));
    command.addAll(List.of(LandingProcess.class.getName(), snippet, db.jdbcUrl()));
    ProcessBuilder builder = new ProcessBuilder(command);
    builder.environment().put("JDBC_DATABASE_URL", db.jdbcUrl());
    Path file = Files.createTempFile("workhorse-landing-process", ".err");
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
