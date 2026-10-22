using System.Collections.Concurrent;
using System.Globalization;
using System.Numerics;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace Workhorse.AspNetCore.Internal;

/// <summary>A dashboard request does not match its <c>dashboard/v1</c> JSON Schema.</summary>
internal sealed class InputValidationException(string message) : Exception(message);

/// <summary>
/// Checks a request against its <c>dashboard/v1</c> JSON Schema, in the subset that the contract
/// uses. The counterpart of Ruby's <c>Dashboard::Validator</c> and of the JVM <c>Validator</c>.
/// </summary>
internal static class Validator
{
    private static readonly JsonObject Schemas =
        JsonNode.Parse(V1.InputSchemas)?.AsObject() ?? throw new InvalidOperationException("the dashboard/v1 schemas are not an object");

    private static readonly ConcurrentDictionary<string, Regex> Patterns = new(StringComparer.Ordinal);

    /// <summary>The request schemas by procedure.</summary>
    internal static JsonObject All => Schemas;

    /// <summary>Checks the input of one procedure.</summary>
    /// <exception cref="InputValidationException"><paramref name="value"/> does not satisfy the request schema.</exception>
    internal static void Validate(string procedure, JsonNode? value)
    {
        if (!Schemas.TryGetPropertyValue(procedure, out var schema))
        {
            throw new InputValidationException($"unknown dashboard procedure \"{procedure}\"");
        }

        if (schema is not JsonObject root)
        {
            if (value is not null)
            {
                throw new InputValidationException($"{procedure} does not accept input");
            }

            return;
        }

        Check(root, root, value, "$");
    }

    private static void Check(JsonObject schema, JsonObject root, JsonNode? value, string path)
    {
        if (schema["$ref"] is JsonValue reference && reference.TryGetValue<string>(out var name))
        {
            Check(Definition(root, name, path), root, value, path);
            return;
        }

        if (schema["anyOf"] is JsonArray branches)
        {
            AnyOf(branches, root, value, path);
            return;
        }

        if (schema.TryGetPropertyValue("const", out var constant) && !Same(constant, value))
        {
            throw Fail(path, $"value must equal {constant?.ToJsonString() ?? "null"}");
        }

        if (schema["enum"] is JsonArray allowed && !allowed.Any(item => Same(item, value)))
        {
            throw Fail(path, "value is not in the allowed set");
        }

        if (schema["type"] is not JsonValue typeValue || !typeValue.TryGetValue<string>(out var type))
        {
            return;
        }

        switch (type)
        {
            case "null":
                if (value is not null)
                {
                    throw Fail(path, "expected null");
                }

                break;
            case "boolean":
                if (Kind(value) is not (JsonValueKind.True or JsonValueKind.False))
                {
                    throw Fail(path, "expected boolean");
                }

                break;
            case "string":
                String(schema, value, path);
                break;
            case "integer" or "number":
                Number(schema, type, value, path);
                break;
            case "array":
                Array(schema, root, value, path);
                break;
            case "object":
                Object(schema, root, value, path);
                break;
            default:
                break;
        }
    }

    private static JsonObject Definition(JsonObject root, string reference, string path)
    {
        const string Prefix = "#/$defs/";
        var name = reference.StartsWith(Prefix, StringComparison.Ordinal) ? reference[Prefix.Length..] : reference;
        return root["$defs"]?[name] as JsonObject ?? throw Fail(path, $"unresolved schema reference {reference}");
    }

    private static void AnyOf(JsonArray branches, JsonObject root, JsonNode? value, string path)
    {
        foreach (var branch in branches)
        {
            if (branch is not JsonObject schema)
            {
                continue;
            }

            try
            {
                Check(schema, root, value, path);
                return;
            }
            catch (InputValidationException)
            {
                // Try the next branch.
            }
        }

        throw Fail(path, "value does not match any allowed schema");
    }

    private static void String(JsonObject schema, JsonNode? value, string path)
    {
        if (value is not JsonValue scalar || !scalar.TryGetValue<string>(out var text))
        {
            throw Fail(path, "expected string");
        }

        var length = CodePoints(text);
        if (Integer(schema["minLength"]) is { } minimum && length < minimum)
        {
            throw Fail(path, "string is too short");
        }

        if (Integer(schema["maxLength"]) is { } maximum && length > maximum)
        {
            throw Fail(path, "string is too long");
        }

        if (schema["pattern"] is JsonValue pattern && pattern.TryGetValue<string>(out var source)
            && !Patterns.GetOrAdd(source, EcmaPattern.Compile).IsMatch(text))
        {
            throw Fail(path, $"string does not match {source}");
        }
    }

