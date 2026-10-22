package run.workhorse.internal;

import static org.junit.jupiter.api.Assertions.assertEquals;
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
    // sync_rate_limit_policies_v1 takes no such p_prune argument.
    SqlCatalogue.Statement statement = SqlCatalogue.SYNC_RATE_LIMIT_POLICIES_V1__QUEUE;
    try (Connection connection = ScratchDatabase.connect();
        PreparedStatement prepared = connection.prepareStatement(statement.sql())) {
      // With stringtype=unspecified in DATABASE_URL_TEST, setString sends an untyped value too.
      assumeTrue(
          connection.unwrap(BaseConnection.class).getStringVarcharFlag(),
          "DATABASE_URL_TEST sets stringtype=unspecified");
      prepared.setString(1, "sql-" + UUID.randomUUID());
      prepared.setString(2, "[]");
      prepared.setString(3, "true");
      SQLException error = assertThrows(SQLException.class, prepared::executeQuery);
      assertEquals("42883", error.getSQLState());
    }
  }
}
