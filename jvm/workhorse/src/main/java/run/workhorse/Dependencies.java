package run.workhorse;

import java.util.List;
import java.util.UUID;

/**
 * Prerequisite tasks and what a dependent task does when one of them ends.
 *
 * @param prerequisiteTaskIds 1 to 100 unique prerequisite tasks
 * @param onSuccess the policy when a prerequisite task succeeds
 * @param onFailure the policy when a prerequisite task fails
 * @param onCancellation the policy when a prerequisite task is canceled
 */
public record Dependencies(
    List<UUID> prerequisiteTaskIds,
    DependencyPolicy onSuccess,
    DependencyPolicy onFailure,
    DependencyPolicy onCancellation) {
  /** Copies the prerequisite task IDs. */
  public Dependencies {
    prerequisiteTaskIds = List.copyOf(prerequisiteTaskIds);
  }
}