    private static void Number(JsonObject schema, string type, JsonNode? value, string path)
    {
        if (Kind(value) != JsonValueKind.Number)
        {
            throw Fail(path, $"expected {type}");
        }

        var text = value!.ToJsonString();
        if (type == "integer" && !IsIntegerText(text))
        {
            throw Fail(path, "expected integer");
        }

        if (schema["minimum"] is { } minimum && Compare(text, minimum.ToJsonString()) < 0)
        {
            throw Fail(path, "number is below minimum");
        }

        if (schema["maximum"] is { } maximum && Compare(text, maximum.ToJsonString()) > 0)
        {
            throw Fail(path, "number is above maximum");
        }
    }

    private static void Array(JsonObject schema, JsonObject root, JsonNode? value, string path)
    {
        if (value is not JsonArray items)
        {
            throw Fail(path, "expected array");
        }

        if (Integer(schema["minItems"]) is { } minimum && items.Count < minimum)
        {
            throw Fail(path, "array has too few items");
        }

        if (Integer(schema["maxItems"]) is { } maximum && items.Count > maximum)
        {
            throw Fail(path, "array has too many items");
        }

        if (schema["items"] is not JsonObject itemSchema)
        {
            return;
        }

        for (var index = 0; index < items.Count; index++)
        {
            Check(itemSchema, root, items[index], string.Create(CultureInfo.InvariantCulture, $"{path}[{index}]"));
        }
    }

    private static void Object(JsonObject schema, JsonObject root, JsonNode? value, string path)
    {
        if (value is not JsonObject document)
        {
            throw Fail(path, "expected object");
        }

        var properties = schema["properties"] as JsonObject;
        if (schema["required"] is JsonArray required)
        {
            foreach (var name in required)
            {
                if (name is JsonValue key && key.TryGetValue<string>(out var text) && !document.ContainsKey(text))
                {
                    throw Fail($"{path}.{text}", "required property is missing");
                }
            }
        }

        schema.TryGetPropertyValue("additionalProperties", out var additional);
        foreach (var (key, child) in document)
        {
            var childPath = $"{path}.{key}";
            if (properties?[key] is JsonObject property)
            {
                Check(property, root, child, childPath);
            }
            else if (Kind(additional) == JsonValueKind.False)
            {
                throw Fail(childPath, "additional property is not allowed");
            }
            else if (additional is JsonObject additionalSchema)
            {
                Check(additionalSchema, root, child, childPath);
            }
        }
    }

    /// <summary>JSON equality, where <c>25</c> and <c>25.0</c> are the same number.</summary>
    private static bool Same(JsonNode? left, JsonNode? right)
    {
        var leftKind = Kind(left);
        var rightKind = Kind(right);
        if (leftKind == JsonValueKind.Number || rightKind == JsonValueKind.Number)
        {
            return leftKind == rightKind && Compare(left!.ToJsonString(), right!.ToJsonString()) == 0;
        }

        return JsonNode.DeepEquals(left, right);
    }

    /// <summary>The kind of a node, where a missing node and a JSON <c>null</c> are both <c>Null</c>.</summary>
    internal static JsonValueKind Kind(JsonNode? node) => node?.GetValueKind() ?? JsonValueKind.Null;

    /// <summary>Whether the text of a JSON number has no fraction and no exponent.</summary>
    internal static bool IsIntegerText(string text) => text.AsSpan().IndexOfAny(".eE") < 0;

    /// <summary>Compares two JSON number texts by value. Integers compare exactly.</summary>
    private static int Compare(string left, string right)
    {
        if (IsIntegerText(left) && IsIntegerText(right))
        {
            return BigInteger.Parse(left, NumberStyles.AllowLeadingSign, CultureInfo.InvariantCulture)
                .CompareTo(BigInteger.Parse(right, NumberStyles.AllowLeadingSign, CultureInfo.InvariantCulture));
        }

        return double.Parse(left, NumberStyles.Float, CultureInfo.InvariantCulture)
            .CompareTo(double.Parse(right, NumberStyles.Float, CultureInfo.InvariantCulture));
    }

    private static long? Integer(JsonNode? node) =>
        node is JsonValue value && value.TryGetValue<long>(out var number) ? number : null;

    /// <summary>The length that JSON Schema measures: Unicode code points.</summary>
    private static int CodePoints(string text)
    {
        var count = 0;
        foreach (var _ in text.EnumerateRunes())
        {
            count++;
        }

        return count;
    }

    private static InputValidationException Fail(string path, string message) => new($"{path}: {message}");
}
