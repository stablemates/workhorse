using System.Diagnostics;

namespace Workhorse.Internal.Runtime;

/// <summary>
/// A monotonic clock in nanoseconds. Compare two values only by their difference, as
/// <c>a - b &gt; 0</c>, so a wrap of the counter cannot change the order.
/// </summary>
internal static class Monotonic
{
    private static readonly double NanosPerTick = 1_000_000_000.0 / Stopwatch.Frequency;

    /// <summary>The current time.</summary>
    internal static long Now() =>
        Stopwatch.Frequency == 1_000_000_000 ? Stopwatch.GetTimestamp() : (long)(Stopwatch.GetTimestamp() * NanosPerTick);

    /// <summary>The nanoseconds of <paramref name="span"/>, saturated at the range of <see cref="long"/>.</summary>
    internal static long Nanos(TimeSpan span) =>
        span.Ticks > long.MaxValue / 100 ? long.MaxValue : span.Ticks < long.MinValue / 100 ? long.MinValue : span.Ticks * 100;

    /// <summary>The nanoseconds of <paramref name="milliseconds"/>.</summary>
    internal static long Millis(long milliseconds) => milliseconds * 1_000_000;

    /// <summary><paramref name="nanos"/> as a span, at least zero.</summary>
    internal static TimeSpan Span(long nanos) => TimeSpan.FromTicks(Math.Max(0, nanos / 100));
}
