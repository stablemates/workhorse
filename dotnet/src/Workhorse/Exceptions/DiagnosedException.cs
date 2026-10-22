using System.Collections.ObjectModel;
using System.Globalization;
using System.Text.Json;

namespace Workhorse;

/// <summary>
/// The base of the enqueue refusals that PostgreSQL diagnoses. <see cref="Details"/> is the JSON
/// DETAIL of PostgreSQL, one entry for each member.
/// </summary>
/// <remarks>
/// PostgreSQL also sends a copy of the JSON in the HINT of the error, from schema version 77. Npgsql
/// hides the DETAIL unless the connection string sets <c>Include Error Detail=true</c>, but it does
/// not hide the HINT. So the SDK reads the HINT when the DETAIL is hidden, and the members are filled
/// with the default Npgsql settings. On schema version 76 without that setting, PostgreSQL sends no
/// HINT. Then <see cref="Details"/> is empty, and each typed member that reads it has its fallback
/// value. The exception type and its SQLSTATE do not depend on the setting or the schema version.
/// </remarks>
public class DiagnosedException : WorkhorseException
{
    private static readonly IReadOnlyDictionary<string, JsonElement> NoDetails =
        new ReadOnlyDictionary<string, JsonElement>(new Dictionary<string, JsonElement>());

    /// <summary>An exception for <paramref name="details"/> with <paramref name="message"/>.</summary>
    protected DiagnosedException(IReadOnlyDictionary<string, JsonElement>? details, string message)
        : base(message)
    {
        Details = details is null
            ? NoDetails
            : new ReadOnlyDictionary<string, JsonElement>(details.ToDictionary(pair => pair.Key, pair => pair.Value.Clone(), StringComparer.Ordinal));
    }

    /// <summary>
    /// The JSON DETAIL of PostgreSQL, or its copy in the HINT when Npgsql hides the DETAIL. It is
    /// empty when neither field holds a JSON object.
    /// </summary>
    public IReadOnlyDictionary<string, JsonElement> Details { get; }

    /// <summary>The text of one detail member, or <paramref name="fallback"/>.</summary>
    private protected static string Text(IReadOnlyDictionary<string, JsonElement>? details, string key, string fallback)
    {
        if (details is null || !details.TryGetValue(key, out var value))
        {
            return fallback;
        }

        return value.ValueKind switch
        {
            JsonValueKind.String => value.GetString() ?? fallback,
            JsonValueKind.Null or JsonValueKind.Undefined => fallback,
            _ => value.GetRawText(),
        };
    }

    /// <summary>A detail member that holds a UUID, or <c>null</c>.</summary>
    private protected Guid? Uuid(string key) =>
        Details.TryGetValue(key, out var value)
        && value.ValueKind == JsonValueKind.String
        && Guid.TryParse(value.GetString(), CultureInfo.InvariantCulture, out var id)
            ? id
            : null;

    /// <summary>A detail member that holds an integer, or <c>null</c>.</summary>
    private protected long? Number(string key) =>
        Details.TryGetValue(key, out var value) && value.ValueKind == JsonValueKind.Number && value.TryGetInt64(out var number)
            ? number
            : null;

    /// <summary>A detail member that holds a string, or <c>null</c>.</summary>
    private protected string? String(string key) =>
        Details.TryGetValue(key, out var value) && value.ValueKind == JsonValueKind.String ? value.GetString() : null;
}

/// <summary>SQLSTATE <c>P1001</c>: a retained idempotency key received a materially different request.</summary>
public sealed class EnqueueIdempotencyConflictException : DiagnosedException
{
    /// <summary>An exception for the detail of PostgreSQL.</summary>
    public EnqueueIdempotencyConflictException(IReadOnlyDictionary<string, JsonElement>? details)
        : base(details, "PostgreSQL rejected a materially different idempotent enqueue")
    {
    }
}

/// <summary>SQLSTATE <c>P1002</c>: a retained redrive request ID received a different source task.</summary>
public sealed class RedriveIdempotencyConflictException : DiagnosedException
{
    /// <summary>An exception for the detail of PostgreSQL.</summary>
    public RedriveIdempotencyConflictException(IReadOnlyDictionary<string, JsonElement>? details)
        : base(details, "PostgreSQL rejected a materially different idempotent redrive")
    {
    }
}

/// <summary>SQLSTATE <c>P1003</c>: the dependency would close a cycle.</summary>
public sealed class DependencyCycleException : DiagnosedException
{
    /// <summary>An exception for the detail of PostgreSQL.</summary>
    public DependencyCycleException(IReadOnlyDictionary<string, JsonElement>? details)
        : base(details, "PostgreSQL rejected a cyclic task dependency")
    {
    }
}

