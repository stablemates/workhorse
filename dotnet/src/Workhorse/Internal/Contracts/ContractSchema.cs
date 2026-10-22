using System.Text.Json;

namespace Workhorse.Internal.Contracts;

/// <summary>
/// A compiled contract schema in the Workhorse contract profile (ADR 0039). It is the counterpart
/// of Ruby's and Java's <c>ContractSchema</c>.
/// </summary>
/// <remarks>
/// The constructor throws <see cref="ArgumentException"/> for a schema outside the profile. The
/// profile excludes <c>pattern</c> and <c>patternProperties</c> at any depth, so the validator never
/// compiles a regular expression. <c>format</c> is an annotation. A reference resolves only to the
/// root schema or to one root definition. Numbers compare as exact decimals.
/// </remarks>
internal sealed class ContractSchema
{
    private const string Dialect = "https://json-schema.org/draft/2020-12/schema";
    private const string DefinitionReferencePrefix = "#/$defs/";
    private const int MaxDepth = 256;

    private static readonly HashSet<string> SchemaValues =
        ["additionalProperties", "contains", "else", "if", "items", "not", "propertyNames", "then"];

    private static readonly HashSet<string> SchemaArrays = ["allOf", "anyOf", "oneOf", "prefixItems"];

    private static readonly HashSet<string> SchemaMaps = ["$defs", "dependentSchemas", "properties"];

    private static readonly HashSet<string> PlainKeywords =
    [
        "$comment", "$schema", "default", "deprecated", "description", "examples", "format", "readOnly",
        "title", "writeOnly", "const", "dependentRequired", "enum", "exclusiveMaximum", "exclusiveMinimum",
        "maxContains", "maximum", "maxItems", "maxLength", "maxProperties", "minContains", "minimum",
        "minItems", "minLength", "minProperties", "multipleOf", "required", "type", "uniqueItems",
    ];

    private static readonly HashSet<string> Types = ["array", "boolean", "integer", "null", "number", "object", "string"];

    private static readonly HashSet<string> Numbers = ["exclusiveMaximum", "exclusiveMinimum", "maximum", "minimum"];

    private static readonly HashSet<string> Counts =
        ["maxContains", "maxItems", "maxLength", "maxProperties", "minContains", "minItems", "minLength", "minProperties"];

    private static readonly HashSet<string> Strings = ["$comment", "description", "format", "title"];

    private static readonly HashSet<string> Booleans = ["deprecated", "readOnly", "uniqueItems", "writeOnly"];

    private readonly object? _schema;

    /// <summary>Compiles a schema that is a value of <see cref="JsonTree"/>.</summary>
    /// <exception cref="ArgumentException">The schema is outside the Workhorse contract profile.</exception>
    internal ContractSchema(object? schema)
    {
        if (ProfileViolation(schema, "$") is { } violation)
        {
            throw new ArgumentException(violation);
        }

        _schema = schema;
        CheckReferences(schema, "$");
    }

    /// <summary>Compiles a schema. An undefined element is the schema <c>true</c>.</summary>
    /// <exception cref="ArgumentException">The schema is outside the Workhorse contract profile.</exception>
    internal ContractSchema(JsonElement schema)
        : this(schema.ValueKind == JsonValueKind.Undefined ? true : JsonTree.From(schema))
    {
    }

    /// <summary>Whether <paramref name="instance"/>, a value of <see cref="JsonTree"/>, satisfies the schema.</summary>
    internal bool Valid(object? instance) => ValidAt(_schema, instance, 0);

    /// <summary>Whether <paramref name="instance"/> satisfies the schema.</summary>
    /// <exception cref="ArgumentException">The value holds a number that PostgreSQL cannot store.</exception>
    internal bool Valid(JsonElement instance) => Valid(JsonTree.From(instance));

    private static string? ProfileViolation(object? schema, string path)
    {
        if (schema is bool)
        {
            return null;
        }

        if (JsonTree.Object(schema) is not { } members)
        {
            return $"{path} must be an object or boolean JSON Schema";
        }

        foreach (var (keyword, value) in members)
        {
            if (KeywordViolation(keyword, value, $"{path}.{keyword}", path == "$") is { } violation)
            {
                return violation;
            }
        }

        return null;
    }

