using System.Globalization;
using System.Numerics;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Workhorse.Internal.Contracts;
using Workhorse.Internal.Json;

namespace Workhorse.Internal.Durable;

/// <summary>
/// The RFC 8785 canonical JSON of a checkpoint input, and its SHA-256 fingerprint (ADR 0098, ADR
/// 0107 "RFC 8785 canonical JSON"). The counterpart of the JVM's <c>CanonicalJson</c>.
/// </summary>
/// <remarks>
/// The input is JSON text. Object keys sort by their UTF-16 code units, which is the order of
/// <see cref="string.CompareOrdinal(string, string)"/>. A string escapes only the quote, the
/// backslash, and the control characters. A number writes in the ECMAScript form of its IEEE 754
/// double.
/// </remarks>
internal static class CanonicalJson
{
    internal const string RangeMessage = "checkpoint input numbers must be at most 2^53 - 1 in magnitude";

    // I-JSON (RFC 7493) keeps integers to the range that an IEEE 754 double holds exactly. A double
    // of 2^53 or more in magnitude is an integer, so the bound refuses no fraction (ADR 0098).
    private const long MaxSafeInteger = (1L << 53) - 1;
    private const int MaxPlainPoint = 21;
    private const int MinPlainPoint = -6;
    private const int MaxSafeDigits = 16;

