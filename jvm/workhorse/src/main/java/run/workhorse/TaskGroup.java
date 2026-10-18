package run.workhorse;

import java.time.Instant;
import java.util.List;
import java.util.UUID;
import org.jspecify.annotations.Nullable;

/**
 * A set of full-tier tasks that Workhorse tracks as one unit (ADR 0095).
 *
 * @param id the group
 * @param state the state
 * @param result the result when the group is finished, and {@code null} before
 * @param counts the counts
 * @param createdAt when the group was created
 * @param sealedAt when the group was sealed, or {@code null}
 * @param finishedAt when the group finished, or {@code null}
 * @param canceledAt when the group was canceled, or {@code null}
 * @param canceledBy who canceled the group, or {@code null}
 * @param cancelReason why the group was canceled, or {@code null}
 * @param callbacks the requested callbacks, in the order on finish, on success, on failure
 */
public record TaskGroup(
    UUID id,
    TaskGroupState state,
    @Nullable TaskGroupResult result,
    TaskGroupCounts counts,
    Instant createdAt,
    @Nullable Instant sealedAt,
    @Nullable Instant finishedAt,
    @Nullable Instant canceledAt,
    @Nullable String canceledBy,
    @Nullable String cancelReason,
    List<TaskGroupCallback> callbacks) {
  /** Copies the callbacks. */
  public TaskGroup {
    callbacks = List.copyOf(callbacks);
  }
}
