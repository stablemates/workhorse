using Npgsql;
using Workhorse.Internal.Database;

namespace Workhorse.Internal.Admin;

/// <summary>The column reads and parameters that only <c>Admin</c> needs.</summary>
internal static class AdminRows
{
    /// <summary>A <c>text[]</c> column that must not be <c>NULL</c>.</summary>
    internal static IReadOnlyList<string> RequiredTextList(this Row row, string column) =>
        row.TextList(column) ?? throw Invalid(column);

    /// <summary>A <c>uuid[]</c> column that must not be <c>NULL</c>.</summary>
    internal static IReadOnlyList<Guid> RequiredUuidList(this Row row, string column) => row.Value(column) switch
    {
        Guid[] ids => ids,
        _ => throw Invalid(column),
    };

    /// <summary>A millisecond count as a duration, or <c>null</c>.</summary>
    internal static TimeSpan? Milliseconds(this Row row, string column) =>
        row.Long(column) is { } milliseconds ? TimeSpan.FromMilliseconds(milliseconds) : null;

    /// <summary>
    /// A <c>timestamptz</c> cursor field. A cursor keeps PostgreSQL's own text, so it binds as
    /// <c>text</c>, and the <c>::timestamptz</c> cast of the contract reads it back unchanged.
    /// </summary>
    internal static NpgsqlParameter CursorTime(string? value) => Parameters.Text(value);

    private static WorkhorseException Invalid(string column) =>
        new($"PostgreSQL returned an invalid {column} column");
}
