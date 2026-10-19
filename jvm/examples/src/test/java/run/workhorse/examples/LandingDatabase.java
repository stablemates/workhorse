package run.workhorse.examples;

import static org.junit.jupiter.api.Assertions.assertTrue;

import java.io.ByteArrayOutputStream;
import java.io.PrintStream;
import java.net.URI;
import java.net.URLDecoder;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Statement;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import java.util.function.BooleanSupplier;
import javax.sql.DataSource;
import org.postgresql.ds.PGSimpleDataSource;
import run.workhorse.Admin;
import run.workhorse.ConnectionSource;
import run.workhorse.Queue;
import run.workhorse.TaskDetail;
import run.workhorse.TaskState;
import run.workhorse.Worker;
import run.workhorse.testing.ScratchDatabase;

/**
 * An extra scratch database for the landing page snippets, with the {@code orders} table of the
 * enqueue snippet. The snippets run workers on the {@code default} queue and read the whole worker
 * registry, so their own database keeps them away from the other snippet tests.
 */
final class LandingDatabase implements AutoCloseable {
  private final ScratchDatabase.Extra extra;
  private final String jdbcUrl;

  private LandingDatabase(ScratchDatabase.Extra extra, String jdbcUrl) {
    this.extra = extra;
    this.jdbcUrl = jdbcUrl;
  }

  /**
   * Creates the database for {@code purpose}. The test class must extend {@link ScratchDatabase}.
   */
  static LandingDatabase create(String purpose) throws Exception {
    ScratchDatabase.Extra extra = ScratchDatabase.extra(purpose);
    try (Connection connection = extra.connect();
        Statement statement = connection.createStatement()) {
      statement.execute("CREATE TABLE orders (id text PRIMARY KEY, total bigint NOT NULL)");
      return new LandingDatabase(extra, withCredentials(connection.getMetaData().getURL()));
    } catch (Exception error) {
      extra.close();
      throw error;
    }
  }

  /** The JDBC URL of the database, with the credentials of {@code DATABASE_URL_TEST}. */
  String jdbcUrl() {
    return jdbcUrl;
  }

  /** A source of autocommit connections to the database. */
  DataSource dataSource() {
    PGSimpleDataSource dataSource = new PGSimpleDataSource();
    dataSource.setURL(jdbcUrl);
    return dataSource;
  }

  /** A queue on the database. */
  Queue queue() {
    return new Queue(ConnectionSource.of(dataSource()));
  }

  /** An admin client on the database. */
  Admin admin() {
    return new Admin(ConnectionSource.of(dataSource()));
  }

  /** A worker builder for {@code runOnce} on the database, without the worker registry. */
  Worker.Builder worker(String... queues) {
    Worker.Builder builder = Worker.builder(dataSource()).disableRegistry(true);
    return queues.length == 0 ? builder : builder.queues(queues);
  }

  /** The detail of one task. */
  TaskDetail detail(UUID taskId) {
    return admin().getTask(taskId).orElseThrow();
  }

  /** The number of {@code orders} rows with {@code id}. */
  long orders(String id) throws SQLException {
    try (Connection connection = extra.connect();
        PreparedStatement statement =
            connection.prepareStatement("SELECT count(*) FROM orders WHERE id = ?")) {
      statement.setString(1, id);
      try (ResultSet result = statement.executeQuery()) {
        result.next();
        return result.getLong(1);
      }
    }
  }

  /** The tasks of {@code taskType} whose payload holds {@code key} with {@code value}. */
  List<UUID> tasks(String taskType, String key, String value) throws SQLException {
    try (Connection connection = extra.connect();
        PreparedStatement statement =
            connection.prepareStatement(
                "SELECT id FROM workhorse.task WHERE task_type = ? AND payload ->> ? = ?"
                    + " ORDER BY created_at, id")) {
      statement.setString(1, taskType);
      statement.setString(2, key);
      statement.setString(3, value);
      List<UUID> ids = new ArrayList<>();
      try (ResultSet result = statement.executeQuery()) {
        while (result.next()) {
          ids.add(result.getObject(1, UUID.class));
        }
      }
      return ids;
    }
  }

  /** Whether the database has the schedule {@code name} in {@code namespace}. */
  boolean hasSchedule(String namespace, String name) throws SQLException {
    try (Connection connection = extra.connect();
        PreparedStatement statement =
            connection.prepareStatement(
                "SELECT count(*) FROM workhorse.schedule_definition"
                    + " WHERE namespace = ? AND schedule_name = ?")) {
      statement.setString(1, namespace);
      statement.setString(2, name);
      try (ResultSet result = statement.executeQuery()) {
        result.next();
        return result.getLong(1) == 1;
      }
    }
  }

  /** Runs {@code worker} once at a time until {@code done} holds. */
  static void runUntil(Worker worker, BooleanSupplier done) throws InterruptedException {
    long deadline = System.nanoTime() + ExampleDatabase.WAIT.toNanos();
    while (!done.getAsBoolean()) {
      assertTrue(System.nanoTime() < deadline, "the condition still does not hold");
      if (!worker.runOnce()) {
        Thread.sleep(50);
      }
    }
  }

  /** Runs {@code worker} once at a time until the task is in {@code state}. */
  void runUntil(Worker worker, UUID taskId, TaskState state) throws InterruptedException {
    runUntil(worker, () -> detail(taskId).state() == state);
  }

  /** Waits until {@code done} holds. */
  static void await(BooleanSupplier done) throws InterruptedException {
    long deadline = System.nanoTime() + ExampleDatabase.WAIT.toNanos();
    while (!done.getAsBoolean()) {
      assertTrue(System.nanoTime() < deadline, "the condition still does not hold");
      Thread.sleep(50);
    }
  }

  /** Runs {@code action} and returns the lines it wrote to standard output. */
  static List<String> standardOutput(ThrowingRunnable action) throws Exception {
    PrintStream original = System.out;
    ByteArrayOutputStream buffer = new ByteArrayOutputStream();
    System.setOut(new PrintStream(buffer, true, StandardCharsets.UTF_8));
    try {
      action.run();
    } finally {
      System.setOut(original);
    }
    return buffer.toString(StandardCharsets.UTF_8).lines().toList();
  }

  /** An action that can throw. */
  @FunctionalInterface
  interface ThrowingRunnable {
    /** Runs the action. */
    void run() throws Exception;
  }

  @Override
  public void close() throws SQLException {
    extra.close();
  }

  private static String withCredentials(String url) {
    String userInfo = URI.create(System.getenv("DATABASE_URL_TEST")).getRawUserInfo();
    if (userInfo == null) {
      return url;
    }
    String[] parts = userInfo.split(":", 2);
    StringBuilder result = new StringBuilder(url).append(url.contains("?") ? '&' : '?');
    result.append("user=").append(encode(parts[0]));
    if (parts.length > 1) {
      result.append("&password=").append(encode(parts[1]));
    }
    return result.toString();
  }

  private static String encode(String raw) {
    return URLEncoder.encode(
        URLDecoder.decode(raw, StandardCharsets.UTF_8), StandardCharsets.UTF_8);
  }
}
