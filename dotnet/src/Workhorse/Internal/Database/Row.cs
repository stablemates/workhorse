using System.Globalization;
using System.Text.Json;

namespace Workhorse.Internal.Database;

/// <summary>
/// One result row, keyed by column name. A <c>timestamptz</c> column holds a
/// <see cref="DateTimeOffset"/> with offset zero, and SQL <c>NULL</c> is <c>null</c>.
/// </summary>
internal sealed class Row(IReadOnlyDictionary<string, object?> values)
{
    /// <summary>Whether the row has <paramref name="column"/>.</summary>
    internal bool Has(string column) => values.ContainsKey(column);

    /// <summary>The value of <paramref name="column"/>. A missing column is an invalid result.</summary>
    internal object? Value(string column) =>
        values.TryGetValue(column, out var value) ? value : throw Invalid(column);

    internal string? Text(string column) => Value(column) switch
    {
        null => null,
        string text => text,
        IFormattable formattable => formattable.ToString(null, CultureInfo.InvariantCulture),
        var other => other.ToString(),
    };

    internal string RequiredText(string column) => Text(column) ?? throw Invalid(column);

    internal long? Long(string column) => Value(column) switch
    {
        null => null,
        long number => number,
        int number => number,
        short number => number,
        decimal number when number == decimal.Truncate(number) => (long)number,
        string text when long.TryParse(text, NumberStyles.AllowLeadingSign, CultureInfo.InvariantCulture, out var number) => number,
        _ => throw Invalid(column),
    };

    internal long RequiredLong(string column) => Long(column) ?? throw Invalid(column);

    internal int? Integer(string column)
    {
        var value = Long(column);
        return value is null ? null : value is >= int.MinValue and <= int.MaxValue ? (int)value : throw Invalid(column);
    }

    internal int RequiredInteger(string column) => Integer(column) ?? throw Invalid(column);

    internal bool? Boolean(string column) => Value(column) switch
    {
        null => null,
        bool flag => flag,
        "t" or "true" => true,
        "f" or "false" => false,
        _ => throw Invalid(column),
    };

    internal bool RequiredBoolean(string column) => Boolean(column) ?? throw Invalid(column);

    internal DateTimeOffset? Instant(string column) => Value(column) switch
    {
        null => null,
        DateTimeOffset time => time.ToUniversalTime(),
        DateTime { Kind: DateTimeKind.Utc } time => new DateTimeOffset(time),
        _ => throw Invalid(column),
    };

    internal DateTimeOffset RequiredInstant(string column) => Instant(column) ?? throw Invalid(column);

    internal Guid? Uuid(string column) => Value(column) switch
    {
        null => null,
        Guid id => id,
        string text when Guid.TryParse(text, CultureInfo.InvariantCulture, out var id) => id,
        _ => throw Invalid(column),
    };

    internal Guid RequiredUuid(string column) => Uuid(column) ?? throw Invalid(column);

    internal IReadOnlyList<string>? TextList(string column) => Value(column) switch
    {
        null => null,
        string[] texts => texts,
        _ => throw Invalid(column),
    };

    /// <summary>A <c>json</c> or <c>jsonb</c> column as a detached <see cref="JsonElement"/>, or <c>null</c> for SQL <c>NULL</c>.</summary>
    internal JsonElement? Json(string column)
    {
        var text = Text(column);
        if (text is null)
        {
            return null;
        }

        // A stored value can nest as deeply as the SDK lets it write, not only 64 levels.
        using var document = JsonDocument.Parse(text, Contracts.JsonTree.DocumentOptions);
        return document.RootElement.Clone();
    }

    private static WorkhorseException Invalid(string column) =>
        new($"PostgreSQL returned an invalid {column} column");
}
