using System.Globalization;
using System.Numerics;
using System.Text;
using System.Text.Json;

namespace Workhorse.Tests.Conformance;

/// <summary>
/// The JSON tree that the runner compares. A value is an
/// <see cref="OrderedDictionary{TKey, TValue}"/> of members in source order, a
/// <see cref="List{T}"/>, a <see cref="string"/>, a <see cref="bool"/>, a <see cref="long"/>, a
/// <see cref="BigInteger"/> outside the 64-bit range, a <see cref="double"/>, or <c>null</c>. It is
/// the tree of the JVM runner's <c>Json</c>, so the two lanes compare the same values.
/// </summary>
internal static class Json
{
    private static readonly JsonDocumentOptions Options = new() { MaxDepth = 1000 };

    /// <summary>The tree of the JSON text <paramref name="text"/>.</summary>
    /// <exception cref="JsonException">The text is not one JSON value.</exception>
    internal static object? Parse(string text)
    {
        using var document = JsonDocument.Parse(text, Options);
        return From(document.RootElement);
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
                    members[property.Name] = From(property.Value);
                }

                return members;
            case JsonValueKind.Array:
                return element.EnumerateArray().Select(From).ToList();
            case JsonValueKind.String:
                return element.GetString();
            case JsonValueKind.Number:
                return Number(element.GetRawText());
            case JsonValueKind.True:
                return true;
            case JsonValueKind.False:
                return false;
            default:
                return null;
        }
    }

    /// <summary>An integer as a <see cref="long"/> or a <see cref="BigInteger"/>, and any other number as a <see cref="double"/>.</summary>
    internal static object Number(string text)
    {
        if (text.All(character => char.IsAsciiDigit(character) || character == '-'))
        {
            var value = BigInteger.Parse(text, CultureInfo.InvariantCulture);
            return value >= long.MinValue && value <= long.MaxValue ? (object)(long)value : value;
        }

        return double.Parse(text, CultureInfo.InvariantCulture);
    }

    /// <summary>The members of an object value, or <c>null</c> for any other value.</summary>
    internal static OrderedDictionary<string, object?>? Object(object? value) => value as OrderedDictionary<string, object?>;

    /// <summary>The compact JSON text of a tree value.</summary>
    /// <exception cref="ArgumentException">The value has no JSON form.</exception>
    internal static string Write(object? value)
    {
        using var buffer = new MemoryStream();
        using (var writer = new Utf8JsonWriter(buffer, new JsonWriterOptions { Encoder = System.Text.Encodings.Web.JavaScriptEncoder.UnsafeRelaxedJsonEscaping, SkipValidation = true }))
        {
            Write(writer, value);
        }

        return Encoding.UTF8.GetString(buffer.ToArray());
    }

    /// <summary>The value as a <see cref="JsonElement"/>, the form the SDK takes a payload in.</summary>
    internal static JsonElement Element(object? value)
    {
        using var document = JsonDocument.Parse(Write(value), Options);
        return document.RootElement.Clone();
    }

    private static void Write(Utf8JsonWriter writer, object? value)
    {
        switch (value)
        {
            case null:
                writer.WriteNullValue();
                break;
            case string text:
                writer.WriteStringValue(text);
                break;
            case bool flag:
                writer.WriteBooleanValue(flag);
                break;
            case long number:
                writer.WriteNumberValue(number);
                break;
            case int number:
                writer.WriteNumberValue(number);
                break;
            case BigInteger number:
                writer.WriteRawValue(number.ToString(CultureInfo.InvariantCulture), skipInputValidation: true);
                break;
            case double number when double.IsFinite(number):
                writer.WriteNumberValue(number);
                break;
            case decimal number:
                writer.WriteNumberValue(number);
                break;
            case JsonElement element:
                element.WriteTo(writer);
                break;
            case OrderedDictionary<string, object?> members:
                writer.WriteStartObject();
                foreach (var (key, item) in members)
                {
                    writer.WritePropertyName(key);
                    Write(writer, item);
                }

                writer.WriteEndObject();
                break;
            case IDictionary<string, object?> members:
                writer.WriteStartObject();
                foreach (var (key, item) in members)
                {
                    writer.WritePropertyName(key);
                    Write(writer, item);
                }

                writer.WriteEndObject();
                break;
            case System.Collections.IEnumerable items:
                writer.WriteStartArray();
                foreach (var item in items)
                {
                    Write(writer, item);
                }

                writer.WriteEndArray();
                break;
            default:
                throw new ArgumentException($"{value.GetType().Name} has no JSON form");
        }
    }

    /// <summary>An object tree of <paramref name="members"/>, in order.</summary>
    internal static OrderedDictionary<string, object?> Members(params (string Key, object? Value)[] members)
    {
        var tree = new OrderedDictionary<string, object?>(StringComparer.Ordinal);
        foreach (var (key, value) in members)
        {
            tree[key] = value;
        }

        return tree;
    }
}
