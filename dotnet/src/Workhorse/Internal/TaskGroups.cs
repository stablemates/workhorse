using System.Text.Json;
using Npgsql;
using Workhorse.Internal.Database;

namespace Workhorse.Internal;

/// <summary>Maps the task-group rows that <c>Queue</c> and <c>Admin</c> both read.</summary>
internal static class TaskGroups
{
    /// <summary>
    /// One page of at most <paramref name="limit"/> member tasks after the position
    /// <paramref name="after"/>. The caller validates <paramref name="after"/> and <paramref name="limit"/>.
    /// </summary>
    internal static async Task<TaskGroupMemberPage> MemberPageAsync(
        NpgsqlConnection connection, Guid groupId, long after, int limit, CancellationToken cancellationToken)
    {
        var rows = await Sql.RowsAsync(
            connection,
            SqlCatalogue.ListTaskGroupMembersV1,
            [Parameters.Uuid(groupId), Parameters.Integer(checked((int)after)), Parameters.Integer(limit)],
            cancellationToken).ConfigureAwait(false);

        // A full page can be the last page. The read of one more member tells the two apart.
        var more = rows.Count == limit
            && (await Sql.RowsAsync(
                connection,
                SqlCatalogue.ListTaskGroupMembersV1,
                [Parameters.Uuid(groupId), Parameters.Integer(checked((int)rows[^1].RequiredLong("position"))), Parameters.Integer(1)],
                cancellationToken).ConfigureAwait(false)).Count > 0;
        var members = rows.Select(row => new TaskGroupMember
        {
            Position = row.RequiredLong("position"),
            TaskId = row.RequiredUuid("task_id"),
            Queue = row.Text("queue_name"),
            Type = row.Text("task_type"),
            State = row.Text("state") is { } state ? Wire.Required<TaskState>("task_group_member_state", state) : null,
            Outcome = row.Text("outcome") is { } outcome ? Wire.Required<TaskGroupMemberOutcome>("task_group_member_outcome", outcome) : null,
            AddedAt = row.RequiredInstant("added_at"),
            CountedAt = row.Instant("counted_at"),
        }).ToList();
        return new TaskGroupMemberPage { Members = members, NextAfter = more ? members[^1].Position : null };
    }

    /// <summary>The group of a row with the columns of <c>get_task_group_v1</c>.</summary>
    internal static TaskGroup Group(Row row)
    {
        var callbacks = new List<TaskGroupCallback>();
        if (row.Json("callbacks") is { ValueKind: JsonValueKind.Object } entries)
        {
            foreach (var kind in Enum.GetValues<TaskGroupCallbackKind>())
            {
                if (!entries.TryGetProperty(Wire.Text(kind), out var entry))
                {
                    continue;
                }

                Guid? taskId = entry.ValueKind == JsonValueKind.Object
                    && entry.TryGetProperty("taskId", out var id)
                    && id.ValueKind == JsonValueKind.String
                    && Guid.TryParse(id.GetString(), System.Globalization.CultureInfo.InvariantCulture, out var parsed)
                        ? parsed
                        : null;
                callbacks.Add(new TaskGroupCallback { Kind = kind, TaskId = taskId });
            }
        }

        return new TaskGroup
        {
            Id = row.RequiredUuid("group_id"),
            State = Wire.Required<TaskGroupState>("task_group_state", row.RequiredText("state")),
            Result = row.Text("result") is { } result ? Wire.Required<TaskGroupResult>("task_group_result", result) : null,
            Counts = new TaskGroupCounts
            {
                Total = row.RequiredLong("total"),
                Succeeded = row.RequiredLong("succeeded"),
                Failed = row.RequiredLong("failed"),
                Canceled = row.RequiredLong("canceled"),
                Pending = row.RequiredLong("pending"),
            },
            CreatedAt = row.RequiredInstant("created_at"),
            SealedAt = row.Instant("sealed_at"),
            FinishedAt = row.Instant("finished_at"),
            CanceledAt = row.Instant("canceled_at"),
            CanceledBy = row.Text("canceled_by"),
            CancelReason = row.Text("cancel_reason"),
            Callbacks = callbacks,
        };
    }

    /// <summary>The single row of <paramref name="rows"/>. Any other count is an invalid result.</summary>
    internal static Row ExactlyOne(IReadOnlyList<Row> rows, string function) =>
        rows.Count == 1
            ? rows[0]
            : throw new WorkhorseException($"workhorse.{function} returned {rows.Count} rows; expected one");
}
