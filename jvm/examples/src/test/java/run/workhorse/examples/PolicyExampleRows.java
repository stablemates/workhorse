package run.workhorse.examples;

import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Statement;
import java.util.List;
import java.util.UUID;
import org.jspecify.annotations.Nullable;
import run.workhorse.testing.ScratchDatabase;

/**
 * Reads and resets the rows that the snippets of the concurrency-policy, multi-tenancy, and
 * payload-contract pages write.
 */
public final class PolicyExampleRows {
  private PolicyExampleRows() {}

  /** The budget that the task names, or {@code null}. */
  public static @Nullable String budgetName(UUID taskId) throws SQLException {
    try (Connection connection = ScratchDatabase.connect();
        PreparedStatement statement =
            connection.prepareStatement("SELECT budget_name FROM workhorse.task WHERE id = ?")) {
      statement.setObject(1, taskId);
      try (ResultSet result = statement.executeQuery()) {
        if (!result.next()) {
          throw new IllegalStateException("no task " + taskId);
        }
        return result.getString(1);
      }
    }
  }

  /** The newest task of {@code taskType} whose payload holds {@code key} with {@code value}. */
  public static UUID newestTask(String taskType, String key, String value) throws SQLException {
    List<UUID> ids = ExampleDatabase.tasks(taskType, key, value);
    if (ids.isEmpty()) {
      throw new IllegalStateException("no " + taskType + " task with " + key + "=" + value);
    }
    return ids.get(ids.size() - 1);
  }

  /**
   * Removes the contract policy of {@code mail.send}, so the snippets of other pages can enqueue
   * {@code mail.send} with other payloads. The contract documents stay, because PostgreSQL keeps
   * them immutable.
   */
  public static void removeMailContract() throws SQLException {
    try (Connection connection = ScratchDatabase.connect();
        Statement statement = connection.createStatement()) {
      statement.execute("DELETE FROM workhorse.contract_policy WHERE task_type = 'mail.send'");
    }
  }
}
