using System.Text;
using System.Text.RegularExpressions;

namespace Workhorse.AspNetCore.Internal;

/// <summary>
/// Compiles a <c>dashboard/v1</c> schema <c>pattern</c> for <see cref="Regex"/> with ECMA-262
/// semantics (ADR 0107, "The ECMA-262 pattern policy").
/// </summary>
/// <remarks>
/// The translator accepts the subset that the <c>dashboard/v1</c> schemas use: literals, escaped
/// syntax characters, character classes and ranges, <c>\d</c>, <c>^</c>, <c>$</c>, groups,
/// non-capturing groups, alternation, and quantifiers. Outside a character class it writes
/// <c>^</c> as <c>\A</c> and <c>$</c> as <c>\z</c>, because .NET lets <c>$</c> match before a final
/// <c>\n</c>. It writes <c>\d</c> as <c>[0-9]</c>, or as <c>0-9</c> in a class, because .NET's
/// <c>\d</c> matches every Unicode decimal digit. It refuses every other construct with
/// <see cref="ArgumentException"/>, so a new construct in the contract fails a test before a
/// release.
/// </remarks>
internal sealed class EcmaPattern
{
    /// <summary>The ECMA-262 syntax characters, which an identity escape can name with the <c>u</c> flag.</summary>
    private const string Syntax = "^$\\.*+?()[]{}|/";

    private readonly string _source;
    private readonly StringBuilder _out = new();
    private int _position;
    private int _depth;

    private EcmaPattern(string source) => _source = source;

    /// <summary>
    /// The compiled pattern. A caller matches it with <see cref="Regex.IsMatch(string)"/>, because a
    /// JSON Schema pattern is not anchored unless it says so.
    /// </summary>
    /// <exception cref="ArgumentException">The pattern uses a construct outside the subset.</exception>
    internal static Regex Compile(string source) =>
        new(Translate(source), RegexOptions.NonBacktracking | RegexOptions.CultureInvariant);

    /// <summary>The .NET source for an ECMA-262 pattern in the subset.</summary>
    internal static string Translate(string source)
    {
        ArgumentNullException.ThrowIfNull(source);
        var translator = new EcmaPattern(source);
        translator.Alternatives();
        return translator._out.ToString();
    }

    private void Alternatives()
    {
        var quantifiable = false;
        while (_position < _source.Length)
        {
            var next = _source[_position];
            switch (next)
            {
                case '^':
                    _position++;
                    _out.Append("\\A");
                    quantifiable = false;
                    break;
                case '$':
                    _position++;
                    _out.Append("\\z");
                    quantifiable = false;
                    break;
                case '|':
                    _position++;
                    _out.Append('|');
                    quantifiable = false;
                    break;
                case '(':
                    Group();
                    quantifiable = true;
                    break;
                case ')':
                    if (_depth == 0)
                    {
                        throw Refuse("an unmatched )");
                    }

                    return;
                case '[':
                    CharacterClass();
                    quantifiable = true;
                    break;
                case '\\':
                    Escape(inClass: false);
                    quantifiable = true;
                    break;
                case '*' or '+' or '?' or '{':
                    if (!quantifiable)
                    {
                        throw Refuse("a quantifier without an atom");
                    }

                    Quantifier();
                    quantifiable = false;
                    break;
                case '.':
                    throw Refuse("the . wildcard");
                case ']' or '}':
                    throw Refuse($"a lone {next}");
                default:
                    _position++;
                    Literal(next);
                    quantifiable = true;
                    break;
            }
        }

        if (_depth != 0)
        {
            throw Refuse("an unclosed group");
        }
    }

    private void Group()
    {
        _position++;
        if (string.CompareOrdinal(_source, _position, "?:", 0, 2) == 0)
        {
            _position += 2;
            _out.Append("(?:");
        }
        else if (_position < _source.Length && _source[_position] == '?')
        {
            throw Refuse("a group modifier, a lookaround, or a named group");
        }
        else
        {
            _out.Append('(');
        }

        _depth++;
        Alternatives();
        if (_position >= _source.Length)
        {
            throw Refuse("an unclosed group");
        }

        _position++;
        _depth--;
        _out.Append(')');
    }

    private void Quantifier()
    {
        var next = _source[_position++];
        if (next == '{')
        {
            var close = _source.IndexOf('}', _position);
            var bounds = close < 0 ? "" : _source[_position..close];
            if (!IsBounds(bounds))
            {
                throw Refuse("a malformed {} quantifier");
            }

            _out.Append('{').Append(bounds).Append('}');
            _position = close + 1;
        }
        else
        {
            _out.Append(next);
        }

        if (_position < _source.Length && _source[_position] == '?')
        {
            _position++;
            _out.Append('?');
        }
    }

    /// <summary>Whether <paramref name="bounds"/> is <c>n</c>, <c>n,</c>, or <c>n,m</c> with ASCII digits.</summary>
    private static bool IsBounds(string bounds)
    {
        var comma = bounds.IndexOf(',', StringComparison.Ordinal);
        var lower = comma < 0 ? bounds : bounds[..comma];
        var upper = comma < 0 ? "" : bounds[(comma + 1)..];
        return lower.Length > 0 && lower.All(char.IsAsciiDigit) && upper.All(char.IsAsciiDigit);
    }

    private void CharacterClass()
    {
        _position++;
        _out.Append('[');
        if (_position < _source.Length && _source[_position] == '^')
        {
            _position++;
            _out.Append('^');
        }

        if (_position < _source.Length && _source[_position] == ']')
        {
            throw Refuse("an empty character class");
        }

        while (true)
        {
            if (_position >= _source.Length)
            {
                throw Refuse("an unclosed character class");
            }

            if (_source[_position] == ']')
            {
                _position++;
                _out.Append(']');
                return;
            }

            var set = ClassAtom();
            if (_position + 1 < _source.Length && _source[_position] == '-' && _source[_position + 1] != ']')
            {
                _position++;
                _out.Append('-');

                // ECMA-262 with the u flag refuses a range whose endpoint is a set such as \d.
                if (ClassAtom() || set)
                {
                    throw Refuse("a range with a character set endpoint");
                }
            }
        }
    }

    /// <summary>Writes one class atom, and tells whether it is a set rather than one character.</summary>
    private bool ClassAtom()
    {
        var next = _source[_position];
        if (next == '\\')
        {
            var set = _position + 1 < _source.Length && _source[_position + 1] == 'd';
            Escape(inClass: true);
            return set;
        }

        _position++;

        // `[` starts a .NET class subtraction after `-`, and `^` negates at the start of a class.
        if (next is '[' or '^')
        {
            _out.Append('\\');
        }

        Literal(next);
        return false;
    }

    private void Escape(bool inClass)
    {
        if (_position + 1 >= _source.Length)
        {
            throw Refuse("a trailing backslash");
        }

        var next = _source[_position + 1];
        _position += 2;
        if (next == 'd')
        {
            _out.Append(inClass ? "0-9" : "[0-9]");
        }
        else if (Syntax.Contains(next, StringComparison.Ordinal) || (inClass && next == '-'))
        {
            _out.Append('\\').Append(next);
        }
        else
        {
            throw Refuse($"the escape \\{next}");
        }
    }

    private void Literal(char character)
    {
        if (char.IsWhiteSpace(character) || char.IsControl(character))
        {
            throw Refuse("a whitespace or control character");
        }

        _out.Append(character);
    }

    private ArgumentException Refuse(string construct) =>
        new($"dashboard/v1 pattern {_source} uses {construct}, which the translator refuses");
}
