package run.workhorse.testing;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.Statement;
import java.util.ArrayList;
import java.util.List;
import org.junit.jupiter.api.MethodOrderer;
import org.junit.jupiter.api.Nested;
import org.junit.jupiter.api.Order;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.TestMethodOrder;
import org.junit.jupiter.api.extension.ExtendWith;

/** The scratch databases of the JVM tests. */
@ExtendWith(ScratchDatabase.class)
class ScratchDatabaseTest {
  /**
   * The per-process schema template has no connected session, so {@code pnpm db:sweep} relies on
   * its advisory lock to see that the process still uses it (SM-1689).
   */
  @Test
  void holdsTheTemplateLockSoTheSweepSkipsTheTemplate() throws Exception {
    try (ScratchDatabase.Extra extra = ScratchDatabase.extra("template_lock")) {
      assertNotNull(extra.name());
    }
    String template = ScratchDatabase.templateName();
    assertNotNull(template);
    // The sweep takes this lock with no wait before it drops a database.
    try (Connection sweep = ScratchDatabase.connectAdmin();
        PreparedStatement lock =
            sweep.prepareStatement(
                "SELECT pg_try_advisory_lock(hashtextextended(?, 0)) AS locked")) {
      lock.setString(1, template);
      try (ResultSet result = lock.executeQuery()) {
        result.next();
        assertFalse(
            result.getBoolean("locked"), "the sweep could take the lock of the live template");
      }
    }
  }

  /**
   * A test can have no session on the scratch database or on an extra database, so {@code pnpm
   * db:sweep} relies on their advisory locks too (SM-1702). The lock of an extra database ends with
   * its drop.
   */
  @Test
  void holdsTheLockOfTheScratchAndExtraDatabasesUntilTheirDrop() throws Exception {
    String main;
    try (Connection connection = ScratchDatabase.connect();
        Statement statement = connection.createStatement();
        ResultSet result = statement.executeQuery("SELECT current_database()")) {
      result.next();
      main = result.getString(1);
    }
    assertFalse(sweepLocks(main), "the sweep could take the lock of the live scratch database");
    String extraName;
    try (ScratchDatabase.Extra extra = ScratchDatabase.extra("sweep_lease")) {
      extraName = extra.name();
      assertFalse(sweepLocks(extraName), "the sweep could take the lock of a live extra database");
    }
    assertTrue(sweepLocks(extraName), "the lock of the extra database outlived its drop");
  }

  /** Whether the sweep's lock attempt on {@code name} succeeds. The lock ends with the session. */
  private static boolean sweepLocks(String name) throws Exception {
    try (Connection sweep = ScratchDatabase.connectAdmin();
        PreparedStatement lock =
            sweep.prepareStatement(
                "SELECT pg_try_advisory_lock(hashtextextended(?, 0)) AS locked")) {
      lock.setString(1, name);
      try (ResultSet result = lock.executeQuery()) {
        result.next();
        return result.getBoolean("locked");
      }
    }
  }

  /**
   * A host I/O stall can make a WAL flush take seconds, so a commit in a test does not wait for it
   * (SM-1804). A new session of the scratch database and of an extra database takes the setting.
   */
  @Test
  void commitsWithoutWaitingForTheWalFlush() throws Exception {
    try (Connection connection = ScratchDatabase.connect()) {
      assertEquals("off", synchronousCommit(connection), "the scratch database");
    }
    try (ScratchDatabase.Extra extra = ScratchDatabase.extra("synchronous_commit");
        Connection connection = extra.connect()) {
      assertEquals("off", synchronousCommit(connection), "the extra database");
    }
  }

  private static String synchronousCommit(Connection connection) throws Exception {
    try (Statement statement = connection.createStatement();
        ResultSet result = statement.executeQuery("SHOW synchronous_commit")) {
      result.next();
      return result.getString(1);
    }
  }

