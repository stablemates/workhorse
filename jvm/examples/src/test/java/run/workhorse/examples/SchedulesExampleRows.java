package run.workhorse.examples;

import static org.junit.jupiter.api.Assertions.assertTrue;

import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.jspecify.annotations.Nullable;
import run.workhorse.testing.ScratchDatabase;

/** Reads the schedule rows and the fired tasks for the schedule snippet tests. */
final class SchedulesExampleRows {
  private SchedulesExampleRows() {}

  /** The stored columns of one schedule definition, or an empty map if it does not exist. */
  static Map<String, @Nullable Object> definition(String namespace, String name)
      throws SQLException {
    try (Connection connection = ScratchDatabase.connect();
        PreparedStatement statement =
            connection.prepareStatement(
                "SELECT cron_expression, timezone, queue_name, task_type,"
                    + " payload ->> 'scope' AS scope, configured_enabled"
                    + " FROM workhorse.schedule_definition"
                    + " WHERE namespace = ? AND schedule_name = ?")) {
      statement.setString(1, namespace);
      statement.setString(2, name);
      Map<String, @Nullable Object> row = new LinkedHashMap<>();
      try (ResultSet result = statement.executeQuery()) {
        if (result.next()) {
          for (String column :
              List.of(
                  "cron_expression",
                  "timezone",
                  "queue_name",
                  "task_type",
                  "scope",
                  "configured_enabled")) {
            row.put(column, result.getObject(column));
          }
        }
      }
      return row;
    }
  }

  /**
   * Waits until a task of {@code taskType} with the payload {@code scope} exists in {@code
   * database}.
   */
  static UUID awaitTask(IsolatedExampleDatabase database, String taskType, String scope)
      throws SQLException, InterruptedException {
    long deadline = System.nanoTime() + ExampleDatabase.WAIT.toNanos();
    while (true) {
      List<UUID> ids = database.tasks(taskType, "scope", scope);
      if (!ids.isEmpty()) {
        return ids.get(0);
      }
      assertTrue(System.nanoTime() < deadline, "no " + taskType + " task with scope " + scope);
      Thread.sleep(100);
    }
  }
}
