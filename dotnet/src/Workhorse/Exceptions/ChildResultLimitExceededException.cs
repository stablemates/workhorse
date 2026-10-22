namespace Workhorse;

/// <summary>A child result exceeds the byte limit of its parent.</summary>
public sealed class ChildResultLimitExceededException : WorkhorseException
{
    /// <summary>An exception for the result size and the limit.</summary>
    public ChildResultLimitExceededException(long resultBytes, long limitBytes)
        : base($"child result of {resultBytes} bytes exceeds the {limitBytes} byte limit")
    {
        ResultBytes = resultBytes;
        LimitBytes = limitBytes;
    }

    /// <summary>The size of the child result, in bytes.</summary>
    public long ResultBytes { get; }

    /// <summary>The limit of the parent, in bytes.</summary>
    public long LimitBytes { get; }
}

/// <summary>Progress was written too often.</summary>
public sealed class ProgressRateLimitedException : WorkhorseException
{
    /// <summary>An exception for the time after which a write can succeed.</summary>
    public ProgressRateLimitedException(TimeSpan retryAfter)
        : base(string.Create(
            System.Globalization.CultureInfo.InvariantCulture,
            $"progress is rate limited; retry after {(decimal)retryAfter.Ticks / TimeSpan.TicksPerSecond:0.###} seconds"))
    {
        RetryAfter = retryAfter;
    }

    /// <summary>How long to wait before the next write.</summary>
    public TimeSpan RetryAfter { get; }
}
