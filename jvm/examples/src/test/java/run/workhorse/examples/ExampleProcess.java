package run.workhorse.examples;

import java.util.HashMap;
import java.util.Map;
import org.jspecify.annotations.Nullable;
import org.postgresql.ds.PGSimpleDataSource;

/**
 * The child JVM of {@link WorkerProcessExamplesTest}. A snippet that runs a worker until the
 * process ends cannot run inside the test JVM, so this process runs it.
 *
 * <p>Arguments: the snippet ({@code java-register-handler}, {@code java-worker-process}, {@code
 * kotlin-register-handler}, or {@code kotlin-worker-process}), and a JDBC URL with credentials.
 */
final class ExampleProcess {
  /** The worker concurrency that the snippets read. */
  static final int CONCURRENCY = 2;

  private ExampleProcess() {}

  /** The mail provider of the snippets: it returns the address it delivered to. */
  static Mailer mailer() {
    return payload -> {
      Map<String, @Nullable Object> result = new HashMap<>();
      result.put("deliveredTo", payload.get("to"));
      return result;
    };
  }

  public static void main(String[] arguments) {
    PGSimpleDataSource dataSource = new PGSimpleDataSource();
    dataSource.setURL(arguments[1]);
    WorkerExamples java =
        new WorkerExamples(dataSource, mailer(), CONCURRENCY, ExampleDatabase.WAIT);
    switch (arguments[0]) {
      case "java-register-handler" -> java.registerAndRun();
      case "java-worker-process" -> java.runProcess();
      case "kotlin-register-handler" ->
          WorkerExamplesKt.registerAndRun(dataSource, mailer(), CONCURRENCY);
      case "kotlin-worker-process" ->
          WorkerExamplesKt.runWorkerProcess(dataSource, mailer(), CONCURRENCY);
      default -> throw new IllegalArgumentException("unknown snippet " + arguments[0]);
    }
  }
}
