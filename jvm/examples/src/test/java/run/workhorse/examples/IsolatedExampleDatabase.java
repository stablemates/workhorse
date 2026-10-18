package run.workhorse.examples;

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
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import javax.sql.DataSource;
import org.postgresql.ds.PGSimpleDataSource;
import run.workhorse.Admin;
import run.workhorse.ConnectionSource;
import run.workhorse.Queue;
import run.workhorse.TaskDetail;
import run.workhorse.TaskState;
import run.workhorse.testing.ScratchDatabase;

/**
 * An extra scratch database for a snippet that runs a worker on a fixed queue, such as {@code
 * default} or {@code billing}. A worker claims every task of its queues, so in the shared scratch
 * database it would also claim the tasks that other snippet tests leave there. The database also
 * has the {@code orders} table of the quickstart snippets.
 */
public final class IsolatedExampleDatabase implements AutoCloseable {
  private final ScratchDatabase.Extra extra;
  private final String jdbcUrl;

  private IsolatedExampleDatabase(ScratchDatabase.Extra extra, String jdbcUrl) {
    this.extra = extra;
    this.jdbcUrl = jdbcUrl;
  }

  /**
   * Creates the database for {@code purpose}. The test class must extend {@link ScratchDatabase}.
   */
  public static IsolatedExampleDatabase create(String purpose) throws Exception {
    ScratchDatabase.Extra extra = ScratchDatabase.extra(purpose);
    try (Connection connection = extra.connect();
        Statement statement = connection.createStatement()) {
      statement.execute("CREATE TABLE orders (id text PRIMARY KEY, status text)");
      return new IsolatedExampleDatabase(extra, withCredentials(connection.getMetaData().getURL()));
    } catch (Exception error) {
      extra.close();
      throw error;
    }
  }

  /** The JDBC URL of the database, with the credentials of {@code DATABASE_URL_TEST}. */
  public String jdbcUrl() {
    return jdbcUrl;
  }

  /** A source of autocommit connections to the database. */
  public DataSource dataSource() {
    PGSimpleDataSource dataSource = new PGSimpleDataSource();
    dataSource.setURL(jdbcUrl);
    return dataSource;
  }

  /** A queue on the database. */
  public Queue queue() {
    return new Queue(ConnectionSource.of(dataSource()));
  }

  /** An admin client on the database. */
  public Admin admin() {
    return new Admin(ConnectionSource.of(dataSource()));
  }

  /** A new connection to the database. */
  public Connection connect() throws SQLException {
    return extra.connect();
  }

  /** The detail of one task in this database. */
  public TaskDetail detail(UUID taskId) {
    return admin().getTask(taskId).orElseThrow();
  }

  /** Waits until the task in this database ends, and returns its detail. */
  public TaskDetail awaitTerminal(UUID taskId) throws InterruptedException {
    long deadline = System.nanoTime() + ExampleDatabase.WAIT.toNanos();
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

  /** The tasks of {@code taskType} whose payload holds {@code key} with {@code value}. */
  public List<UUID> tasks(String taskType, String key, String value) throws SQLException {
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

  /** The number of {@code orders} rows with {@code id}. */
  public long orders(String id) throws SQLException {
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

  /** The number of {@code task_type} tasks whose payload holds {@code orderId}. */
  public long orderTasks(String taskType, String orderId) throws SQLException {
    try (Connection connection = extra.connect();
        PreparedStatement statement =
            connection.prepareStatement(
                "SELECT count(*) FROM workhorse.task WHERE task_type = ? AND payload ->> 'orderId' = ?")) {
      statement.setString(1, taskType);
      statement.setString(2, orderId);
      try (ResultSet result = statement.executeQuery()) {
        result.next();
        return result.getLong(1);
      }
    }
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
