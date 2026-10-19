package run.workhorse.examples.programs;

import java.net.InetAddress;
import java.net.UnknownHostException;
import java.security.SecureRandom;
import java.time.Duration;
import java.util.HexFormat;
import java.util.Map;
import java.util.Optional;
import javax.sql.DataSource;
import org.jspecify.annotations.Nullable;
import org.postgresql.ds.PGSimpleDataSource;
import run.workhorse.CompatibilityException;
import run.workhorse.ConnectionSource;
import run.workhorse.Queue;
import run.workhorse.Worker;
import run.workhorse.WorkerProcess;

/**
 * Serves the JVM queues of the dashboard demo, plus the queue every demo language shares. It is the
 * JVM counterpart of {@code ruby/examples/demo_worker.rb}.
 *
 * <p>The demo does not start this worker yet. The program reads {@code DATABASE_URL_PRIMARY} as a
 * JDBC URL.
 *
 * <p>Documentation: https://workhorse.run/docs/dashboard
 */
public final class DemoWorkerProgram {
  /** The task type of each language's own demo queue. */
  public static final String LANGUAGE_TASK_TYPE = "demo.language-worker";

  /** The task type of the queue that every demo language serves. */
  public static final String SHARED_TASK_TYPE = "demo.shared-worker";

  /** The full-tier JVM queue. */
  public static final String JVM_QUEUE = "demo-jvm";

  /** The fast-tier JVM queue. */
  public static final String JVM_FAST_QUEUE = "demo-jvm-fast";

  /** The queue that every demo language serves. */
  public static final String SHARED_QUEUE = "demo-shared";

  static final String SCHEDULE_NAMESPACE = "workhorse-demo";
  static final String FAST_TIER_SCHEDULE_NAMESPACE = "workhorse-demo-fast-tier";
  static final int WORKER_CONCURRENCY = 3;
  static final long DEFAULT_POLL_MS = 15_000;
  static final Duration SCHEMA_RETRY = Duration.ofMillis(500);

  private static final SecureRandom RANDOM = new SecureRandom();

  private DemoWorkerProgram() {}

  /** Reads {@code DATABASE_URL_PRIMARY}. */
  static String databaseUrl(Map<String, String> environment) {
    String value = environment.get("DATABASE_URL_PRIMARY");
    if (value == null || value.isEmpty()) {
      throw new IllegalArgumentException("DATABASE_URL_PRIMARY is required");
    }
    return value;
  }

  /**
   * Reads {@code WORKHORSE_WORKER_POLL_MS} in milliseconds. Zero leaves the SDK default in place,
   * so the result is empty.
   */
  static Optional<Duration> pollInterval(Map<String, String> environment) {
    String value = environment.get("WORKHORSE_WORKER_POLL_MS");
    long milliseconds;
    if (value == null || value.isEmpty()) {
      milliseconds = DEFAULT_POLL_MS;
    } else {
      try {
        milliseconds = Long.parseLong(value, 10);
      } catch (NumberFormatException error) {
        milliseconds = -1;
      }
    }
    if (milliseconds < 0) {
      throw new IllegalArgumentException("WORKHORSE_WORKER_POLL_MS must be a non-negative integer");
    }
    return milliseconds == 0 ? Optional.empty() : Optional.of(Duration.ofMillis(milliseconds));
  }

  /** Only the development demo waits for a missing schema; production refuses at once. */
  static boolean waitsForSchema(Map<String, String> environment) {
    String mode = environment.get("WORKHORSE_DEMO_MODE");
    if (mode == null || mode.isEmpty()) {
      mode = "production";
    }
    if (!mode.equals("development") && !mode.equals("production")) {
      throw new IllegalArgumentException(
          "WORKHORSE_DEMO_MODE must be either development or production");
    }
    return mode.equals("development");
  }

