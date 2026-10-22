using System.Text.Json;

namespace Workhorse.Internal.Contracts;

/// <summary>
/// The JSON tree that the contract validator reads. A value is an
/// <see cref="OrderedDictionary{TKey, TValue}"/> of members in source order, a
/// <see cref="List{T}"/>, a <see cref="string"/>, a <see cref="bool"/>, an
/// <see cref="ExactNumber"/>, or <c>null</c>. A duplicate member keeps the last value, as
/// PostgreSQL's <c>jsonb</c> does.
/// </summary>
internal static class JsonTree
{
    /// <summary>The deepest nesting that a value can have.</summary>
    internal const int MaxDepth = 1000;

    internal static readonly JsonDocumentOptions DocumentOptions = new() { MaxDepth = MaxDepth };

    /// <summary>The tree of the JSON text <paramref name="json"/>.</summary>
    /// <exception cref="ArgumentException">The text is not one JSON value, or it holds a number that PostgreSQL cannot store.</exception>
    internal static object? Parse(string json)
    {
        try
        {
            using var document = JsonDocument.Parse(json, DocumentOptions);
            return From(document.RootElement);
        }
        catch (JsonException error)
        {
            throw new ArgumentException(error.Message, error);
        }
    }

    /// <summary>The tree of <paramref name="element"/>.</summary>
    internal static object? From(JsonElement element)
    {
        switch (element.ValueKind)
        {
            case JsonValueKind.Object:
                var members = new OrderedDictionary<string, object?>(StringComparer.Ordinal);
                foreach (var property in element.EnumerateObject())
                {
                    members[Text(() => property.Name)] = From(property.Value);
                }

                return members;
            case JsonValueKind.Array:
                return element.EnumerateArray().Select(From).ToList();
            case JsonValueKind.String:
                return Text(() => element.GetString()!);
            case JsonValueKind.Number:
                return ExactNumber.Parse(element.GetRawText());
            case JsonValueKind.True:
                return true;
            case JsonValueKind.False:
                return false;
            default:
                return null;
        }
    }

    /// <summary>The members of an object value, or <c>null</c> for any other value.</summary>
    internal static OrderedDictionary<string, object?>? Object(object? value) => value as OrderedDictionary<string, object?>;

    private static string Text(Func<string> read)
    {
        try
        {
            return read();
        }
        catch (InvalidOperationException error)
        {
            throw new ArgumentException("a JSON string holds a lone UTF-16 surrogate", error);
        }
    }
}
