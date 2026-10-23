using System.Globalization;
using System.Numerics;
using System.Text.RegularExpressions;

namespace Workhorse.Tests.Conformance;

/// <summary>
/// The shared fixture value language, ported from the other conformance lanes.
/// </summary>
/// <remarks>
/// A fixture writes expected values as JSON. <c>{"$ref": name}</c> compares with a value an earlier
/// step captured, and <c>{"$type": kind}</c> accepts any value of that kind. Every other value must
/// match exactly, and an object must have the same keys. Values are the tree types of
/// <see cref="Json"/>.
/// </remarks>
internal static partial class Matcher
{
    /// <summary>Replaces every <c>{"$ref": name}</c> parameter with the captured value.</summary>
    internal static object? Resolve(object? value, IDictionary<string, object?> references)
    {
        if (value is List<object?> list)
        {
            return list.Select(item => Resolve(item, references)).ToList();
        }

        if (Json.Object(value) is not { } members)
        {
            return value;
        }

        if (members.Count == 1 && members.TryGetValue("$ref", out var name))
        {
            var key = Convert.ToString(name, CultureInfo.InvariantCulture)!;
            return references.TryGetValue(key, out var captured) ? captured : throw new Failure($"unknown reference {key}");
        }

        var resolved = new OrderedDictionary<string, object?>(StringComparer.Ordinal);
        foreach (var (key, item) in members)
        {
            resolved[key] = Resolve(item, references);
        }

        return resolved;
    }

    /// <summary>Matches <paramref name="actual"/> against the expected fixture value, naming the first mismatch.</summary>
    internal static void AssertValue(object? expected, object? actual, IDictionary<string, object?> references, string location)
    {
        if (Json.Object(expected) is { } members)
        {
            if (members.TryGetValue("$ref", out var reference))
            {
                AssertReference(Convert.ToString(reference, CultureInfo.InvariantCulture)!, actual, references, location);
            }
            else if (members.TryGetValue("$type", out var kind))
            {
                AssertMatcher(Convert.ToString(kind, CultureInfo.InvariantCulture)!, actual, location);
            }
            else
            {
                AssertObject(members, actual, references, location);
            }
        }
        else if (expected is List<object?> list)
        {
            AssertArray(list, actual, references, location);
        }
        else if (!Same(expected, actual))
        {
            throw new Failure($"{location} expected {Render(expected)}, received {Render(actual)}");
        }
    }

    /// <summary>Accepts <paramref name="actual"/> when it is a value of the named fixture type.</summary>
    internal static void AssertMatcher(string kind, object? actual, string location)
    {
        var accepted = kind switch
        {
            "any" => true,
            "uuid" => actual is string text && Uuid().IsMatch(text),
            "timestamp" => actual is string text && Timestamp(text),
            "string" => actual is string,
            "integer" => actual is long or BigInteger,
            "number" => actual is long or BigInteger || (actual is double number && double.IsFinite(number)),
            "boolean" => actual is bool,
            _ => throw new Failure($"{location} names unknown matcher type {kind}"),
        };
        if (!accepted)
        {
            throw new Failure($"{location} expected {kind}, received {Render(actual)}");
        }
    }

    /// <summary>Follows a dotted capture path, reading list segments as indexes.</summary>
    internal static object? ReadPointer(object? value, string pointer)
    {
        var current = value;
        foreach (var segment in pointer.Split('.'))
        {
            if (current is List<object?> list && segment.Length > 0 && segment.All(char.IsAsciiDigit))
            {
                var index = int.Parse(segment, CultureInfo.InvariantCulture);
                current = index < list.Count ? list[index] : throw new Failure($"capture pointer {pointer} does not resolve at {segment}");
            }
            else if (Json.Object(current) is { } members && members.TryGetValue(segment, out var item))
            {
                current = item;
            }
            else
            {
                throw new Failure($"capture pointer {pointer} does not resolve at {segment}");
            }
        }

        return current;
    }

    /// <summary>An instant the way every lane normalizes one: UTC, trailing fractional zeros removed.</summary>
    internal static string NormalizeTimestamp(DateTimeOffset instant)
    {
        var utc = instant.ToUniversalTime();
        var nanoseconds = utc.Ticks % TimeSpan.TicksPerSecond * 100;
        var fraction = nanoseconds.ToString("D9", CultureInfo.InvariantCulture).TrimEnd('0');
        return utc.ToString("yyyy-MM-dd'T'HH:mm:ss", CultureInfo.InvariantCulture) + (fraction.Length == 0 ? "" : "." + fraction) + "Z";
    }

