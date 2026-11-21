package run.workhorse.examples;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.concurrent.TimeUnit;

/**
 * Runs a snippet that is a whole program. The snippet reads its database from the environment, as
 * the page tells the reader, so the test starts its {@code main} in a child JVM with {@code
 * JDBC_DATABASE_URL} set.
 */
final class ExampleProgram {
  private ExampleProgram() {}

  /**
   * Runs the {@code main} of {@code mainClass} against {@code jdbcUrl}, requires exit status 0, and
   * returns its standard output.
   */
  static String run(String mainClass, String jdbcUrl) throws IOException, InterruptedException {
    Path java = Path.of(System.getProperty("java.home"), "bin", "java");
    ProcessBuilder builder =
        new ProcessBuilder(
            List.of(java.toString(), "-cp", System.getProperty("java.class.path"), mainClass));
    builder.environment().put("JDBC_DATABASE_URL", jdbcUrl);
    Path output = Files.createTempFile("workhorse-example", ".out");
    Path errors = Files.createTempFile("workhorse-example", ".err");
    try {
      builder.redirectOutput(output.toFile());
      builder.redirectError(errors.toFile());
      Process process = builder.start();
      boolean ended = process.waitFor(ExampleDatabase.WAIT.toSeconds(), TimeUnit.SECONDS);
      if (!ended) {
        process.destroyForcibly().waitFor();
      }
      String standardError = Files.readString(errors, StandardCharsets.UTF_8);
      assertTrue(ended, mainClass + " ends; standard error:\n" + standardError);
      assertEquals(0, process.exitValue(), mainClass + " standard error:\n" + standardError);
      return Files.readString(output, StandardCharsets.UTF_8);
    } finally {
      Files.deleteIfExists(output);
      Files.deleteIfExists(errors);
    }
  }
}
