using Workhorse.Internal;

namespace Workhorse;

/// <summary>
/// The bounds of one batch handler. <see cref="Worker.HandleBatch{TPayload}(string, BatchOptions, Func{IReadOnlyList{BatchHandlerItem{TPayload}}, CancellationToken, Task{IReadOnlyList{BatchHandlerOutcome}}})"/>
/// takes them. The counterpart of the <c>max_size</c> and <c>linger</c> keywords of Ruby's
/// <c>Worker#handle_batch</c>.
/// </summary>
public sealed record BatchOptions
{
    /// <summary>Checks the bounds.</summary>
    /// <param name="maxSize">
    /// The most tasks that one handler call receives, from 1 to 100. It must not exceed the worker's
    /// concurrency, which the registration checks.
    /// </param>
    /// <param name="linger">
    /// How long a claimed task waits for other tasks of its queue, a whole number of milliseconds
    /// from 0 to 60 s.
    /// </param>
    /// <exception cref="ArgumentOutOfRangeException"><paramref name="maxSize"/> is out of its range.</exception>
    /// <exception cref="ArgumentException"><paramref name="linger"/> is out of its range or is not a whole number of milliseconds.</exception>
    public BatchOptions(int maxSize, TimeSpan linger)
    {
        if (maxSize is < 1 or > 100)
        {
            throw new ArgumentOutOfRangeException(nameof(maxSize), "maxSize must be between 1 and 100");
        }

        if (linger.Ticks % TimeSpan.TicksPerMillisecond != 0)
        {
            throw new ArgumentException("linger must be a whole number of milliseconds", nameof(linger));
        }

        Values.Milliseconds(linger, nameof(linger), 0, 60_000);
        MaxSize = maxSize;
        Linger = linger;
    }

    /// <summary>The most tasks that one handler call receives.</summary>
    public int MaxSize { get; }

    /// <summary>How long a claimed task waits for other tasks of its queue.</summary>
    public TimeSpan Linger { get; }
}