    private static string? KeywordViolation(string keyword, object? value, string path, bool root)
    {
        if (keyword == "$ref")
        {
            return value is string text && text.StartsWith('#') ? null : $"{path} must be a bundled local reference";
        }

        if (keyword == "$schema")
        {
            return Equals(value, Dialect) ? null : $"{path} must select Draft 2020-12";
        }

        if (keyword == "$defs" && !root)
        {
            return $"{path} must appear only on the root schema";
        }

        if (SchemaValues.Contains(keyword))
        {
            return ProfileViolation(value, path);
        }

        if (SchemaArrays.Contains(keyword))
        {
            if (value is not List<object?> { Count: > 0 } items)
            {
                return $"{path} must be a non-empty array";
            }

            for (var index = 0; index < items.Count; index++)
            {
                if (ProfileViolation(items[index], $"{path}[{index}]") is { } violation)
                {
                    return violation;
                }
            }

            return null;
        }

        if (SchemaMaps.Contains(keyword))
        {
            if (JsonTree.Object(value) is not { } members)
            {
                return $"{path} must be an object";
            }

            foreach (var (name, member) in members)
            {
                var memberPath = $"{path}.{name}";
                if (keyword == "$defs" && !DefinitionName(name))
                {
                    return $"{memberPath} must be a definition name matching ^[A-Za-z_][-A-Za-z0-9._]*$";
                }

                if (ProfileViolation(member, memberPath) is { } violation)
                {
                    return violation;
                }
            }

            return null;
        }

        return PlainKeywords.Contains(keyword)
            ? ValueViolation(keyword, value, path)
            : $"{path} is outside the Workhorse contract profile";
    }

    /// <summary>The rule of the Draft 2020-12 meta-schema for the value of <paramref name="keyword"/>.</summary>
    private static string? ValueViolation(string keyword, object? value, string path)
    {
        if (keyword == "type")
        {
            return TypeNames(value) ? null : $"{path} must name a JSON type or a non-empty array of unique JSON types";
        }

        if (keyword is "enum" or "examples")
        {
            return value is List<object?> ? null : $"{path} must be an array";
        }

        if (keyword == "multipleOf")
        {
            return value is ExactNumber { Sign: > 0 } ? null : $"{path} must be a number greater than 0";
        }

        if (Numbers.Contains(keyword))
        {
            return value is ExactNumber ? null : $"{path} must be a number";
        }

        if (Counts.Contains(keyword))
        {
            return value is ExactNumber { Sign: >= 0, IsInteger: true } ? null : $"{path} must be a non-negative integer";
        }

        if (Strings.Contains(keyword))
        {
            return value is string ? null : $"{path} must be a string";
        }

        if (Booleans.Contains(keyword))
        {
            return value is bool ? null : $"{path} must be a boolean";
        }

        if (keyword == "required")
        {
            return Names(value) ? null : $"{path} must be an array of unique strings";
        }

        if (keyword == "dependentRequired" && (JsonTree.Object(value) is not { } map || !map.Values.All(Names)))
        {
            return $"{path} must map each property to an array of unique strings";
        }

        return null;
    }

    /// <summary>Whether <paramref name="name"/> matches <c>^[A-Za-z_][-A-Za-z0-9._]*$</c>, without a regular expression.</summary>
    private static bool DefinitionName(string name)
    {
        for (var index = 0; index < name.Length; index++)
        {
            var character = name[index];
            var letter = char.IsAsciiLetter(character) || character == '_';
            var later = char.IsAsciiDigit(character) || character is '-' or '.';
            if (!letter && (index == 0 || !later))
            {
                return false;
            }
        }

        return name.Length > 0;
    }

    private static bool TypeNames(object? value)
    {
        if (value is string text)
        {
            return Types.Contains(text);
        }

        if (value is not List<object?> { Count: > 0 } items)
        {
            return false;
        }

        var seen = new HashSet<string>(StringComparer.Ordinal);
        return items.All(item => item is string name && Types.Contains(name) && seen.Add(name));
    }

    private static bool Names(object? value)
    {
        if (value is not List<object?> items)
        {
            return false;
        }

        var seen = new HashSet<string>(StringComparer.Ordinal);
        return items.All(item => item is string name && seen.Add(name));
    }

