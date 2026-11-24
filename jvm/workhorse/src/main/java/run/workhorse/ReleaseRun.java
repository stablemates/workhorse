package run.workhorse;

import java.util.Collection;
import java.util.HashSet;
import java.util.Set;
import java.util.UUID;

/**
 * The release run of the continuous loop: the claims in a row that released every task they
 * claimed, and the ids of those tasks (ADR 0126). A release gives the task a new place behind the
 * other ready tasks of its priority, so each claim of the run reaches the next task. A claim that
 * ran a handler, an empty claim, or a release wait ends the run. The worker calls it under its
 * state lock.
 */
final class ReleaseRun {
  /** The claims of a run before the loop starts a release wait. */
  static final int LIMIT = 10;

  /** What the run loop does after a claim that ran no handler. */
  enum Step {
    /** The run continues: the loop claims again at once. */
    CLAIM_AGAIN,
    /** The loop starts a release wait, which a notification does not end. */
    RELEASE_WAIT,
    /** The loop starts an empty wait, which a notification newer than the claim ends. */
    EMPTY_WAIT
  }

  private final Set<UUID> tasks = new HashSet<>();
  private int claims;

  /** The claims of the current run. */
  int claims() {
    return claims;
  }

  /**
   * Records a claim that ran no handler and returns what the loop does next. {@code released} holds
   * the tasks of the claim, which the worker releases. Only the continuous loop claims again: a
   * single pass ends at its first such claim.
   */
  Step settle(Collection<UUID> released, boolean continuous) {
    // An empty claim inside a run can find only the tasks whose release is still in flight. It
    // starts the release wait too, so the notification of that release does not end the wait.
    boolean releasing = !released.isEmpty() || claims > 0;
    if (!released.isEmpty() && continuous) {
      // A task that comes back, or a long run, starts the release wait: claiming again then would
      // spin on a task no handler here can run.
      boolean repeated = false;
      for (UUID id : released) {
        repeated |= !tasks.add(id);
      }
      claims++;
      if (!repeated && claims < LIMIT) {
        return Step.CLAIM_AGAIN;
      }
    }
    end();
    return releasing ? Step.RELEASE_WAIT : Step.EMPTY_WAIT;
  }

  /** Ends the run, after a claim that ran a handler. */
  void end() {
    claims = 0;
    tasks.clear();
  }
}
