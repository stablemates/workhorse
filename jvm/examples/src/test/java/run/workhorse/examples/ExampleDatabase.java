package run.workhorse.examples;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.net.URI;
import java.net.URLDecoder;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Statement;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import javax.sql.DataSource;
import run.workhorse.Admin;
import run.workhorse.ConnectionSource;
import run.workhorse.TaskDetail;
import run.workhorse.TaskState;
import run.workhorse.testing.ScratchDataSource;
import run.workhorse.testing.ScratchDatabase;

/** Reads and prepares the scratch database for the snippet tests. */
public final class ExampleDatabase {
  /** The longest wait of a snippet test for a task to end. */
  public static final Duration WAIT = Duration.ofSeconds(60);

  private ExampleDatabase() {}

  /** A source of autocommit connections to the scratch database. */
  public static DataSource dataSource() {
    return new ScratchDataSource(true);
  }

  /** Creates the {@code account} table that the transaction snippets write. */
  public static void createAccountTable() throws SQLException {
    try (Connection connection = ScratchDatabase.connect();
        Statement statement = connection.createStatement()) {
      statement.execute("CREATE TABLE IF NOT EXISTS account (id text PRIMARY KEY, email text)");
    }
  }

  /** The number of {@code account} rows with {@code id}. */
  public static long accounts(String id) throws SQLException {
    return count("SELECT count(*) FROM account WHERE id = ?", id);
  }

  /** The tasks of {@code taskType} whose payload holds {@code key} with {@code value}. */
  public static List<UUID> tasks(String taskType, String key, String value) throws SQLException {
    try (Connection connection = ScratchDatabase.connect();
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

  /** The one task of {@code taskType} whose payload holds {@code key} with {@code value}. */
  public static TaskDetail task(String taskType, String key, String value) throws SQLException {
    List<UUID> ids = tasks(taskType, key, value);
    assertEquals(1, ids.size(), taskType + " tasks with " + key + "=" + value);
    return detail(ids.get(0));
  }

  /** The detail of one task. */
  public static TaskDetail detail(UUID taskId) {
    return new Admin(ConnectionSource.of(dataSource())).getTask(taskId).orElseThrow();
  }

  /** Waits until the task ends, and returns its detail. */
  public static TaskDetail awaitTerminal(UUID taskId) throws InterruptedException {
    long deadline = System.nanoTime() + WAIT.toNanos();
    while (true) {
      TaskDetail detail = detail(taskId);
      if (detail.state() == TaskState.SUCCEEDED
          || detail.state() == TaskState.FAILED
          || detail.state() == TaskState.CANCELED) {
        return detail;
      }
      assertTrue(System.nanoTime() < deadline, "task " + taskId + " is still " + detail.state());
      Thread.sleep(50);
    }
  }

  /**
   * The JDBC URL of the scratch database with the credentials of {@code DATABASE_URL_TEST} as
   * parameters, for a snippet that builds its own {@code PGSimpleDataSource}.
   */
  public static String jdbcUrl() throws SQLException {
    String url;
    try (Connection connection = ScratchDatabase.connect()) {
      url = connection.getMetaData().getURL();
    }
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

  private static long count(String sql, String argument) throws SQLException {
    try (Connection connection = ScratchDatabase.connect();
        PreparedStatement statement = connection.prepareStatement(sql)) {
      statement.setString(1, argument);
      try (ResultSet result = statement.executeQuery()) {
        result.next();
        return result.getLong(1);
      }
    }
  }
}
