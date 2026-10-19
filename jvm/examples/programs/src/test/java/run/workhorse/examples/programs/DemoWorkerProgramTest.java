package run.workhorse.examples.programs;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Statement;
import java.time.Duration;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;
import org.jspecify.annotations.Nullable;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.extension.ExtendWith;
import run.workhorse.EnqueueOptions;
import run.workhorse.JsonCodec;
import run.workhorse.Queue;
import run.workhorse.TaskDetail;
import run.workhorse.TaskState;
import run.workhorse.Worker;
import run.workhorse.examples.ExampleDatabase;
import run.workhorse.examples.IsolatedExampleDatabase;
import run.workhorse.testing.ScratchDatabase;

/**
 * The JVM demo worker, held to the behavior of {@code ruby/examples/demo_worker.rb}. The worker
 * names the fixed queues {@code demo-jvm}, {@code demo-jvm-fast}, and {@code demo-shared}, and one
 * test drops the schema, so each database test has a database of its own. No test starts the demo.
 */
@ExtendWith(ScratchDatabase.class)
@Timeout(value = 180, unit = TimeUnit.SECONDS)
class DemoWorkerProgramTest {
  @Test
  void itServesItsOwnQueueTheSharedQueueAndItsFastTierQueue() {
    assertEquals(
        List.of("demo-jvm", "demo-shared", "demo-jvm-fast"),
        List.of(
            DemoWorkerProgram.JVM_QUEUE,
            DemoWorkerProgram.SHARED_QUEUE,
            DemoWorkerProgram.JVM_FAST_QUEUE));
  }

  @Test
  void itReadsTheDevelopmentPrimaryDatabase() {
    assertEquals(
        "jdbc:postgresql:///dev_primary",
        DemoWorkerProgram.databaseUrl(
            Map.of(
                "DATABASE_URL_PRIMARY",
                "jdbc:postgresql:///dev_primary",
                "DATABASE_URL",
                "jdbc:postgresql:///ambient")));
    assertThrows(IllegalArgumentException.class, () -> DemoWorkerProgram.databaseUrl(Map.of()));
  }

  @Test
  void itReadsThePollIntervalInMillisecondsAndKeepsTheSdkDefaultForZero() {
    assertEquals(Optional.of(Duration.ofSeconds(15)), DemoWorkerProgram.pollInterval(Map.of()));
    assertEquals(
        Optional.of(Duration.ofMillis(50)),
        DemoWorkerProgram.pollInterval(Map.of("WORKHORSE_WORKER_POLL_MS", "50")));
    assertEquals(
        Optional.empty(), DemoWorkerProgram.pollInterval(Map.of("WORKHORSE_WORKER_POLL_MS", "0")));
    assertThrows(
        IllegalArgumentException.class,
        () -> DemoWorkerProgram.pollInterval(Map.of("WORKHORSE_WORKER_POLL_MS", "-1")));
    assertThrows(
        IllegalArgumentException.class,
        () -> DemoWorkerProgram.pollInterval(Map.of("WORKHORSE_WORKER_POLL_MS", "soon")));
  }

  @Test
  void itWaitsForTheSchemaOnlyInTheDevelopmentDemo() {
    assertTrue(DemoWorkerProgram.waitsForSchema(Map.of("WORKHORSE_DEMO_MODE", "development")));
    assertFalse(DemoWorkerProgram.waitsForSchema(Map.of("WORKHORSE_DEMO_MODE", "production")));
    assertFalse(DemoWorkerProgram.waitsForSchema(Map.of()));
    assertThrows(
        IllegalArgumentException.class,
        () -> DemoWorkerProgram.waitsForSchema(Map.of("WORKHORSE_DEMO_MODE", "staging")));
  }

  @Test
  void itIdentifiesTheJvmRuntimeInItsResultsAndRefusesAnotherLanguage() {
    assertEquals(
        Map.of("language", "jvm", "runtime", "jvm", "attempt", 2),
        DemoWorkerProgram.languageTask(Map.of("language", "jvm"), 2));
    assertThrows(
        IllegalArgumentException.class,
        () -> DemoWorkerProgram.languageTask(Map.of("language", "go"), 1));
    assertEquals(
        Map.of("source", "schedule", "runtime", "jvm", "attempt", 3),
        DemoWorkerProgram.sharedTask(Map.of("source", "schedule"), 3));
    assertThrows(
        IllegalArgumentException.class,
        () -> DemoWorkerProgram.sharedTask(Map.of("source", 123), 1));
  }

  @Test
  void itNamesEachWorkerAfterItsRuntimeAndKeepsTheNameProcessUnique() {
    String first = DemoWorkerProgram.workerId();
    String second = DemoWorkerProgram.workerId();
    assertTrue(first.startsWith("demo-jvm-"), first);
    assertTrue(second.startsWith("demo-jvm-"), second);
    assertNotEquals(first, second);
  }

