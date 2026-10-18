package run.workhorse.internal;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.SQLException;
import java.util.List;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.postgresql.core.BaseConnection;
import run.workhorse.testing.ScratchDatabase;

/**
 * {@link Sql} runs the catalogue statements that have a {@code ?} with no cast. PostgreSQL infers
 * the type of each such {@code ?} from its context, because the runner binds text as an untyped
 * parameter.
 */
@ExtendWith(ScratchDatabase.class)
class SqlDatabaseTest {
  private static final List<String> RETENTION_COLUMNS =
      List.of(
          "terminal_tasks", "task_events", "attempt_history", "schedule_occurrences", "statistics");

  @Test
  void previewsRetentionWithAnIntegerAtEachReuseOfAParameter() throws SQLException {
    try (Connection connection = ScratchDatabase.connect()) {
      List<Row> rows =
          Sql.rows(
              connection, SqlCatalogue.RETENTION_POLICY_PREVIEW, "30", "7", "30", "30", "30", "90");
      assertEquals(1, rows.size());
      for (String column : RETENTION_COLUMNS) {
        assertNotNull(rows.get(0).integer(column), column);
      }
    }
  }

  @Test
  void previewsRetentionWithAnUntypedNullAtEachReuseOfAParameter() throws SQLException {
    try (Connection connection = ScratchDatabase.connect()) {
      List<Row> rows =
          Sql.rows(
              connection,
              SqlCatalogue.RETENTION_POLICY_PREVIEW,
              null,
              null,
              null,
              null,
              null,
              null);
      for (String column : RETENTION_COLUMNS) {
        assertEquals(0, rows.get(0).integer(column), column);
      }
    }
  }

  @Test
  void syncsRateLimitPoliciesWithAnUncastTextAndBoolean() throws SQLException {
    String namespace = "sql-" + UUID.randomUUID();
    String queue = "sql-" + UUID.randomUUID();
    String document =
        "[{\"queue\":\""
            + queue
            + "\",\"rate\":{\"limit\":10,\"intervalMs\":1000,\"burst\":20},\"perKey\":null}]";
    try (Connection connection = ScratchDatabase.connect()) {
      List<Row> stored =
          Sql.rows(
              connection,
              SqlCatalogue.SYNC_RATE_LIMIT_POLICIES_V1__QUEUE,
              namespace,
              document,
              "false");
      assertEquals(1, stored.size());
      assertEquals(namespace, stored.get(0).requiredText("namespace"));
      assertEquals(queue, stored.get(0).requiredText("queue_name"));
      assertEquals(
          List.of(),
          Sql.rows(
              connection,
              SqlCatalogue.SYNC_RATE_LIMIT_POLICIES_V1__QUEUE,
              namespace,
              "[]",
              "true"));
    }
  }

  @Test
  void aCharacterVaryingParameterFailsWhereAnUntypedOneSucceeds() throws SQLException {
    // The binding before SM-1418. PostgreSQL types the uncast `?` as character varying, and
    // make_interval takes no such argument.
    SqlCatalogue.Statement statement = SqlCatalogue.RETENTION_POLICY_PREVIEW;
    try (Connection connection = ScratchDatabase.connect();
        PreparedStatement prepared = connection.prepareStatement(statement.sql())) {
      // With stringtype=unspecified in DATABASE_URL_TEST, setString sends an untyped value too.
      assumeTrue(
          connection.unwrap(BaseConnection.class).getStringVarcharFlag(),
          "DATABASE_URL_TEST sets stringtype=unspecified");
      for (int placeholder = 1; placeholder <= statement.placeholderCount(); placeholder++) {
        prepared.setString(placeholder, "30");
      }
      SQLException error = assertThrows(SQLException.class, prepared::executeQuery);
      assertEquals("42883", error.getSQLState());
    }
  }
}