  /**
   * Waits while the demo server has not installed the schema yet.
   *
   * <p>In development the server installs the schema on first start, so a worker that starts beside
   * it can see an empty database. Every other compatibility refusal fails at once. Each check
   * builds a new queue, so no earlier refusal is reused.
   */
  static void waitForSchema(DataSource dataSource, Duration retry) throws InterruptedException {
    boolean logged = false;
    while (true) {
      try {
        new Queue(ConnectionSource.of(dataSource)).assertCompatible();
        return;
      } catch (CompatibilityException error) {
        if (error.code() != CompatibilityException.Code.SCHEMA_NOT_INSTALLED) {
          throw error;
        }
        if (!logged) {
          System.out.println("Waiting for the demo server to install the Workhorse schema");
          System.out.flush();
          logged = true;
        }
        Thread.sleep(retry.toMillis());
      }
    }
  }

  /** The result of a task on the JVM queue. A task for another language fails. */
  static Map<String, Object> languageTask(@Nullable Map<?, ?> payload, int attempt) {
    if (payload == null || !"jvm".equals(payload.get("language"))) {
      throw new IllegalArgumentException("JVM worker received a task for another language");
    }
    return Map.of("language", "jvm", "runtime", "jvm", "attempt", attempt);
  }

  /** The result of a task on the shared queue. A task without a source fails. */
  static Map<String, Object> sharedTask(@Nullable Map<?, ?> payload, int attempt) {
    if (payload == null || !(payload.get("source") instanceof String source)) {
      throw new IllegalArgumentException("Shared worker requires a source");
    }
    return Map.of("source", source, "runtime", "jvm", "attempt", attempt);
  }

  /** A worker id that names the runtime and the host, and is unique for each process. */
  static String workerId() {
    String hostname;
    try {
      hostname = InetAddress.getLocalHost().getHostName().replaceAll("[^A-Za-z0-9._-]", "-");
    } catch (UnknownHostException error) {
      hostname = "";
    }
    if (hostname.isEmpty()) {
      hostname = "unknown-host";
    }
    byte[] suffix = new byte[4];
    RANDOM.nextBytes(suffix);
    return "demo-jvm-"
        + hostname
        + "-"
        + ProcessHandle.current().pid()
        + "-"
        + HexFormat.of().formatHex(suffix);
  }

  /** Builds the worker that serves the JVM queue, the fast-tier JVM queue, and the shared queue. */
  static Worker buildWorker(
      DataSource dataSource, Optional<Duration> pollInterval, String workerId) {
    Worker.Builder builder =
        Worker.builder(dataSource)
            .queues(JVM_QUEUE, SHARED_QUEUE, JVM_FAST_QUEUE)
            .workerId(workerId)
            .concurrency(WORKER_CONCURRENCY)
            .scheduleNamespaces(SCHEDULE_NAMESPACE, FAST_TIER_SCHEDULE_NAMESPACE)
            .maintenanceInterval(Duration.ofSeconds(1))
            .registryInterval(Duration.ofMillis(250))
            .shutdownGrace(Duration.ofSeconds(25));
    pollInterval.ifPresent(builder::pollInterval);
    return builder
        .handle(
            LANGUAGE_TASK_TYPE,
            Map.class,
            (context, payload) -> languageTask(payload, context.task().attempt()))
        .handle(
            SHARED_TASK_TYPE,
            Map.class,
            (context, payload) -> sharedTask(payload, context.task().attempt()))
        .build();
  }

  public static void main(String[] arguments) throws InterruptedException {
    Map<String, String> environment = System.getenv();
    Optional<Duration> poll = pollInterval(environment);
    boolean waits = waitsForSchema(environment);
    PGSimpleDataSource dataSource = new PGSimpleDataSource();
    dataSource.setURL(databaseUrl(environment));
    if (waits) {
      waitForSchema(dataSource, SCHEMA_RETRY);
    }
    WorkerProcess.runWorkerProcess(buildWorker(dataSource, poll, workerId()));
  }
}
