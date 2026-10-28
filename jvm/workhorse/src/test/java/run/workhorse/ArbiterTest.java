package run.workhorse;

import static org.junit.jupiter.api.Assertions.assertEquals;

import org.junit.jupiter.api.Test;

/** The first-submission rule of one attempt's outcome, and its one exception. */
class ArbiterTest {
  /**
   * SM-1884: a late heartbeat round can submit a cancellation request first. If PostgreSQL then
   * refuses the acknowledgement, the worker settled nothing, so the attempt reports a lost lease.
   */
  @Test
  void replacesARefusedCancellationWithALostLeaseAndKeepsEveryOtherOutcome() {
    Worker.Arbiter arbiter = new Worker.Arbiter();
    arbiter.submit(Worker.Outcome.CANCELLED);
    arbiter.refuseCancellation();
    assertEquals(Worker.Outcome.LEASE_EXPIRED, arbiter.outcome());

    Worker.Arbiter settled = new Worker.Arbiter();
    settled.submit(Worker.Outcome.DEADLINE_EXCEEDED);
    settled.refuseCancellation();
    assertEquals(Worker.Outcome.DEADLINE_EXCEEDED, settled.outcome());
  }
}