    /// <summary>The SHA-256 digest of the canonical JSON of <paramref name="json"/>, as 64 lowercase hexadecimal digits.</summary>
    /// <exception cref="ArgumentException">The text holds a value that ADR 0098 refuses.</exception>
    internal static string Fingerprint(string json) =>
        Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(Canonical(json))));

    /// <summary>The canonical JSON text of the JSON text <paramref name="json"/>.</summary>
    /// <exception cref="ArgumentException">The text is not one JSON value, or it holds a value that ADR 0098 refuses.</exception>
    internal static string Canonical(string json)
    {
        JsonDocument document;
        try
        {
            document = JsonDocument.Parse(json, JsonTree.DocumentOptions);
        }
        catch (JsonException error)
        {
            throw new ArgumentException($"checkpoint input is not a JSON value: {error.Message}", error);
        }

        using (document)
        {
            var output = new StringBuilder();
            Write(document.RootElement, output);
            return output.ToString();
        }
    }

    /// <summary>
    /// The ECMAScript <c>Number::toString</c> form of a finite double. Since .NET Core 3.0, the
    /// <c>R</c> format gives the shortest digits that read back as the same double. This method keeps
    /// those digits and writes them in the ECMAScript notation: .NET writes <c>1E-07</c>, and
    /// ECMAScript writes <c>1e-7</c>.
    /// </summary>
    internal static string Number(double value)
    {
        if (!double.IsFinite(value))
        {
            throw new ArgumentException("checkpoint input contains a number outside the double range");
        }

        if (value == 0)
        {
            return "0";
        }

        var text = Math.Abs(value).ToString("R", CultureInfo.InvariantCulture);
        var exponent = 0;
        var marker = text.IndexOfAny(['E', 'e']);
        if (marker >= 0)
        {
            exponent = int.Parse(text.AsSpan(marker + 1), NumberStyles.AllowLeadingSign, CultureInfo.InvariantCulture);
            text = text[..marker];
        }

        var dot = text.IndexOf('.', StringComparison.Ordinal);
        var digits = dot < 0 ? text : string.Concat(text.AsSpan(0, dot), text.AsSpan(dot + 1));
        // The value is 0.digits * 10^point.
        var point = (dot < 0 ? text.Length : dot) + exponent;
        var leading = digits.Length - digits.TrimStart('0').Length;
        digits = digits[leading..].TrimEnd('0');
        point -= leading;
        return (value < 0 ? "-" : string.Empty) + Notation(digits, point);
    }

    private static void Write(JsonElement element, StringBuilder output)
    {
        switch (element.ValueKind)
        {
            case JsonValueKind.Object:
                WriteObject(element, output);
                break;
            case JsonValueKind.Array:
                output.Append('[');
                var first = true;
                foreach (var item in element.EnumerateArray())
                {
                    if (!first)
                    {
                        output.Append(',');
                    }

                    first = false;
                    Write(item, output);
                }

                output.Append(']');
                break;
            case JsonValueKind.String:
                WriteString(Text(element.GetString), output);
                break;
            case JsonValueKind.Number:
                output.Append(Token(element.GetRawText()));
                break;
            case JsonValueKind.True:
                output.Append("true");
                break;
            case JsonValueKind.False:
                output.Append("false");
                break;
            default:
                output.Append("null");
                break;
        }
    }

    private static void WriteObject(JsonElement element, StringBuilder output)
    {
        // A duplicate member keeps the last value, as PostgreSQL's jsonb does.
        var members = new Dictionary<string, JsonElement>(StringComparer.Ordinal);
        foreach (var property in element.EnumerateObject())
        {
            var key = Text(() => property.Name);
            if (members.TryGetValue(key, out var replaced))
            {
                // The replaced value must be valid too, so a duplicate key cannot hide a refused number.
                Write(replaced, new StringBuilder());
            }

            members[key] = property.Value;
        }

        // A .NET string is a sequence of UTF-16 code units, so the ordinal order is the RFC 8785 order.
        var keys = members.Keys.ToList();
        keys.Sort(string.CompareOrdinal);
        output.Append('{');
        for (var index = 0; index < keys.Count; index++)
        {
            if (index > 0)
            {
                output.Append(',');
            }

            WriteString(keys[index], output);
            output.Append(':');
            Write(members[keys[index]], output);
        }

        output.Append('}');
    }

    /// <summary>
    /// The canonical form of one number token. The bound reads the exact token, because the parse to
    /// a double can round a token above the bound to the bound.
    /// </summary>
    private static string Token(string token)
    {
        var value = double.Parse(token, NumberStyles.Float, CultureInfo.InvariantCulture);
        if (!double.IsFinite(value))
        {
            throw new ArgumentException("checkpoint input contains a number outside the double range");
        }

        var unsafeNumber = AboveBound(token);
        return unsafeNumber ? throw new ArgumentException(RangeMessage) : Number(value);
    }

    /// <summary>
    /// Whether the exact value of the number token <paramref name="token"/> is more than 2^53 - 1 in
    /// magnitude. The check reads the digits of the token, so no precision or storage limit applies.
    /// </summary>
    private static bool AboveBound(string token)
    {
        var text = token.TrimStart('-');
        var marker = text.IndexOfAny(['E', 'e']);
        var exponent = marker < 0 ? BigInteger.Zero : BigInteger.Parse(text.AsSpan(marker + 1), NumberStyles.AllowLeadingSign, CultureInfo.InvariantCulture);
        var mantissa = marker < 0 ? text : text[..marker];
        var dot = mantissa.IndexOf('.', StringComparison.Ordinal);
        var digits = dot < 0 ? mantissa : string.Concat(mantissa.AsSpan(0, dot), mantissa.AsSpan(dot + 1));
        // The value is 0.digits * 10^point.
        var point = (dot < 0 ? mantissa.Length : dot) + exponent;
        var leading = digits.Length - digits.TrimStart('0').Length;
        digits = digits[leading..].TrimEnd('0');
        point -= leading;
        if (digits.Length == 0 || point <= 0)
        {
            return false;
        }

        // 2^53 - 1 has 16 digits, so a value with more digits before the point is above it.
        if (point > MaxSafeDigits)
        {
            return true;
        }

        var whole = (int)point;
        var integer = BigInteger.Parse(whole <= digits.Length ? digits[..whole] : digits + new string('0', whole - digits.Length), CultureInfo.InvariantCulture);
        return integer > MaxSafeInteger || (integer == MaxSafeInteger && whole < digits.Length);
    }

    private static string Notation(string digits, int point)
    {
        var count = digits.Length;
        if (point >= count && point <= MaxPlainPoint)
        {
            return digits + new string('0', point - count);
        }

        if (point > 0 && point <= MaxPlainPoint)
        {
            return $"{digits[..point]}.{digits[point..]}";
        }

        if (point > MinPlainPoint && point <= 0)
        {
            return $"0.{new string('0', -point)}{digits}";
        }

        var exponent = point - 1;
        var mantissa = count == 1 ? digits : $"{digits[0]}.{digits[1..]}";
        return string.Create(CultureInfo.InvariantCulture, $"{mantissa}e{(exponent < 0 ? '-' : '+')}{Math.Abs(exponent)}");
    }

    /// <summary>
    /// RFC 8785 escapes only the quote, the backslash, and the control characters. A control
    /// character without a short escape uses six characters with lowercase hexadecimal digits.
    /// </summary>
    private static void WriteString(string text, StringBuilder output)
    {
        output.Append('"');
        foreach (var character in text)
        {
            switch (character)
            {
                case '"':
                    output.Append("\\\"");
                    break;
                case '\\':
                    output.Append("\\\\");
                    break;
                case '\b':
                    output.Append("\\b");
                    break;
                case '\t':
                    output.Append("\\t");
                    break;
                case '\n':
                    output.Append("\\n");
                    break;
                case '\f':
                    output.Append("\\f");
                    break;
                case '\r':
                    output.Append("\\r");
                    break;
                case < ' ':
                    output.Append(CultureInfo.InvariantCulture, $"\\u{(int)character:x4}");
                    break;
                default:
                    output.Append(character);
                    break;
            }
        }

        output.Append('"');
    }

    /// <summary>
    /// A string of the parsed text. <see cref="JsonElement.GetString"/> throws for an escaped lone
    /// surrogate, and an unescaped one cannot reach valid UTF-8, so no lone surrogate passes.
    /// </summary>
    private static string Text(Func<string?> read)
    {
        string text;
        try
        {
            text = read()!;
        }
        catch (InvalidOperationException error)
        {
            throw new ArgumentException("checkpoint input strings must not hold a lone surrogate", error);
        }

        return Utf16.HasLoneSurrogate(text)
            ? throw new ArgumentException("checkpoint input strings must not hold a lone surrogate")
            : text;
    }
}
