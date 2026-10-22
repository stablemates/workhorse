using Npgsql;
using NpgsqlTypes;

namespace Workhorse.Internal.Database;

/// <summary>
/// Unnamed positional parameters for catalogue statements. Each <see cref="NpgsqlDbType"/> follows
/// the cast in the contract (ADR 0107, "SQL comes from the generated catalogue").
/// </summary>
internal static class Parameters
{
    internal static NpgsqlParameter Text(string? value) => Of(NpgsqlDbType.Text, value);

    /// <summary>A <c>jsonb</c> value binds as <c>text</c>, and the <c>::jsonb</c> cast of the contract converts it.</summary>
    internal static NpgsqlParameter Json(string? value) => Of(NpgsqlDbType.Text, value);

    /// <summary>A <c>jsonb[]</c> value binds as a <c>text[]</c>, and the <c>::jsonb[]</c> cast converts it.</summary>
    internal static NpgsqlParameter JsonArray(IReadOnlyCollection<string> values) =>
        Of(NpgsqlDbType.Array | NpgsqlDbType.Text, values.ToArray());

    internal static NpgsqlParameter Uuid(Guid? value) => Of(NpgsqlDbType.Uuid, value);

    internal static NpgsqlParameter UuidArray(IReadOnlyCollection<Guid> values) =>
        Of(NpgsqlDbType.Array | NpgsqlDbType.Uuid, values.ToArray());

    internal static NpgsqlParameter Bigint(long? value) => Of(NpgsqlDbType.Bigint, value);

    internal static NpgsqlParameter BigintArray(IReadOnlyCollection<long> values) =>
        Of(NpgsqlDbType.Array | NpgsqlDbType.Bigint, values.ToArray());

    internal static NpgsqlParameter Integer(int? value) => Of(NpgsqlDbType.Integer, value);

    internal static NpgsqlParameter IntegerArray(IReadOnlyCollection<int> values) =>
        Of(NpgsqlDbType.Array | NpgsqlDbType.Integer, values.ToArray());

    internal static NpgsqlParameter Boolean(bool? value) => Of(NpgsqlDbType.Boolean, value);

    internal static NpgsqlParameter Double(double? value) => Of(NpgsqlDbType.Double, value);

    internal static NpgsqlParameter TextArray(IReadOnlyCollection<string> values) =>
        Of(NpgsqlDbType.Array | NpgsqlDbType.Text, values.ToArray());

    /// <summary>
    /// A <c>timestamptz</c> value. Npgsql writes it only from a <see cref="DateTimeOffset"/> with
    /// offset zero, so the value converts to UTC before it binds (ADR 0107, "Timestamps are UTC").
    /// </summary>
    internal static NpgsqlParameter Timestamptz(DateTimeOffset? value) =>
        Of(NpgsqlDbType.TimestampTz, value?.ToUniversalTime());

    private static NpgsqlParameter Of(NpgsqlDbType type, object? value) =>
        new() { NpgsqlDbType = type, Value = value ?? DBNull.Value };
}
