using Workhorse.Internal;

namespace Workhorse;

/// <summary>
/// The bounds of one batch handler. <see cref="Worker.HandleBatch{TPayload}(string, BatchOptions, Func{IReadOnlyList{BatchHandlerItem{TPayload}}, CancellationToken, Task{IReadOnlyList{BatchHandlerOutcome}}})"/>
/// takes them. The counterpart of the <c>max_size</c> and <c>linger</c> keywords of Ruby's
/// <c>Worker#handle_batch</c>.
/// </summary>
/// <remarks>
/// <see cref="Worker.HandleBatch{TPayload}(string, BatchOptions, Func{IReadOnlyList{BatchHandlerItem{TPayload}}, CancellationToken, Task{IReadOnlyList{BatchHandlerOutcome}}})"/>
/// checks the bounds when it registers the handler.
/// </remarks>
public sealed record BatchOptions
{
    /// <summary>
    /// The most tasks that one handler call receives, from 1 to 100. It must not exceed the worker's
    /// concurrency.
    /// </summary>
    public required int MaxSize { get; init; }

    /// <summary>
    /// How long a claimed task waits for other tasks of its queue, a whole number of milliseconds
    /// from 0 to 60 s.
    /// </summary>
    public required TimeSpan Linger { get; init; }

    /// <summary>Checks the bounds of <see cref="MaxSize"/> and <see cref="Linger"/>.</summary>
    /// <exception cref="ArgumentOutOfRangeException"><see cref="MaxSize"/> is out of its range.</exception>
    /// <exception cref="ArgumentException"><see cref="Linger"/> is out of its range or is not a whole number of milliseconds.</exception>
    internal void Validate()
    {
        if (MaxSize is < 1 or > 100)
        {
            throw new ArgumentOutOfRangeException("maxSize", "maxSize must be between 1 and 100");
        }

        if (Linger.Ticks % TimeSpan.TicksPerMillisecond != 0)
        {
            throw new ArgumentException("linger must be a whole number of milliseconds", "linger");
        }

        Values.Milliseconds(Linger, "linger", 0, 60_000);
    }
}
