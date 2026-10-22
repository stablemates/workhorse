package run.workhorse;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.time.Duration;
import java.util.List;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.extension.ExtendWith;
import run.workhorse.testing.ScratchDatabase;

/**
 * SM-1585: a {@code DataSource} reports no pool size. With {@code sharedHeartbeats(true)} and no
 * declared size, the worker does not know whether the listener would hold the only connection, so
 * it starts no listener, polls, and logs one warning. It never probes the pool.
 */
@ExtendWith(ScratchDatabase.class)
@Timeout(value = 120, unit = TimeUnit.SECONDS)
class WorkerOpaquePoolListenerDatabaseTest {
  private static final String UNKNOWN = "workhorse.worker.pool_max_size=unknown";

  @Test
  void pollsOnOpaquePoolsOfOneAndTwo() throws Exception {
    SmallPoolRun.Warnings warnings = new SmallPoolRun.Warnings();
    for (int size : List.of(1, 2)) {
      SmallPoolRun run = new SmallPoolRun(size, warnings);
      try {
        run.completeThreeTasks();
        assertEquals(0, run.listens.get(), "no listener on a pool of " + size);
      } finally {
        run.close();
      }
    }
    List<String> logged = warnings.pollingOnly();
    assertEquals(2, logged.size(), "one warning for each run: " + logged);
    assertTrue(logged.stream().allMatch(message -> message.contains(UNKNOWN)), logged.toString());
  }

  /**
   * A pool of 1 that waits 10 minutes for a connection, behind a view that is only a {@code
   * DataSource}. A listener on it would hold the only connection, and every other borrow would wait
   * the 10 minutes. The worker never borrows to learn the size, so the test stays fast.
   */
  @Test
  void pollsFastOnAnOpaquePoolOfOneWithALongAcquisitionTimeout() throws Exception {
    SmallPoolRun.Warnings warnings = new SmallPoolRun.Warnings();
    SmallPoolRun run = new SmallPoolRun(1, Duration.ofMinutes(10), warnings);
    try {
      long started = System.nanoTime();
      run.completeThreeTasks(run.opaque(), builder -> builder);
      assertTrue(
          System.nanoTime() - started < TimeUnit.SECONDS.toNanos(20), "the run did not stay fast");
      assertEquals(0, run.listens.get(), "no listener on the opaque pool");
    } finally {
      run.close();
    }
    List<String> logged = warnings.pollingOnly();
    assertEquals(1, logged.size(), logged.toString());
    assertTrue(logged.get(0).contains(UNKNOWN), logged.get(0));
  }
}
