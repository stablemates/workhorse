package run.workhorse;

/**
 * The prerequisite policy that the dependency edges of a task share.
 *
 * @param onSuccess the policy when a prerequisite task succeeds
 * @param onFailure the policy when a prerequisite task fails
 * @param onCancellation the policy when a prerequisite task is canceled
 */
public record TaskDependencyPolicy(
    DependencyPolicy onSuccess, DependencyPolicy onFailure, DependencyPolicy onCancellation) {}
