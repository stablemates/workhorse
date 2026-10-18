package dev.stablemates.workhorse;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import dev.stablemates.workhorse.testing.ScratchDataSource;
import dev.stablemates.workhorse.testing.ScratchDatabase;
import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStreamReader;
import java.io.OutputStreamWriter;
import java.io.Writer;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.BlockingQueue;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;
import org.jspecify.annotations.Nullable;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.extension.ExtendWith;

/**
 * {@link WorkerProcess#runWorkerProcess} in a child JVM. Each step waits for a line that the child
 * writes, and every wait is bounded, so no step depends on a sleep.
 */
@ExtendWith(ScratchDatabase.class)
@Timeout(value = 180, unit = TimeUnit.SECONDS)
class WorkerProcessTest {
  private static final Duration WAIT = Duration.ofSeconds(60);

  /** The JVM's exit status for {@code SIGTERM}: 128 plus signal 15. */
  private static final int SIGTERM_STATUS = 143;

  private final Queue queue = new Queue(ConnectionSource.of(new ScratchDataSource(true)));
  private final String queueName = "jvm-process-" + UUID.randomUUID();
  private @Nullable Process child;
  private @Nullable Path stderr;

  @AfterEach
  void killChild() {
    if (child != null && child.isAlive()) {
      child.destroyForcibly();
    }
    if (stderr != null) {
      try {
        Files.deleteIfExists(stderr);
      } catch (IOException ignored) {
        // The temporary directory keeps it.
      }
    }
  }

  /** The child's output, one line for each element, read on a daemon thread. */
  private record Output(BlockingQueue<String> lines, List<String> seen, Path errors) {
    String next(String prefix) throws InterruptedException {
      long deadline = System.nanoTime() + WAIT.toNanos();
      while (true) {
        long remaining = deadline - System.nanoTime();
        String line = remaining <= 0 ? null : lines.poll(remaining, TimeUnit.NANOSECONDS);
        if (line == null) {
          throw new AssertionError(
              "the child wrote no line that starts with "
                  + prefix
                  + "; it wrote "
                  + seen
                  + "; its standard error: "
                  + errorText());
        }
        seen.add(line);
        if (line.startsWith(prefix)) {
          return line;
        }
      }
    }

    String errorText() {
      try {
        return Files.readString(errors);
      } catch (IOException error) {
        return error.toString();
      }
    }
  }

  private Output start(String mode) throws IOException, SQLException {
    String url;
    try (Connection connection = ScratchDatabase.connect()) {
      url = connection.getMetaData().getURL();
    }
    Path java = Path.of(System.getProperty("java.home"), "bin", "java");
    List<String> command = new ArrayList<>(List.of(java.toString()));
    command.add("-cp");
    command.add(System.getProperty("java.class.path"));
    String modulePath = System.getProperty("jdk.module.path");
    if (modulePath != null && !modulePath.isEmpty()) {
      command.addAll(List.of("--module-path", modulePath, "--add-modules", "ALL-MODULE-PATH"));
    }
    command.addAll(List.of(WorkerProcessFixture.class.getName(), mode, url, queueName));
    ProcessBuilder builder = new ProcessBuilder(command);
    Path errors = Files.createTempFile("workhorse-worker-process", ".err");
    stderr = errors;
    builder.redirectError(errors.toFile());
    Process process = builder.start();
    child = process;
    BlockingQueue<String> lines = new LinkedBlockingQueue<>();
    Thread.ofPlatform()
        .daemon()
        .start(
            () -> {
              try (BufferedReader reader =
                  new BufferedReader(
                      new InputStreamReader(process.getInputStream(), StandardCharsets.UTF_8))) {
                String line;
                while ((line = reader.readLine()) != null) {
                  lines.add(line);
                }
              } catch (IOException ignored) {
                // The child ended.
              }
            });
    return new Output(lines, new ArrayList<>(), errors);
  }

  private int exitStatus() throws InterruptedException {
    Process process = child;
    assertTrue(process != null);
    assertTrue(process.waitFor(WAIT.toSeconds(), TimeUnit.SECONDS), "the child exits");
    return process.exitValue();
  }

  private static String state(UUID taskId) throws SQLException {
    try (Connection connection = ScratchDatabase.connect();
        PreparedStatement statement =
            connection.prepareStatement(
                "SELECT COALESCE(o.state, r.state) FROM workhorse.task t"
                    + " LEFT JOIN workhorse.task_runtime r ON r.task_id = t.id"
                    + " LEFT JOIN workhorse.task_outcome o ON o.task_id = t.id"
                    + " WHERE t.id = ?::uuid")) {
      statement.setString(1, taskId.toString());
      try (ResultSet result = statement.executeQuery()) {
        assertTrue(result.next());
        return result.getString(1);
      }
    }
  }

  @Test
  void drainsTheWorkerOnSigtermBeforeTheProcessExits() throws Exception {
    UUID taskId =
        queue
            .enqueue("drain", Map.of(), EnqueueOptions.builder().queue(queueName).build())
            .taskId();
    Output output = start("drain");
    assertEquals("STARTED " + taskId, output.next("STARTED"));

    // ProcessHandle.destroy sends SIGTERM on Unix. Process.destroy would also close the child's
    // streams, so the test could no longer read its output or let its handler finish.
    Process process = child;
    assertTrue(process != null);
    assertTrue(process.toHandle().destroy(), "the signal was sent");
    output.next("EVENT workhorse.worker.stop_requested");
    assertTrue(process.isAlive(), "the process waits for the drain");
    assertEquals("active", state(taskId), "the handler still runs after the signal");

    Writer stdin = new OutputStreamWriter(process.getOutputStream(), StandardCharsets.UTF_8);
    stdin.write("finish\n");
    stdin.flush();
    assertEquals("HANDLER_DONE finish", output.next("HANDLER_DONE"));
    output.next("EVENT workhorse.task.completed");
    output.next("EVENT workhorse.worker.stopped");

    assertEquals(SIGTERM_STATUS, exitStatus());
    assertEquals("succeeded", state(taskId), "the drained handler completed its task");
  }

  @Test
  void exitsZeroWhenTheRunReturnsWithoutASignal() throws Exception {
    Output output = start("return");
    output.next("EVENT workhorse.worker.stopped");
    assertEquals(0, exitStatus());
  }

  @Test
  void exitsOneWhenTheRunThrowsWithoutASignal() throws Exception {
    start("fail");
    assertEquals(1, exitStatus());
    Path errors = stderr;
    assertTrue(errors != null);
    assertTrue(
        Files.readString(errors).contains("the fixture refuses every connection"),
        "the error goes to standard error");
  }
}
