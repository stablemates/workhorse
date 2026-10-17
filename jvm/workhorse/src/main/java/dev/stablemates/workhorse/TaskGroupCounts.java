package dev.stablemates.workhorse;

import org.jspecify.annotations.Nullable;

/**
 * The counts of a task group.
 *
 * @param total the member tasks
 * @param succeeded the member tasks that succeeded
 * @param failed the member tasks that failed
 * @param canceled the member tasks that were canceled
 * @param pending the member tasks that are not finished, or {@code null} for the recorded counters
 *     of a drift report
 */
public record TaskGroupCounts(
    long total, long succeeded, long failed, long canceled, @Nullable Long pending) {}
