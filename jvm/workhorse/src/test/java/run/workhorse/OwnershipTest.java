package run.workhorse;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.Test;

/** The local lease window of one attempt, and the accepted heartbeat answers that renew it. */
class OwnershipTest {
  private static final long LEASE = TimeUnit.MILLISECONDS.toNanos(100);

  /**
   * SM-1443: an accepted answer can arrive after the window ended and before a delayed watchdog
   * runs. It renews nothing, and it ends the attempt with a lost lease, as the watchdog would.
   */
  @Test
  void anAcceptedAnswerAfterTheWindowEndedDoesNotRenewAndEndsTheAttempt() {
    long now = System.nanoTime();
    Worker.Ownership ownership = new Worker.Ownership(now - LEASE - 1, LEASE);
    Worker.Arbiter arbiter = new Worker.Arbiter();
    TaskCancellation cancellation = new TaskCancellation();
    long deadline = ownership.leaseDeadline();

    Worker.acceptRenewal(ownership, arbiter, cancellation, now);

    assertEquals(deadline, ownership.leaseDeadline(), "the late answer moved the window");
    assertEquals(Worker.Outcome.LEASE_EXPIRED, arbiter.outcome());
    assertEquals(CancellationReason.LEASE_LOST, cancellation.reason());
    assertEquals(0, ownership.stop.getCount(), "the attempt still renews");
    // The window is closed: a later answer renews nothing, and the watchdog does not end it again.
    Worker.acceptRenewal(ownership, arbiter, cancellation, System.nanoTime());
    assertEquals(deadline, ownership.leaseDeadline());
    assertFalse(ownership.lapse(), "the watchdog would end the attempt a second time");
    assertTrue(ownership.leaseRemaining(System.nanoTime()) <= 0);
  }

  @Test
  void anAcceptedAnswerInsideTheWindowRenewsIt() {
    long now = System.nanoTime();
    Worker.Ownership ownership = new Worker.Ownership(now, TimeUnit.SECONDS.toNanos(30));
    Worker.Arbiter arbiter = new Worker.Arbiter();
    TaskCancellation cancellation = new TaskCancellation();

    Worker.acceptRenewal(ownership, arbiter, cancellation, now + 10);

    assertEquals(now + 10 + TimeUnit.SECONDS.toNanos(30), ownership.leaseDeadline());
    assertNull(arbiter.outcome());
    assertFalse(cancellation.isCancelled());
  }

  @Test
  void anAcceptedAnswerAfterTheWatchdogClosedTheWindowRenewsNothing() {
    long now = System.nanoTime();
    Worker.Ownership ownership = new Worker.Ownership(now - LEASE - 1, LEASE);
    Worker.Arbiter arbiter = new Worker.Arbiter();
    TaskCancellation cancellation = new TaskCancellation();
    long deadline = ownership.leaseDeadline();
    assertTrue(ownership.lapse(), "the watchdog closes the window");

    Worker.acceptRenewal(ownership, arbiter, cancellation, now);

    assertEquals(deadline, ownership.leaseDeadline());
    // The watchdog that closed the window ends the attempt, so the answer submits nothing.
    assertNull(arbiter.outcome());
    assertFalse(cancellation.isCancelled());
  }
}