    private void CheckReferences(object? node, string path)
    {
        if (JsonTree.Object(node) is not { } members)
        {
            return;
        }

        if (members.TryGetValue("$ref", out var reference) && Resolve(Text(reference)) is null)
        {
            throw new ArgumentException($"{path}.$ref must point at a subschema of the contract");
        }

        foreach (var (keyword, value) in members)
        {
            if (SchemaValues.Contains(keyword))
            {
                CheckReferences(value, $"{path}.{keyword}");
            }
            else if (SchemaArrays.Contains(keyword) && value is List<object?> items)
            {
                for (var index = 0; index < items.Count; index++)
                {
                    CheckReferences(items[index], $"{path}.{keyword}[{index}]");
                }
            }
            else if (SchemaMaps.Contains(keyword) && JsonTree.Object(value) is { } children)
            {
                foreach (var (name, child) in children)
                {
                    CheckReferences(child, $"{path}.{keyword}.{name}");
                }
            }
        }
    }

    /// <summary>The schema that a reference names, or <c>null</c> when it names neither the root nor a root definition.</summary>
    private object? Resolve(string reference)
    {
        if (reference == "#")
        {
            return _schema;
        }

        if (!reference.StartsWith(DefinitionReferencePrefix, StringComparison.Ordinal))
        {
            return null;
        }

        return JsonTree.Object(_schema) is { } root
            && JsonTree.Object(root.GetValueOrDefault("$defs")) is { } definitions
            && definitions.TryGetValue(reference[DefinitionReferencePrefix.Length..], out var definition)
                ? definition
                : null;
    }

    private bool ValidAt(object? node, object? instance, int depth)
    {
        if (node is bool flag)
        {
            return flag;
        }

        if (depth > MaxDepth)
        {
            throw new ArgumentException("contract schema references recurse too deeply");
        }

        if (JsonTree.Object(node) is not { } members)
        {
            return false;
        }

        foreach (var (keyword, value) in members)
        {
            if (!KeywordValid(members, keyword, value, instance, depth))
            {
                return false;
            }
        }

        return true;
    }

    private bool KeywordValid(OrderedDictionary<string, object?> node, string keyword, object? value, object? instance, int depth)
    {
        switch (keyword)
        {
            case "$ref":
                return ValidAt(Resolve(Text(value)), instance, depth + 1);
            case "type":
                return value is List<object?> types ? types.Any(type => IsType(instance, Text(type))) : IsType(instance, Text(value));
            case "enum":
                return List(value).Any(candidate => JsonEqual(candidate, instance));
            case "const":
                return JsonEqual(value, instance);
            case "allOf":
                return List(value).All(child => ValidAt(child, instance, depth + 1));
            case "anyOf":
                return List(value).Any(child => ValidAt(child, instance, depth + 1));
            case "oneOf":
                return List(value).Count(child => ValidAt(child, instance, depth + 1)) == 1;
            case "not":
                return !ValidAt(value, instance, depth + 1);
            case "if":
                var branch = ValidAt(value, instance, depth + 1) ? "then" : "else";
                return !node.TryGetValue(branch, out var selected) || ValidAt(selected, instance, depth + 1);
            default:
                return instance switch
                {
                    ExactNumber number => NumberValid(keyword, value, number),
                    string text => StringValid(keyword, value, text),
                    List<object?> items => ArrayValid(node, keyword, value, items, depth),
                    OrderedDictionary<string, object?> members => ObjectValid(node, keyword, value, members, depth),
                    _ => true,
                };
        }
    }

    private static bool NumberValid(string keyword, object? value, ExactNumber number) => keyword switch
    {
        "minimum" => number >= Number(value),
        "maximum" => number <= Number(value),
        "exclusiveMinimum" => number > Number(value),
        "exclusiveMaximum" => number < Number(value),
        "multipleOf" => number.IsMultipleOf(Number(value)),
        _ => true,
    };

    private static bool StringValid(string keyword, object? value, string instance)
    {
        var length = ExactNumber.From(CodePoints(instance));
        return keyword switch
        {
            "minLength" => Number(value) <= length,
            "maxLength" => Number(value) >= length,
            _ => true,
        };
    }