/// <summary>SQLSTATE <c>P1005</c>: a dependency limit was reached.</summary>
public sealed class DependencyLimitExceededException : DiagnosedException
{
    /// <summary>An exception for the detail of PostgreSQL.</summary>
    public DependencyLimitExceededException(IReadOnlyDictionary<string, JsonElement>? details)
        : base(details, "PostgreSQL rejected a task dependency limit")
    {
    }
}

/// <summary>SQLSTATE <c>P1006</c>: a retained purge request ID received a different queue.</summary>
public sealed class PurgeIdempotencyConflictException : DiagnosedException
{
    /// <summary>An exception for the detail of PostgreSQL.</summary>
    public PurgeIdempotencyConflictException(IReadOnlyDictionary<string, JsonElement>? details)
        : base(details, "PostgreSQL rejected a materially different idempotent queue purge")
    {
    }
}

/// <summary>Why a task group does not accept tasks.</summary>
public enum TaskGroupClosedReason
{
    /// <summary>The group is sealed, and the request did not come from a running member task.</summary>
    Sealed,

    /// <summary>The group is finished.</summary>
    Finished,

    /// <summary>The group is canceled.</summary>
    Canceled,

    /// <summary>The task that made the request is not a running member task.</summary>
    NotRunningMember,
}

/// <summary>SQLSTATE <c>P1008</c>: the task group does not accept tasks.</summary>
public sealed class TaskGroupClosedException : DiagnosedException
{
    /// <summary>An exception for the detail of PostgreSQL.</summary>
    public TaskGroupClosedException(IReadOnlyDictionary<string, JsonElement>? details)
        : base(details, $"Task group {Text(details, "groupId", "unknown")} does not accept tasks ({Text(details, "reason", "unknown")})")
    {
    }

    /// <summary>The group, or <c>null</c> when the detail has none.</summary>
    public Guid? GroupId => Uuid("groupId");

    /// <summary>The state of the group, or <c>null</c> when the detail has none or an unknown one.</summary>
    public TaskGroupState? State => Internal.Wire.Optional<TaskGroupState>(String("state"));

    /// <summary>Why the group refused, or <c>null</c> when the detail has none or an unknown one.</summary>
    public TaskGroupClosedReason? Reason => Internal.Wire.Optional<TaskGroupClosedReason>(String("reason"));
}

/// <summary>SQLSTATE <c>P1009</c>: an add would take the task group above its member limit.</summary>
public sealed class TaskGroupLimitExceededException : DiagnosedException
{
    /// <summary>An exception for the detail of PostgreSQL.</summary>
    public TaskGroupLimitExceededException(IReadOnlyDictionary<string, JsonElement>? details)
        : base(details, $"Task group {Text(details, "groupId", "unknown")} holds {Text(details, "total", "0")} tasks and accepts at most {Text(details, "limit", "100000")}")
    {
    }

    /// <summary>The group, or <c>null</c> when the detail has none.</summary>
    public Guid? GroupId => Uuid("groupId");

    /// <summary>The member limit, or <c>null</c> when the detail has none.</summary>
    public long? Limit => Number("limit");

    /// <summary>The member count before the add, or <c>null</c> when the detail has none.</summary>
    public long? Total => Number("total");

    /// <summary>The number of tasks the add requested, or <c>null</c> when the detail has none.</summary>
    public long? Requested => Number("requested");
}

/// <summary>
/// SQLSTATE <c>P1010</c>: enqueue idempotency returned a task that is not a member of the task group.
/// </summary>
public sealed class TaskGroupMembershipConflictException : DiagnosedException
{
    /// <summary>An exception for the detail of PostgreSQL.</summary>
    public TaskGroupMembershipConflictException(IReadOnlyDictionary<string, JsonElement>? details)
        : base(details, $"Enqueue idempotency returned task {Text(details, "taskId", "unknown")}, which is not a member of task group {Text(details, "groupId", "unknown")}")
    {
    }

    /// <summary>The group, or <c>null</c> when the detail has none.</summary>
    public Guid? GroupId => Uuid("groupId");

    /// <summary>The existing task that idempotency returned, or <c>null</c> when the detail has none.</summary>
    public Guid? TaskId => Uuid("taskId");

    /// <summary>The 1-based position of the request in the add, or <c>null</c> when the detail has none.</summary>
    public long? Ordinal => Number("ordinal");

    /// <summary>The group that the existing task belongs to, or <c>null</c> when the detail has none.</summary>
    public Guid? MemberOf => Uuid("memberOf");
}
