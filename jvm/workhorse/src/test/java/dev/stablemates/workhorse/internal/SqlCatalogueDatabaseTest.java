package dev.stablemates.workhorse.internal;

import static org.junit.jupiter.api.Assertions.assertEquals;

import dev.stablemates.workhorse.testing.ScratchDatabase;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.SQLException;
import org.junit.jupiter.api.DynamicTest;
import org.junit.jupiter.api.TestFactory;
import org.junit.jupiter.api.extension.ExtendWith;

/**
 * PostgreSQL parses and describes every catalogue statement in its JDBC form. A failure names a
 * statement whose {@code ?} rewrite, parameter types, or casts PgJDBC cannot send.
 */
@ExtendWith(ScratchDatabase.class)
class SqlCatalogueDatabaseTest {
  @TestFactory
  Iterable<DynamicTest> describesEveryStatementOverJdbc() {
    return SqlCatalogue.STATEMENTS.stream()
        .map(
            statement ->
                DynamicTest.dynamicTest(statement.name(), () -> assertDescribes(statement)))
        .toList();
  }

  private static void assertDescribes(SqlCatalogue.Statement statement) throws SQLException {
    try (Connection connection = ScratchDatabase.connect();
        PreparedStatement prepared = connection.prepareStatement(statement.sql())) {
      // PgJDBC sends a Parse and a Describe for the parameter metadata, so the server checks the
      // statement without running it.
      assertEquals(
          statement.placeholderCount(), prepared.getParameterMetaData().getParameterCount());
    }
  }
}
