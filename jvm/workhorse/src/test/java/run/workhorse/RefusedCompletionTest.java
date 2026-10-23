package run.workhorse;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.lang.reflect.Proxy;
import java.sql.SQLException;
import java.util.UUID;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import javax.sql.DataSource;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;

/**
 * SM-1649: a heartbeat round that read the membership before the release can settle the attempt
 * while PostgreSQL refuses its completion. The refused completion and that round take the attempt's
 * settlement lock, so the first one decides. These cases need no database: the data source refuses
 * every connection, so a statement fails the case.
 */
@Timeout(value = 30, unit = TimeUnit.SECONDS)
class RefusedCompletionTest {
  private final Worker worker = Worker.builder(refusingDataSource()).queues("default").build();
  private final ClaimedTask task =
      new ClaimedTask(
          UUID.randomUUID(),
          "default",
          "sample",
          0,
          null,
          null,
          null,
          false,
          null,
          1,
          1,
          null,
          null,
          null,
          null,
          7,
          null);
  private final Worker.Ownership ownership =
      new Worker.Ownership(System.nanoTime(), TimeUnit.SECONDS.toNanos(30));
  private final Worker.Arbiter arbiter = new Worker.Arbiter();

  private static DataSource refusingDataSource() {
    return (DataSource)
        Proxy.newProxyInstance(
            DataSource.class.getClassLoader(),
            new Class<?>[] {DataSource.class},
            (proxy, method, arguments) -> {
              if (method.getName().equals("getConnection")) {
                throw new SQLException("the case sent a statement");
              }
              return null;
            });
  }

  @Test
  void waitsForAHeartbeatSettlementThatHoldsTheLockAndFinishesWithItsOutcome() throws Exception {
    AtomicReference<Throwable> failure = new AtomicReference<>();
    Thread reconciliation =
        Thread.ofPlatform()
            .unstarted(
                () -> {
                  try {
                    worker.reconcileRejectedCompletion(task, ownership, arbiter);
                  } catch (Throwable error) {
                    failure.set(error);
                  }
                });
    ownership.settlement.lock();
    try {
      reconciliation.start();
      while (!ownership.settlement.hasQueuedThread(reconciliation) && reconciliation.isAlive()) {
        Thread.onSpinWait();
      }
      assertTrue(reconciliation.isAlive(), "the reconciliation did not wait for the lock");
      arbiter.submit(Worker.Outcome.ATTEMPT_TIMEOUT);
    } finally {
      ownership.settlement.unlock();
    }
    reconciliation.join();

    assertEquals(null, failure.get());
    assertEquals(Worker.Outcome.ATTEMPT_TIMEOUT, arbiter.outcome());
  }

  @Test
  void throwsTheLostLeaseOfAHeartbeatSettlementThatDecidedFirst() {
    arbiter.submit(Worker.Outcome.LEASE_EXPIRED);
    LeaseLostException error =
        assertThrows(
            LeaseLostException.class,
            () -> worker.reconcileRejectedCompletion(task, ownership, arbiter));
    assertEquals("heartbeat", error.operation());
  }
}
