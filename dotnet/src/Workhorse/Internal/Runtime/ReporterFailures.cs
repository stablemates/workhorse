namespace Workhorse.Internal.Runtime;

/// <summary>
/// When the worker last logged a failure of one reporter event handler. A handler that always
/// fails writes at most one record in each interval.
/// </summary>
internal sealed class ReporterFailures
{
    /// <summary>The interval that bounds the records of a handler that always fails.</summary>
    internal static readonly long ReportIntervalNanos = Monotonic.Millis(60_000);

    private readonly Lock _lock = new();
    private bool _reported;

    // Failures since ReportedAt that the worker did not log.
    private long _suppressed;

    /// <summary>The monotonic time of the last record.</summary>
    internal long ReportedAt { get; set; }

    /// <summary>
    /// The failures that the worker did not log since the last record, or -1 when the worker does
    /// not log this failure.
    /// </summary>
    internal long Admit(long now)
    {
        lock (_lock)
        {
            if (_reported && now - ReportedAt < ReportIntervalNanos)
            {
                _suppressed++;
                return -1;
            }

            var unreported = _suppressed;
            _reported = true;
            ReportedAt = now;
            _suppressed = 0;
            return unreported;
        }
    }
}
