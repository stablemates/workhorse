using System.Text.Json;

namespace Workhorse;

/// <summary>The type of a task group event.</summary>
public enum TaskGroupEventType
{
    /// <summary>The group was created.</summary>
    Created,

    /// <summary>The group was sealed.</summary>
    Sealed,

    /// <summary>An operator canceled the group.</summary>
    Canceled,

    /// <summary>The group finished.</summary>
    Finished,

    /// <summary>The group enqueued a callback task.</summary>
    CallbackEnqueued,

    /// <summary>The group could not enqueue a callback task.</summary>
    CallbackFailed,

    /// <summary>A drift repair recounted or finished the group.</summary>
    CounterRepaired,
}

/// <summary>One event of the history of a task group.</summary>
public sealed record TaskGroupEvent
{
    /// <summary>The event.</summary>
    public required Guid Id { get; init; }

    /// <summary>The event type.</summary>
    public required TaskGroupEventType Type { get; init; }

    /// <summary>The event details, or <c>null</c>.</summary>
    public JsonElement? Details { get; init; }

    /// <summary>When the event occurred.</summary>
    public required DateTimeOffset OccurredAt { get; init; }
}

/// <summary>What a drift repair does, or did, to one task group.</summary>
public enum TaskGroupRepairAction
{
    /// <summary>The repair recounts the counters from the member outcomes.</summary>
    Recounted,

    /// <summary>The repair finishes a sealed group with no pending member.</summary>
    Finished,
}

/// <summary>
/// A group that is not finished and whose counters disagree with its member outcomes, or a sealed
/// group with no pending member.
/// </summary>
public sealed record TaskGroupDrift
{
    /// <summary>The group.</summary>
    public required Guid GroupId { get; init; }

    /// <summary>The state of the group.</summary>
    public required TaskGroupState State { get; init; }

    /// <summary>The counters of the group row, with a <c>null</c> pending count.</summary>
    public required TaskGroupCounts Recorded { get; init; }

    /// <summary>The counts that the member outcomes give.</summary>
    public required TaskGroupCounts Counted { get; init; }

    /// <summary>What a repair does to the group.</summary>
    public required TaskGroupRepairAction Action { get; init; }
}

/// <summary>What a drift repair did to one task group.</summary>
public sealed record TaskGroupRepair
{
    /// <summary>The group.</summary>
    public required Guid GroupId { get; init; }

    /// <summary>The pending count before the repair.</summary>
    public required long RecordedPending { get; init; }

    /// <summary>The pending count after the repair.</summary>
    public required long Pending { get; init; }

    /// <summary>What the repair did.</summary>
    public required TaskGroupRepairAction Action { get; init; }
}
