package dev.stablemates.workhorse;

import java.util.UUID;

/**
 * What a drift repair did to one task group.
 *
 * @param groupId the group
 * @param recordedPending the pending count before the repair
 * @param pending the pending count after the repair
 * @param action what the repair did
 */
public record TaskGroupRepair(
    UUID groupId, long recordedPending, long pending, TaskGroupRepairAction action) {}