    private bool ArrayValid(OrderedDictionary<string, object?> node, string keyword, object? value, List<object?> instance, int depth)
    {
        var size = ExactNumber.From(instance.Count);
        switch (keyword)
        {
            case "minItems":
                return Number(value) <= size;
            case "maxItems":
                return Number(value) >= size;
            case "uniqueItems":
                return !Equals(value, true) || Unique(instance);
            case "prefixItems":
                var prefix = List(value);
                for (var index = 0; index < Math.Min(prefix.Count, instance.Count); index++)
                {
                    if (!ValidAt(prefix[index], instance[index], depth + 1))
                    {
                        return false;
                    }
                }

                return true;
            case "items":
                var skip = node.GetValueOrDefault("prefixItems") is List<object?> prefixItems ? prefixItems.Count : 0;
                return instance.Skip(skip).All(item => ValidAt(value, item, depth + 1));
            case "contains":
                var found = ExactNumber.From(instance.Count(item => ValidAt(value, item, depth + 1)));
                var minimum = node.TryGetValue("minContains", out var low) ? Number(low) : ExactNumber.From(1);
                return found >= minimum && (!node.TryGetValue("maxContains", out var high) || found <= Number(high));
            default:
                return true;
        }
    }

    private bool ObjectValid(OrderedDictionary<string, object?> node, string keyword, object? value, OrderedDictionary<string, object?> instance, int depth)
    {
        var members = JsonTree.Object(value);
        var size = ExactNumber.From(instance.Count);
        return keyword switch
        {
            "minProperties" => Number(value) <= size,
            "maxProperties" => Number(value) >= size,
            "required" => List(value).All(name => instance.ContainsKey(Text(name))),
            "dependentRequired" => members is null || members.All(entry =>
                !instance.ContainsKey(entry.Key) || List(entry.Value).All(name => instance.ContainsKey(Text(name)))),
            "dependentSchemas" => members is null || members.All(entry =>
                !instance.ContainsKey(entry.Key) || ValidAt(entry.Value, instance, depth + 1)),
            "propertyNames" => instance.Keys.All(name => ValidAt(value, name, depth + 1)),
            "properties" => members is null || members.All(entry =>
                !instance.TryGetValue(entry.Key, out var member) || ValidAt(entry.Value, member, depth + 1)),
            "additionalProperties" => instance.All(entry =>
                (JsonTree.Object(node.GetValueOrDefault("properties")) is { } named && named.ContainsKey(entry.Key))
                || ValidAt(value, entry.Value, depth + 1)),
            _ => true,
        };
    }

    private static bool IsType(object? instance, string type) => type switch
    {
        "null" => instance is null,
        "boolean" => instance is bool,
        "string" => instance is string,
        "array" => instance is List<object?>,
        "object" => instance is OrderedDictionary<string, object?>,
        "number" => instance is ExactNumber,
        "integer" => instance is ExactNumber { IsInteger: true },
        _ => false,
    };

    /// <summary>JSON equality: 1 equals 1.0, and <c>true</c> equals neither 1 nor 1.0.</summary>
    private static bool JsonEqual(object? left, object? right)
    {
        switch (left)
        {
            case ExactNumber number:
                return right is ExactNumber other && number == other;
            case OrderedDictionary<string, object?> leftMembers:
                return right is OrderedDictionary<string, object?> rightMembers
                    && leftMembers.Count == rightMembers.Count
                    && leftMembers.All(entry => rightMembers.TryGetValue(entry.Key, out var member) && JsonEqual(entry.Value, member));
            case List<object?> leftItems:
                return right is List<object?> rightItems
                    && leftItems.Count == rightItems.Count
                    && leftItems.Zip(rightItems).All(pair => JsonEqual(pair.First, pair.Second));
            case null:
                return right is null;
            default:
                return left.Equals(right);
        }
    }

    private static bool Unique(List<object?> items)
    {
        for (var index = 0; index < items.Count; index++)
        {
            for (var other = index + 1; other < items.Count; other++)
            {
                if (JsonEqual(items[index], items[other]))
                {
                    return false;
                }
            }
        }

        return true;
    }

    private static int CodePoints(string text)
    {
        var count = 0;
        for (var index = 0; index < text.Length; index++)
        {
            if (char.IsHighSurrogate(text[index]) && index + 1 < text.Length && char.IsLowSurrogate(text[index + 1]))
            {
                index++;
            }

            count++;
        }

        return count;
    }

    private static string Text(object? value) =>
        value as string ?? throw new InvalidOperationException("the profile check admitted a non-string value");

    private static List<object?> List(object? value) =>
        value as List<object?> ?? throw new InvalidOperationException("the profile check admitted a non-array value");

    private static ExactNumber Number(object? value) =>
        value is ExactNumber number ? number : throw new InvalidOperationException("the profile check admitted a non-number value");
}
