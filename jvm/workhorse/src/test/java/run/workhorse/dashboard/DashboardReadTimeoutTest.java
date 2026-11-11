package run.workhorse.dashboard;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.sql.Connection;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import run.workhorse.ConnectionSource;
import run.workhorse.testing.ScratchDatabase;

/** A read that PostgreSQL cancels answers TIMEOUT, also inside a caller transaction. */
@ExtendWith(ScratchDatabase.class)
class DashboardReadTimeoutTest {
  private static final String SLOW_EVENTS =
      "CREATE OR REPLACE FUNCTION workhorse.dashboard_events_v1(p_input jsonb) RETURNS jsonb"
          + " LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(1); RETURN '{}'::jsonb; END $$";

  @Test
  void answersTimeoutForACanceledReadInsideACallerTransaction() throws Exception {
    try (ScratchDatabase.Extra database = ScratchDatabase.extra("dashboard_read_timeout");
        Connection connection = database.connect()) {
      try (var statement = connection.createStatement()) {
        statement.execute(SLOW_EVENTS);
      }
      ConnectionSource source =
          new ConnectionSource() {
            @Override
            public Connection acquire() {
              return connection;
            }

            @Override
            public void release(Connection released, boolean transactional) {}
          };
      Dashboard host =
          Dashboard.builder(source, request -> DashboardAuthorization.principal("operator"))
              .build();
      try (TestServer server = new TestServer("", host)) {
        assertEquals(200, server.post("/workhorse/rpc/dashboard/meta", "{\"json\":null}").status());
        connection.setAutoCommit(false);
        try {
          try (var statement = connection.createStatement()) {
            statement.execute("SET LOCAL statement_timeout = '50ms'");
          }
          var response =
              server.post("/workhorse/rpc/dashboard/events", "{\"json\":{\"window\":\"1h\"}}");
          assertEquals(408, response.status(), response.text());
          assertTrue(response.text().contains("\"code\":\"TIMEOUT\""), response.text());
        } finally {
          connection.rollback();
          connection.setAutoCommit(true);
        }
      }
    }
  }

  @Test
  void leavesARawCallerTransactionInAutocommitAsItWas() throws Exception {
    try (ScratchDatabase.Extra database =
            ScratchDatabase.extra("dashboard_raw_caller_transaction");
        Connection connection = database.connect()) {
      ConnectionSource source =
          new ConnectionSource() {
            @Override
            public Connection acquire() {
              return connection;
            }

            @Override
            public void release(Connection released, boolean transactional) {}
          };
      Dashboard host =
          Dashboard.builder(source, request -> DashboardAuthorization.principal("operator"))
              .build();
      try (TestServer server = new TestServer("", host)) {
        assertEquals(200, server.post("/workhorse/rpc/dashboard/meta", "{\"json\":null}").status());
        try (var statement = connection.createStatement()) {
          statement.execute("CREATE TABLE raw_caller_marker (id integer)");
          // A raw BEGIN opens a caller transaction while the connection stays in autocommit.
          statement.execute("BEGIN");
          statement.execute("INSERT INTO raw_caller_marker VALUES (1)");
        }

        var response = server.post("/workhorse/rpc/dashboard/queues", "{\"json\":null}");

        assertEquals(200, response.status(), response.text());
        try (var statement = connection.createStatement()) {
          // The caller's transaction is still open and read-write, with its insert.
          statement.execute("INSERT INTO raw_caller_marker VALUES (2)");
          try (var rows = statement.executeQuery("SELECT count(*) FROM raw_caller_marker")) {
            assertTrue(rows.next());
            assertEquals(2, rows.getInt(1), "the read ended the caller's transaction");
          }
          statement.execute("ROLLBACK");
          try (var rows = statement.executeQuery("SELECT count(*) FROM raw_caller_marker")) {
            assertTrue(rows.next());
            assertEquals(0, rows.getInt(1), "the read committed the caller's insert");
          }
        }
      }
    }
  }
}
