package run.workhorse;

import static org.junit.jupiter.api.Assertions.assertEquals;

import java.util.function.UnaryOperator;
import org.junit.jupiter.api.Test;
import run.workhorse.testing.ScratchDataSource;

/**
 * SM-1668 PAR-07: a {@code DataSource} reports no pool size, so only {@code poolMaxSize} can cap
 * the default cohorts. The cap is the declared size minus the listener and the heartbeat
 * connection. An explicit cohort count is never capped. Building a worker opens no connection.
 */
class WorkerCohortsTest {
  private static int cohorts(int concurrency, UnaryOperator<Worker.Builder> options) {
    return options
        .apply(Worker.builder(new ScratchDataSource(true)).queues("default"))
        .concurrency(concurrency)
        .build()
        .cohorts();
  }

  @Test
  void aDeclaredPoolSizeCapsTheDefaultAfterTheListenerAndTheHeartbeatConnection() {
    assertEquals(2, cohorts(64, builder -> builder.poolMaxSize(4)));
    assertEquals(1, cohorts(64, builder -> builder.poolMaxSize(3)));
    assertEquals(4, cohorts(64, builder -> builder.poolMaxSize(6)));
    assertEquals(8, cohorts(64, builder -> builder.poolMaxSize(10)));
    assertEquals(8, cohorts(64, builder -> builder.poolMaxSize(50)));
    assertEquals(1, cohorts(4, builder -> builder.poolMaxSize(50)));
  }

  @Test
  void pollingOnlyAndSharedHeartbeatsReserveNoConnection() {
    assertEquals(3, cohorts(64, builder -> builder.poolMaxSize(4).pollingOnly(true)));
    assertEquals(3, cohorts(64, builder -> builder.poolMaxSize(4).sharedHeartbeats(true)));
    assertEquals(
        4, cohorts(64, builder -> builder.poolMaxSize(4).sharedHeartbeats(true).pollingOnly(true)));
    // Under the opt-out, a declared size of 1 lends no listener, so the worker polls.
    assertEquals(1, cohorts(64, builder -> builder.poolMaxSize(1).sharedHeartbeats(true)));
    assertEquals(1, cohorts(64, builder -> builder.poolMaxSize(2).sharedHeartbeats(true)));
  }

  @Test
  void anExplicitCountAndAnUnknownSizeStayUncapped() {
    assertEquals(8, cohorts(64, builder -> builder.poolMaxSize(4).cohorts(8)));
    assertEquals(64, cohorts(64, builder -> builder.poolMaxSize(3).cohorts(64)));
    assertEquals(8, cohorts(64, builder -> builder));
    assertEquals(8, cohorts(64, builder -> builder.sharedHeartbeats(true)));
  }
}
