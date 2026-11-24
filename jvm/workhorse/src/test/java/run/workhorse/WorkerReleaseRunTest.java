package run.workhorse;

import static org.junit.jupiter.api.Assertions.assertEquals;

import java.util.List;
import java.util.UUID;
import org.junit.jupiter.api.Test;

/**
 * SM-1905 (ADR 0126). Each release puts its task behind the other ready tasks, so the continuous
 * loop claims again at once until a task comes back or the release run reaches its limit.
 */
class WorkerReleaseRunTest {
  private static final UUID REPEATED = UUID.randomUUID();

  @Test
  void claimsAgainAfterAReleasedOnlyClaimAndWaitsWhenATaskComesBack() {
    ReleaseRun run = new ReleaseRun();
    assertEquals(ReleaseRun.Step.CLAIM_AGAIN, run.settle(List.of(REPEATED), true));
    assertEquals(ReleaseRun.Step.RELEASE_WAIT, run.settle(List.of(REPEATED), true));
    assertEquals(0, run.claims());
  }

  @Test
  void startsTheReleaseWaitAfterTheReleaseRunLimit() {
    ReleaseRun run = new ReleaseRun();
    for (int index = 1; index < ReleaseRun.LIMIT; index++) {
      assertEquals(ReleaseRun.Step.CLAIM_AGAIN, run.settle(List.of(UUID.randomUUID()), true));
    }
    assertEquals(ReleaseRun.Step.RELEASE_WAIT, run.settle(List.of(UUID.randomUUID()), true));
  }

  @Test
  void startsTheReleaseWaitAfterAnEmptyClaimInsideARunAndAnEmptyWaitOutsideOne() {
    ReleaseRun run = new ReleaseRun();
    run.settle(List.of(REPEATED), true);
    assertEquals(ReleaseRun.Step.RELEASE_WAIT, run.settle(List.of(), true));
    assertEquals(ReleaseRun.Step.EMPTY_WAIT, run.settle(List.of(), true));
  }

  @Test
  void aRunThatEndsAtAHandlerStartsAgain() {
    ReleaseRun run = new ReleaseRun();
    run.settle(List.of(REPEATED), true);
    run.end();
    assertEquals(ReleaseRun.Step.CLAIM_AGAIN, run.settle(List.of(REPEATED), true));
    assertEquals(1, run.claims());
  }

  @Test
  void aSinglePassEndsAtItsFirstReleasedOnlyClaim() {
    ReleaseRun run = new ReleaseRun();
    assertEquals(ReleaseRun.Step.RELEASE_WAIT, run.settle(List.of(REPEATED), false));
    assertEquals(ReleaseRun.Step.EMPTY_WAIT, run.settle(List.of(), false));
  }
}