    /// <summary>An RFC 3339 instant with an explicit offset and at most nine fractional digits.</summary>
    internal static bool Timestamp(string value)
    {
        var match = TimestampPattern().Match(value);
        if (!match.Success)
        {
            return false;
        }

        int Part(int group) => int.Parse(match.Groups[group].Value, CultureInfo.InvariantCulture);
        var (year, month, day) = (Part(1), Part(2), Part(3));
        if (year < 1 || month is < 1 or > 12 || day < 1 || day > DateTime.DaysInMonth(year, month))
        {
            return false;
        }

        var offset = match.Groups[8].Value;
        return Part(4) < 24 && Part(5) < 60 && Part(6) < 60
            && (offset == "Z" || (int.Parse(offset[1..3], CultureInfo.InvariantCulture) < 24 && int.Parse(offset[4..6], CultureInfo.InvariantCulture) < 60));
    }

    /// <summary>Two JSON values agree, with numbers compared by value so <c>1</c> and <c>1.0</c> agree.</summary>
    internal static bool Same(object? left, object? right)
    {
        if (IsNumber(left))
        {
            return IsNumber(right) && Decimal(left!) is { } value && Decimal(right!) is { } other && value == other;
        }

        if (left is List<object?> list)
        {
            return right is List<object?> items && list.Count == items.Count && list.Zip(items).All(pair => Same(pair.First, pair.Second));
        }

        if (Json.Object(left) is { } members)
        {
            return Json.Object(right) is { } other
                && members.Count == other.Count
                && members.All(member => other.TryGetValue(member.Key, out var item) && Same(member.Value, item));
        }

        return Equals(left, right);
    }

    /// <summary>The value as JSON text, or its string form when it has no JSON form.</summary>
    internal static string Render(object? value)
    {
        try
        {
            return Json.Write(value);
        }
        catch (ArgumentException)
        {
            return Convert.ToString(value, CultureInfo.InvariantCulture) ?? "null";
        }
    }

    private static bool IsNumber(object? value) => value is long or int or BigInteger or double or decimal;

    /// <summary>
    /// An exact rational form of a number, as a numerator over a power of ten, or <c>null</c> for a
    /// non-finite double. Two numbers are equal when their reduced forms are equal.
    /// </summary>
    private static (BigInteger Numerator, int Scale)? Decimal(object number)
    {
        string text;
        switch (number)
        {
            case long value:
                return (value, 0);
            case int value:
                return (value, 0);
            case BigInteger value:
                return (value, 0);
            case double value when !double.IsFinite(value):
                return null;
            case double value:
                text = value.ToString("R", CultureInfo.InvariantCulture);
                break;
            default:
                text = Convert.ToString(number, CultureInfo.InvariantCulture)!;
                break;
        }

        var exponent = 0;
        var e = text.IndexOfAny(['e', 'E']);
        if (e >= 0)
        {
            exponent = int.Parse(text[(e + 1)..], CultureInfo.InvariantCulture);
            text = text[..e];
        }

        var point = text.IndexOf('.', StringComparison.Ordinal);
        if (point >= 0)
        {
            exponent -= text.Length - point - 1;
            text = text.Remove(point, 1);
        }

        var numerator = BigInteger.Parse(text, CultureInfo.InvariantCulture);
        if (numerator.IsZero)
        {
            return (BigInteger.Zero, 0);
        }

        while (exponent < 0 && numerator % 10 == 0)
        {
            numerator /= 10;
            exponent++;
        }

        while (exponent > 0)
        {
            numerator *= 10;
            exponent--;
        }

        return (numerator, -exponent);
    }

    private static void AssertReference(string name, object? actual, IDictionary<string, object?> references, string location)
    {
        if (!references.TryGetValue(name, out var captured))
        {
            throw new Failure($"{location} names unknown reference {name}");
        }

        if (!Same(captured, actual))
        {
            throw new Failure($"{location} expected reference {name} = {Render(captured)}, received {Render(actual)}");
        }
    }

    private static void AssertObject(OrderedDictionary<string, object?> expected, object? actual, IDictionary<string, object?> references, string location)
    {
        if (Json.Object(actual) is not { } members)
        {
            throw new Failure($"{location} expected an object, received {Render(actual)}");
        }

        if (!expected.Keys.ToHashSet(StringComparer.Ordinal).SetEquals(members.Keys))
        {
            throw new Failure(
                $"{location} expected keys [{string.Join(", ", expected.Keys.Order(StringComparer.Ordinal))}], received [{string.Join(", ", members.Keys.Order(StringComparer.Ordinal))}]");
        }

        foreach (var (key, value) in expected)
        {
            AssertValue(value, members[key], references, $"{location}.{key}");
        }
    }

    private static void AssertArray(List<object?> expected, object? actual, IDictionary<string, object?> references, string location)
    {
        if (actual is not List<object?> list)
        {
            throw new Failure($"{location} expected an array, received {Render(actual)}");
        }

        if (expected.Count != list.Count)
        {
            throw new Failure($"{location} expected {expected.Count} items, received {list.Count}: {Render(actual)}");
        }

        for (var index = 0; index < expected.Count; index++)
        {
            AssertValue(expected[index], list[index], references, $"{location}[{index}]");
        }
    }

    [GeneratedRegex(@"^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$")]
    private static partial Regex TimestampPattern();

    [GeneratedRegex("^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")]
    private static partial Regex Uuid();
}