  /**
   * All test classes share one scratch database, so a reset before each test returns it to its
   * install state (SM-1732).
   */
  @Test
  void theResetEmptiesTheRowsAndReturnsTheRoutineStateAndThePolicyRows() throws Exception {
    try (Connection connection = ScratchDatabase.connect();
        Statement statement = connection.createStatement()) {
      String installed = text(statement, ScratchDatabase.POLICY_SNAPSHOT);
      statement.execute(
          "INSERT INTO workhorse.queue_control(queue_name, paused) VALUES ('jvm-leftover', true)");
      statement.execute(
          """
          UPDATE workhorse.maintenance_state SET
            last_started_at = clock_timestamp(),
            last_completed_at = clock_timestamp(),
            last_completed_local_date = CASE WHEN routine_name = 'history_retention'
              THEN current_date END,
            history_retained_before = CASE WHEN routine_name = 'history_retention'
              THEN clock_timestamp() END,
            terminal_prune_dependency_starved = routine_name = 'terminal_storage',
            terminal_prune_fast_first = true,
            terminal_cleanup_backlog_since = clock_timestamp(),
            lease_recovery_started_at = clock_timestamp(),
            updated_at = timestamptz '2000-01-01 00:00:00+00'
          """);
      statement.execute("UPDATE workhorse.maintenance_policy SET timezone = 'Europe/Berlin'");
      statement.execute("UPDATE workhorse.queue_health_policy SET promotion_lag_ms = 1");
      statement.execute("UPDATE workhorse.retention_policy SET terminal_task_prune_limit = 1");

      ScratchDatabase.reset(connection);

      assertEquals("0", text(statement, "SELECT count(*) FROM workhorse.queue_control"));
      assertEquals(
          List.of("history_partitions|t", "history_retention|t", "terminal_storage|t", "tick|t"),
          rows(
                  statement,
                  """
              SELECT routine_name || '|' || (
                last_started_at IS NULL AND last_completed_at IS NULL
                AND last_completed_local_date IS NULL
                AND CASE WHEN routine_name = 'history_retention'
                  THEN history_retained_before IN (
                    date_trunc('day', clock_timestamp() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
                      - interval '14 days',
                    date_trunc('day', clock_timestamp() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
                      - interval '15 days')
                  ELSE history_retained_before IS NULL END
                AND NOT terminal_prune_dependency_starved AND NOT terminal_prune_fast_first
                AND terminal_cleanup_backlog_since IS NULL AND lease_recovery_started_at IS NULL
                AND updated_at > timestamptz '2001-01-01 00:00:00+00')::text
                FROM workhorse.maintenance_state ORDER BY routine_name
              """)
              .stream()
              .map(row -> row.replace("|true", "|t").replace("|false", "|f"))
              .toList());
      assertEquals(installed, text(statement, ScratchDatabase.POLICY_SNAPSHOT));
      assertEquals(
          "UTC|10000|1000",
          text(
              statement,
              "SELECT m.timezone || '|' || q.promotion_lag_ms || '|' || r.terminal_task_prune_limit"
                  + " FROM workhorse.maintenance_policy m, workhorse.queue_health_policy q,"
                  + " workhorse.retention_policy r"));
    }
  }

  /** A new maintenance_state column needs a value in the reset (SM-1717). */
  @Test
  void theResetKnowsEveryColumnOfMaintenanceState() throws Exception {
    try (Connection connection = ScratchDatabase.connect();
        Statement statement = connection.createStatement()) {
      assertEquals(
          ScratchDatabase.MAINTENANCE_COLUMNS,
          rows(
              statement,
              "SELECT column_name FROM information_schema.columns WHERE table_schema = 'workhorse'"
                  + " AND table_name = 'maintenance_state' ORDER BY column_name"));
    }
  }

  /** The extension resets the database before each test, so the second test sees no leftovers. */
  @Nested
  @TestMethodOrder(MethodOrderer.OrderAnnotation.class)
  class InAFixedOrder {
    @Test
    @Order(1)
    void leavesARowAndRoutineStateBehind() throws Exception {
      try (Connection connection = ScratchDatabase.connect();
          Statement statement = connection.createStatement()) {
        statement.execute(
            "INSERT INTO workhorse.queue_control(queue_name, paused) VALUES ('jvm-order', true)");
        statement.execute(
            "UPDATE workhorse.maintenance_state SET terminal_prune_fast_first = true");
      }
    }

    @Test
    @Order(2)
    void startsTheNextTestWithoutThem() throws Exception {
      try (Connection connection = ScratchDatabase.connect();
          Statement statement = connection.createStatement()) {
        assertEquals("0", text(statement, "SELECT count(*) FROM workhorse.queue_control"));
        assertEquals(
            "false",
            text(
                statement,
                "SELECT bool_or(terminal_prune_fast_first)::text FROM workhorse.maintenance_state"));
      }
    }
  }

  private static String text(Statement statement, String sql) throws Exception {
    try (ResultSet result = statement.executeQuery(sql)) {
      result.next();
      return result.getString(1);
    }
  }

  private static List<String> rows(Statement statement, String sql) throws Exception {
    List<String> rows = new ArrayList<>();
    try (ResultSet result = statement.executeQuery(sql)) {
      while (result.next()) {
        rows.add(result.getString(1));
      }
    }
    return rows;
  }
}
