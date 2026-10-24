package run.workhorse.testing;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;

import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.Statement;
import org.junit.jupiter.api.Test;
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
}