  @Test
  void itCompletesTasksOnItsFullTierAndFastTierQueuesAndFailsAnotherLanguagesTask()
      throws Exception {
    try (IsolatedExampleDatabase db = IsolatedExampleDatabase.create("demo-worker")) {
      try (Connection connection = db.connect();
          PreparedStatement tier =
              connection.prepareStatement(
                  "SELECT workhorse.set_queue_tier_v1(?::text, ?::text, ?::text, ?::text)")) {
        tier.setString(1, DemoWorkerProgram.JVM_FAST_QUEUE);
        tier.setString(2, "fast");
        tier.setString(3, "workhorse-demo-seed");
        tier.setString(4, "test");
        tier.execute();
      }
      Queue queue = db.queue();
      UUID language = enqueue(queue, DemoWorkerProgram.JVM_QUEUE, "language", "jvm", null);
      UUID shared =
          queue
              .enqueue(
                  DemoWorkerProgram.SHARED_TASK_TYPE,
                  Map.of("source", "test"),
                  EnqueueOptions.builder().queue(DemoWorkerProgram.SHARED_QUEUE).build())
              .taskId();
      UUID fast = enqueue(queue, DemoWorkerProgram.JVM_FAST_QUEUE, "language", "jvm", null);
      UUID foreign = enqueue(queue, DemoWorkerProgram.JVM_QUEUE, "language", "go", 1);

      Worker worker =
          DemoWorkerProgram.buildWorker(
              db.dataSource(),
              Optional.of(Duration.ofMillis(20)),
              "demo-jvm-test-" + UUID.randomUUID());
      CompletableFuture<Void> running = CompletableFuture.runAsync(worker::run);
      try {
        TaskDetail languageTask = db.awaitTerminal(language);
        assertEquals(TaskState.SUCCEEDED, languageTask.state());
        assertEquals(
            Map.of("language", "jvm", "runtime", "jvm", "attempt", 1L), languageTask.result());
        TaskDetail sharedTask = db.awaitTerminal(shared);
        assertEquals(TaskState.SUCCEEDED, sharedTask.state());
        assertEquals(
            Map.of("source", "test", "runtime", "jvm", "attempt", 1L), sharedTask.result());
        assertEquals(
            List.of("succeeded", Map.of("language", "jvm", "runtime", "jvm", "attempt", 1L)),
            fastOutcome(db, fast));
        assertEquals(TaskState.FAILED, db.awaitTerminal(foreign).state());
      } finally {
        worker.stop();
        running.get(ExampleDatabase.WAIT.toSeconds(), TimeUnit.SECONDS);
        worker.close();
      }
    }
  }

  @Test
  void theProgramReadsItsEnvironmentRunsATaskAndDrainsOnSigterm() throws Exception {
    try (IsolatedExampleDatabase db = IsolatedExampleDatabase.create("demo-worker-program");
        ProgramProcess program =
            ProgramProcess.start(
                DemoWorkerProgram.class.getName(),
                Map.of(
                    "DATABASE_URL_PRIMARY",
                    db.jdbcUrl(),
                    "WORKHORSE_DEMO_MODE",
                    "development",
                    "WORKHORSE_WORKER_POLL_MS",
                    "50"))) {
      UUID task = enqueue(db.queue(), DemoWorkerProgram.JVM_QUEUE, "language", "jvm", null);
      TaskDetail detail = db.awaitTerminal(task);
      assertEquals(TaskState.SUCCEEDED, detail.state(), program.describe());
      assertEquals(Map.of("language", "jvm", "runtime", "jvm", "attempt", 1L), detail.result());
      // The JVM's exit status for SIGTERM: 128 plus signal 15.
      assertEquals(143, program.terminateRegistered(db), program.describe());
      assertEquals(0, ProgramProcess.registeredWorkers(db), "the worker drains and deregisters");
    }
  }

  @Test
  void itWaitsForAMissingSchemaUntilItIsInstalled() throws Exception {
    try (IsolatedExampleDatabase db = IsolatedExampleDatabase.create("demo-worker-schema")) {
      DemoWorkerProgram.waitForSchema(db.dataSource(), Duration.ofMillis(50));

      try (Connection connection = db.connect();
          Statement statement = connection.createStatement()) {
        statement.execute("SET client_min_messages TO warning; DROP SCHEMA workhorse CASCADE");
      }
      CompletableFuture<Void> waiting =
          CompletableFuture.runAsync(
              () -> {
                try {
                  DemoWorkerProgram.waitForSchema(db.dataSource(), Duration.ofMillis(50));
                } catch (InterruptedException error) {
                  Thread.currentThread().interrupt();
                  throw new IllegalStateException(error);
                }
              });
      Thread.sleep(500);
      assertFalse(waiting.isDone(), "the worker waits while the schema is missing");

      try (Connection connection = db.connect();
          Statement statement = connection.createStatement()) {
        statement.execute(Files.readString(Path.of(System.getProperty("workhorse.schema"))));
      }
      waiting.get(ExampleDatabase.WAIT.toSeconds(), TimeUnit.SECONDS);
    }
  }

  private static UUID enqueue(
      Queue queue, String queueName, String key, String value, @Nullable Integer maxAttempts) {
    return queue
        .enqueue(
            DemoWorkerProgram.LANGUAGE_TASK_TYPE,
            Map.of(key, value),
            EnqueueOptions.builder().queue(queueName).maxAttempts(maxAttempts).build())
        .taskId();
  }

  /** The state and the result of a fast-tier task, from its outcome row. */
  private static List<Object> fastOutcome(IsolatedExampleDatabase db, UUID taskId)
      throws SQLException, InterruptedException {
    long deadline = System.nanoTime() + ExampleDatabase.WAIT.toNanos();
    while (true) {
      try (Connection connection = db.connect();
          PreparedStatement select =
              connection.prepareStatement(
                  "SELECT state, result::text FROM workhorse.fast_task_outcome WHERE task_id = ?")) {
        select.setObject(1, taskId);
        try (ResultSet row = select.executeQuery()) {
          if (row.next()) {
            Object result = JsonCodec.standard().decode(row.getString(2), Map.class);
            return List.of(row.getString(1), result);
          }
        }
      }
      assertTrue(System.nanoTime() < deadline, "fast task " + taskId + " has no outcome");
      Thread.sleep(20);
    }
  }
}
