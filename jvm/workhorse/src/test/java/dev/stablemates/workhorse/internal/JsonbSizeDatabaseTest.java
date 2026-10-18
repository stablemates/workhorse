package dev.stablemates.workhorse.internal;

import static org.junit.jupiter.api.Assertions.assertEquals;

import dev.stablemates.workhorse.testing.ScratchDatabase;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.util.List;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;

/** {@link JsonbSize} against the length of PostgreSQL's own {@code jsonb} text. */
@ExtendWith(ScratchDatabase.class)
class JsonbSizeDatabaseTest {
  private static final List<String> DOCUMENTS =
      List.of(
          "null",
          "true",
          "false",
          "0",
          "-0",
          "-0.0",
          "12",
          "-12",
          "1.50",
          "1e2",
          "1E-2",
          "1.5e1",
          "0.000",
          "123.456e-1",
          "\"plain\"",
          "\"quote \\\" and backslash \\\\\"",
          "\"tab\\t newline\\n bell\\u0007\"",
          "\"café \\u00e9 \\ud83d\\ude00 中\"",
          "\"\\/slash\"",
          "[]",
          "{}",
          "[1, 2, [3, {}]]",
          "{\"b\": 1, \"a\": [true, null]}",
          "{\"k\": 1, \"k\": \"last wins\"}",
          " { \"spaced\" : [ 1 , 2 ] } ");

  @Test
  void measuresWhatPostgreSqlStores() throws SQLException {
    try (Connection connection = ScratchDatabase.connect();
        PreparedStatement statement =
            connection.prepareStatement("SELECT octet_length((?::jsonb)::text)")) {
      for (String document : DOCUMENTS) {
        statement.setString(1, document);
        try (ResultSet result = statement.executeQuery()) {
          result.next();
          assertEquals(result.getLong(1), JsonbSize.of(document), document);
        }
      }
    }
  }
}
