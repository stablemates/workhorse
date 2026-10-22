using System.Globalization;
using System.Text;

namespace Workhorse.Internal.Json;

/// <summary>
/// Measures the UTF-8 length of the <c>jsonb</c> text of PostgreSQL for a JSON document. The
/// value size limits compare that length, as <c>octet_length(value::text)</c> does. It is the
/// counterpart of the JVM <c>JsonbSize</c> and of Ruby's <c>Values.jsonb_text_bytes</c>.
/// </summary>
/// <remarks>
/// That text keeps the last of duplicate keys, puts a space after each <c>:</c> and <c>,</c>,
/// escapes strings as <c>JSON.stringify</c> does, and writes numbers in plain decimal notation
/// without the sign of a zero. Each number is measured from its own token, because <c>jsonb</c>
/// keeps the scale that a <see cref="double"/> loses. The input must be valid JSON.
/// </remarks>
internal sealed class JsonbSize
{
    private readonly string _text;
    private int _position;

    private JsonbSize(string text)
    {
        _text = text;
    }

    /// <summary>The byte length of the <c>jsonb</c> text of PostgreSQL for the document <paramref name="json"/>.</summary>
    /// <exception cref="ArgumentException">The text is not one JSON value.</exception>
    internal static long Of(string json)
    {
        var measure = new JsonbSize(json);
        try
        {
            measure.Space();
            var bytes = measure.Value();
            measure.Space();
            return measure._position == json.Length
                ? bytes
                : throw new ArgumentException("trailing characters after the JSON value");
        }
        catch (IndexOutOfRangeException error)
        {
            throw new ArgumentException("the JSON value ends early", error);
        }
    }

    private long Value()
    {
        Space();
        return _text[_position] switch
        {
            '{' => Object(),
            '[' => Array(),
            '"' => StringBytes(String()),
            't' or 'n' => Literal(4),
            'f' => Literal(5),
            _ => Number(),
        };
    }

    private long Literal(int length)
    {
        _position += length;
        return length;
    }

    private long Object()
    {
        _position++;
        var members = new Dictionary<string, long>(StringComparer.Ordinal);
        Space();
        if (_text[_position] == '}')
        {
            _position++;
            return 2;
        }

        while (true)
        {
            Space();
            var key = String();
            Space();
            _position++; // ':'
            members[key] = Value();
            Space();
            if (_text[_position++] == '}')
            {
                break;
            }
        }

        var bytes = 2L * members.Count;
        foreach (var (key, value) in members)
        {
            bytes += StringBytes(key) + 2 + value;
        }

        return bytes;
    }

    private long Array()
    {
        _position++;
        Space();
        if (_text[_position] == ']')
        {
            _position++;
            return 2;
        }

        long bytes = 0;
        var count = 0;
        while (true)
        {
            bytes += Value();
            count++;
            Space();
            if (_text[_position++] == ']')
            {
                break;
            }
        }

        return bytes + (2L * count);
    }

    /// <summary>Reads a string token and returns its decoded text.</summary>
    private string String()
    {
        _position++; // '"'
        var builder = new StringBuilder();
        while (true)
        {
            var character = _text[_position++];
            if (character == '"')
            {
                return builder.ToString();
            }

            if (character != '\\')
            {
                builder.Append(character);
                continue;
            }

            var escape = _text[_position++];
            switch (escape)
            {
                case 'b':
                    builder.Append('\b');
                    break;
                case 'f':
                    builder.Append('\f');
                    break;
                case 'n':
                    builder.Append('\n');
                    break;
                case 'r':
                    builder.Append('\r');
                    break;
                case 't':
                    builder.Append('\t');
                    break;
                case 'u':
                    builder.Append((char)int.Parse(_text.AsSpan(_position, 4), NumberStyles.AllowHexSpecifier, CultureInfo.InvariantCulture));
                    _position += 4;
                    break;
                default:
                    builder.Append(escape);
                    break;
            }
        }
    }

    /// <summary>The bytes of <paramref name="value"/> as a <c>jsonb</c> string, with its quotes.</summary>
    private static long StringBytes(string value)
    {
        long bytes = 2;
        for (var index = 0; index < value.Length; index++)
        {
            var character = value[index];
            if (character is '"' or '\\' or '\b' or '\f' or '\n' or '\r' or '\t')
            {
                bytes += 2;
            }
            else if (character < 0x20)
            {
                bytes += 6;
            }
            else if (char.IsHighSurrogate(character) && index + 1 < value.Length && char.IsLowSurrogate(value[index + 1]))
            {
                bytes += 4;
                index++;
            }
            else
            {
                bytes += Encoding.UTF8.GetByteCount([character]);
            }
        }

        return bytes;
    }

    /// <summary>
    /// The bytes of <c>numeric_out</c> for one number token: the integer part without leading
    /// zeros, or a single zero, and as many fraction digits as the token had after its decimal
    /// point, shifted by the exponent.
    /// </summary>
    private long Number()
    {
        var start = _position;
        var negative = _text[_position] == '-';
        if (negative)
        {
            _position++;
        }

        var integerStart = _position;
        while (_position < _text.Length && char.IsAsciiDigit(_text[_position]))
        {
            _position++;
        }

        var integer = _text[integerStart.._position];
        var fraction = "";
        if (_position < _text.Length && _text[_position] == '.')
        {
            var fractionStart = ++_position;
            while (_position < _text.Length && char.IsAsciiDigit(_text[_position]))
            {
                _position++;
            }

            fraction = _text[fractionStart.._position];
        }

        long exponent = 0;
        if (_position < _text.Length && _text[_position] is 'e' or 'E')
        {
            var exponentStart = ++_position;
            if (_text[_position] is '+' or '-')
            {
                _position++;
            }

            while (_position < _text.Length && char.IsAsciiDigit(_text[_position]))
            {
                _position++;
            }

            exponent = long.Parse(_text.AsSpan(exponentStart, _position - exponentStart), NumberStyles.AllowLeadingSign, CultureInfo.InvariantCulture);
        }

        if (integer.Length == 0)
        {
            throw new ArgumentException(string.Create(CultureInfo.InvariantCulture, $"invalid number at {start}"));
        }

        var digits = integer + fraction;
        var significant = digits.TrimStart('0');
        var point = integer.Length + exponent - (digits.Length - significant.Length);
        var scale = Math.Max(0, fraction.Length - exponent);
        var integerBytes = significant.Length == 0 ? 1 : Math.Max(1, point);
        var signBytes = !negative || significant.Length == 0 ? 0 : 1;
        return signBytes + integerBytes + (scale > 0 ? 1 + scale : 0);
    }

    private void Space()
    {
        while (_position < _text.Length && _text[_position] is ' ' or '\t' or '\n' or '\r')
        {
            _position++;
        }
    }
}
