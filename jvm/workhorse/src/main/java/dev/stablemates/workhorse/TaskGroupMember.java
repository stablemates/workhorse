package dev.stablemates.workhorse;

import java.time.Instant;
import java.util.UUID;
import org.jspecify.annotations.Nullable;

/**
 * One member task.
 *
 * @param position the 1-based order in which the task joined its group
 * @param taskId the task
 * @param queue the queue, or {@code null} after a purge or retention deletes the task
 * @param type the task type, or {@code null} after a purge or retention deletes the task
 * @param state the task state, or {@code null} after a purge or retention deletes the task
 * @param outcome the outcome the group counted, or {@code null} while the member is pending
 * @param addedAt when the task joined
 * @param countedAt when the group counted the outcome, or {@code null}
 */
public record TaskGroupMember(
    long position,
    UUID taskId,
    @Nullable String queue,
    @Nullable String type,
    @Nullable TaskState state,
    @Nullable TaskGroupMemberOutcome outcome,
    Instant addedAt,
    @Nullable Instant countedAt) {}
