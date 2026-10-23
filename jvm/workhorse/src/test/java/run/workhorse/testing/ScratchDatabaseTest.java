package run.workhorse.testing;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;

import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;

/**
 * The per-process schema template has no connected session, so {@code pnpm db:sweep} relies on its
 * advisory lock to see that the process still uses it (SM-1689).
 */
@ExtendWith(ScratchDatabase.class)
class ScratchDatabaseTest {
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
}
