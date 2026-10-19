package run.workhorse.examples.programs;

import static org.junit.jupiter.api.Assertions.assertTrue;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.Connection;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Statement;
import java.util.List;
import java.util.Map;
import java.util.concurrent.TimeUnit;
import run.workhorse.examples.ExampleDatabase;
import run.workhorse.examples.IsolatedExampleDatabase;

/**
 * One scenario program, started in a child JVM with its database URL in the environment. The child
 * writes its standard output and its standard error to files, which {@link #close} deletes.
 */
final class ProgramProcess implements AutoCloseable {
  private final Process process;
  private final Path output;
  private final Path errors;

  private ProgramProcess(Process process, Path output, Path errors) {
    this.process = process;
    this.output = output;
    this.errors = errors;
  }

  /**
   * Starts the program whose {@code main} method is in {@code mainClass}, with {@code jdbcUrl} in
   * {@code WORKHORSE_DATABASE_URL}.
   */
  static ProgramProcess start(String mainClass, String jdbcUrl) throws IOException {
    return start(mainClass, Map.of("WORKHORSE_DATABASE_URL", jdbcUrl));
  }

  /** Starts the program in {@code mainClass}, with {@code environment} added to its environment. */
  static ProgramProcess start(String mainClass, Map<String, String> environment)
      throws IOException {
    Path java = Path.of(System.getProperty("java.home"), "bin", "java");
    ProcessBuilder builder =
        new ProcessBuilder(
            List.of(java.toString(), "-cp", System.getProperty("java.class.path"), mainClass));
    builder.environment().putAll(environment);
    Path output = Files.createTempFile("workhorse-program", ".out");
    Path errors = Files.createTempFile("workhorse-program", ".err");
    builder.redirectOutput(output.toFile());
    builder.redirectError(errors.toFile());
    return new ProgramProcess(builder.start(), output, errors);
  }

  /** Waits until the program ends, and returns its exit status. */
  int awaitExit() throws InterruptedException {
    assertTrue(
        process.waitFor(ExampleDatabase.WAIT.toSeconds(), TimeUnit.SECONDS),
        "the program ends; " + describe());
    return process.exitValue();
  }

  /** Sends {@code SIGTERM}, and returns the exit status. */
  int terminate() throws InterruptedException {
    process.destroy();
    return awaitExit();
  }

  /**
   * The number of rows in {@code workhorse.worker_registry}. A worker deletes its own row when it
   * ends its run, so a row left after the exit means the worker did not drain.
   */
  static long registeredWorkers(IsolatedExampleDatabase db) throws SQLException {
    try (Connection connection = db.connect();
        Statement statement = connection.createStatement();
        ResultSet row = statement.executeQuery("SELECT count(*) FROM workhorse.worker_registry")) {
      row.next();
      return row.getLong(1);
    }
  }

  /**
   * Sends {@code SIGTERM} while the worker is registered, and returns the exit status. The test
   * then expects no registry row.
   */
  int terminateRegistered(IsolatedExampleDatabase db) throws InterruptedException, SQLException {
    long deadline = System.nanoTime() + ExampleDatabase.WAIT.toNanos();
    while (registeredWorkers(db) == 0) {
      assertTrue(System.nanoTime() < deadline, "the worker registers; " + describe());
      Thread.sleep(50);
    }
    return terminate();
  }

  /** The standard output of the program. */
  String output() throws IOException {
    return Files.readString(output);
  }

  /** The standard output and the standard error, for an assertion message. */
  String describe() {
    try {
      return "standard output: "
          + Files.readString(output)
          + "; standard error: "
          + Files.readString(errors);
    } catch (IOException error) {
      return error.toString();
    }
  }

  @Override
  public void close() throws IOException {
    try {
      if (process.isAlive()) {
        process.destroyForcibly();
        // The database drop waits for the connections of the child to end.
        assertTrue(
            process.waitFor(ExampleDatabase.WAIT.toSeconds(), TimeUnit.SECONDS),
            "the child JVM ends before the test drops its database");
      }
    } catch (InterruptedException error) {
      Thread.currentThread().interrupt();
      throw new IOException("interrupted while the child JVM ends", error);
    } finally {
      Files.deleteIfExists(output);
      Files.deleteIfExists(errors);
    }
  }
}
