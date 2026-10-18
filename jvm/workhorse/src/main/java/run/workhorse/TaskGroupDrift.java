package run.workhorse;

import java.util.UUID;

/**
 * A group that is not finished and whose counters disagree with its member outcomes, or a sealed
 * group with no pending member.
 *
 * @param groupId the group
 * @param state the state of the group
 * @param recorded the counters of the group row, with a {@code null} pending count
 * @param counted the counts that the member outcomes give
 * @param action what a repair does to the group
 */
public record TaskGroupDrift(
    UUID groupId,
    TaskGroupState state,
    TaskGroupCounts recorded,
    TaskGroupCounts counted,
    TaskGroupRepairAction action) {}
