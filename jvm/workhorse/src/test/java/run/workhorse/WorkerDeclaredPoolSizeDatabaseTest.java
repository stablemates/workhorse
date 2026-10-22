package run.workhorse;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.List;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.extension.ExtendWith;
import run.workhorse.testing.ScratchDatabase;

/**
 * SM-1585: {@code poolMaxSize} declares the size that a {@code DataSource} does not report. With
 * {@code sharedHeartbeats(true)}, a declared size of at least 2 keeps the shared listener, and a
 * declared size of 1 polls. Without the opt-out, a declared size below 3 refuses the build.
 */
@ExtendWith(ScratchDatabase.class)
@Timeout(value = 120, unit = TimeUnit.SECONDS)
class WorkerDeclaredPoolSizeDatabaseTest {
  @Test
  void pollsOnADeclaredPoolOfOneAndListensOnADeclaredPoolOfTwo() throws Exception {
    SmallPoolRun.Warnings warnings = new SmallPoolRun.Warnings();
    SmallPoolRun single = new SmallPoolRun(1, warnings);
    try {
      single.completeThreeTasks(single.pool, builder -> builder.poolMaxSize(1));
      assertEquals(0, single.listens.get(), "no listener on a declared pool of 1");
    } finally {
      single.close();
    }
    List<String> logged = warnings.pollingOnly();
    assertEquals(1, logged.size(), logged.toString());
    assertTrue(logged.get(0).contains("workhorse.worker.pool_max_size=1"), logged.get(0));

    SmallPoolRun pair = new SmallPoolRun(2, warnings);
    try {
      pair.completeThreeTasks(pair.pool, builder -> builder.poolMaxSize(2), true);
      assertEquals(1, pair.listens.get(), "one shared listener on a declared pool of 2");
    } finally {
      pair.close();
    }
    assertEquals(1, warnings.pollingOnly().size(), warnings.pollingOnly().toString());
  }

  @Test
  void refusesADeclaredPoolBelowThreeWithoutTheOptOut() {
    SmallPoolRun run = new SmallPoolRun(2, new SmallPoolRun.Warnings());
    try {
      IllegalArgumentException refusal =
          assertThrows(
              IllegalArgumentException.class,
              () -> run.worker(run.pool).sharedHeartbeats(false).poolMaxSize(2).build());
      assertEquals(
          "Worker pool capacity must be at least 3 (found 2); set sharedHeartbeats(true) to opt out",
          refusal.getMessage());
      run.worker(run.pool).sharedHeartbeats(false).poolMaxSize(3).build();
      assertThrows(IllegalArgumentException.class, () -> run.worker(run.pool).poolMaxSize(0));
    } finally {
      run.close();
    }
  }
}
