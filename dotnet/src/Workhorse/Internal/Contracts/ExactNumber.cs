using System.Globalization;
using System.Numerics;

namespace Workhorse.Internal.Contracts;

/// <summary>
/// A JSON number with every digit of its token: <c>Mantissa × 10^Exponent</c>, without trailing
/// zeros in the mantissa. A contract compares its constants exactly, so <c>0.1</c> is not the
/// nearest double (SM-1520). <see cref="decimal"/> holds too few digits for the profile fixtures.
/// </summary>
internal readonly struct ExactNumber : IComparable<ExactNumber>, IEquatable<ExactNumber>
{
    /// <summary>The most digits before the decimal point that PostgreSQL's <c>numeric</c> stores.</summary>
    internal const int MaxIntegerDigits = 131_072;

    /// <summary>The most digits after the decimal point that PostgreSQL's <c>numeric</c> stores.</summary>
    internal const int MaxFractionDigits = 16_383;

    private ExactNumber(BigInteger mantissa, int exponent)
    {
        if (mantissa.IsZero)
        {
            exponent = 0;
        }
        else
        {
            while (BigInteger.Remainder(mantissa, 10).IsZero)
            {
                mantissa /= 10;
                exponent++;
            }
        }

        Mantissa = mantissa;
        Exponent = exponent;
    }

    internal BigInteger Mantissa { get; }

    internal int Exponent { get; }

    internal int Sign => Mantissa.Sign;

    /// <summary>Whether the value has no fraction.</summary>
    internal bool IsInteger => Exponent >= 0;

    private int Digits => Mantissa.IsZero ? 1 : BigInteger.Abs(Mantissa).ToString(CultureInfo.InvariantCulture).Length;

    internal static ExactNumber From(long value) => new(value, 0);

    /// <summary>
    /// The number of a JSON number token.
    /// </summary>
    /// <exception cref="ArgumentException">The token is not a JSON number, or PostgreSQL's
    /// <c>numeric</c> type cannot store it.</exception>
    internal static ExactNumber Parse(string token)
    {
        var index = 0;
        var negative = token.StartsWith('-');
        if (negative)
        {
            index++;
        }

        var exponentAt = token.IndexOfAny(['e', 'E']);
        var significand = exponentAt < 0 ? token[index..] : token[index..exponentAt];
        long exponent = 0;
        if (exponentAt >= 0 && !long.TryParse(token.AsSpan(exponentAt + 1), NumberStyles.AllowLeadingSign, CultureInfo.InvariantCulture, out exponent))
        {
            throw new ArgumentException($"the number {Abbreviate(token)} is outside the numeric range");
        }

        var point = significand.IndexOf('.', StringComparison.Ordinal);
        var digits = point < 0 ? significand : string.Concat(significand.AsSpan(0, point), significand.AsSpan(point + 1));
        if (digits.Length == 0 || !digits.All(char.IsAsciiDigit))
        {
            throw new ArgumentException($"{Abbreviate(token)} is not a JSON number");
        }

        exponent -= point < 0 ? 0 : significand.Length - point - 1;
        var trimmed = digits.TrimStart('0');
        if (trimmed.Length == 0)
        {
            return default;
        }

        var significant = trimmed.TrimEnd('0');
        exponent += trimmed.Length - significant.Length;
        var before = significant.Length + exponent;
        if (before > MaxIntegerDigits || -exponent > MaxFractionDigits)
        {
            throw new ArgumentException($"the number {Abbreviate(token)} is outside the numeric range");
        }

        var mantissa = BigInteger.Parse(significant, NumberStyles.None, CultureInfo.InvariantCulture);
        return new ExactNumber(negative ? -mantissa : mantissa, (int)exponent);
    }

    public int CompareTo(ExactNumber other)
    {
        if (Sign != other.Sign)
        {
            return Sign.CompareTo(other.Sign);
        }

        if (Sign == 0)
        {
            return 0;
        }

        // Equal signs: the order of magnitude decides, and only an equal order needs a scale.
        var order = Digits + Exponent;
        var otherOrder = other.Digits + other.Exponent;
        if (order != otherOrder)
        {
            return Sign * order.CompareTo(otherOrder);
        }

        var exponent = Math.Min(Exponent, other.Exponent);
        return Scale(exponent).CompareTo(other.Scale(exponent));
    }

    /// <summary>Whether this number is a whole multiple of <paramref name="divisor"/>, which is positive.</summary>
    internal bool IsMultipleOf(ExactNumber divisor)
    {
        if (Sign == 0)
        {
            return true;
        }

        var numerator = BigInteger.Abs(Mantissa);
        var denominator = divisor.Mantissa;
        var shift = (long)Exponent - divisor.Exponent;
        if (shift >= 0)
        {
            // numerator × 10^shift is a multiple of denominator. A shift beyond 4 bits for each
            // denominator digit already supplies every factor 2 and 5 that the denominator has.
            var bounded = (int)Math.Min(shift, 4L * divisor.Digits);
            return (numerator * BigInteger.Pow(10, bounded) % denominator).IsZero;
        }

        // numerator must be a multiple of denominator × 10^-shift, which is larger than a
        // numerator with fewer digits than the shift.
        return -shift <= Digits && (numerator % (denominator * BigInteger.Pow(10, (int)-shift))).IsZero;
    }

    public bool Equals(ExactNumber other) => Mantissa == other.Mantissa && Exponent == other.Exponent;

    public override bool Equals(object? obj) => obj is ExactNumber other && Equals(other);

    public override int GetHashCode() => HashCode.Combine(Mantissa, Exponent);

    public override string ToString() =>
        string.Create(CultureInfo.InvariantCulture, $"{Mantissa}E{Exponent}");

    public static bool operator ==(ExactNumber left, ExactNumber right) => left.Equals(right);

    public static bool operator !=(ExactNumber left, ExactNumber right) => !left.Equals(right);

    public static bool operator <(ExactNumber left, ExactNumber right) => left.CompareTo(right) < 0;

    public static bool operator <=(ExactNumber left, ExactNumber right) => left.CompareTo(right) <= 0;

    public static bool operator >(ExactNumber left, ExactNumber right) => left.CompareTo(right) > 0;

    public static bool operator >=(ExactNumber left, ExactNumber right) => left.CompareTo(right) >= 0;

    private BigInteger Scale(int exponent) => Mantissa * BigInteger.Pow(10, Exponent - exponent);

    private static string Abbreviate(string token) => token.Length <= 40 ? token : $"{token[..40]}...";
}
