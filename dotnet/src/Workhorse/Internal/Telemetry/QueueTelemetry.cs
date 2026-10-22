using System.Diagnostics;

namespace Workhorse.Internal.Telemetry;

/// <summary>The <c>workhorse.enqueue</c> span of the queue, as the TypeScript and JVM queues set it.</summary>
internal static class QueueTelemetry
{
    /// <summary>
    /// Starts the span around one enqueue or one batch enqueue. It names the queue when every
    /// request names the same one, the task type of a single request, and the count. A request
    /// without a queue goes to <paramref name="defaultQueue"/>. The requests are read only when a
    /// listener samples the span.
    /// </summary>
    internal static Activity? StartEnqueue<T>(IReadOnlyList<T> requests, string defaultQueue, Func<T, string?> queue, Func<T, string> taskType)
    {
        var span = Instrumentation.StartSpan(Names.SpanEnqueue);
        if (span is not { IsAllDataRequested: true })
        {
            return span;
        }

        string? shared = null;
        for (var index = 0; index < requests.Count; index++)
        {
            var named = queue(requests[index]);
            named = string.IsNullOrEmpty(named) ? defaultQueue : named;
            if (index == 0)
            {
                shared = named;
            }
            else if (!string.Equals(shared, named, StringComparison.Ordinal))
            {
                shared = null;
                break;
            }
        }

        if (shared is not null)
        {
            span.SetTag(Names.QueueName, shared);
        }

        if (requests.Count == 1)
        {
            span.SetTag(Names.TaskType, taskType(requests[0]));
        }

        span.SetTag(Names.EnqueueCount, (long)requests.Count);
        return span;
    }

    /// <summary>Records the result of a single enqueue on its span.</summary>
    internal static void Enqueued(Activity? span, IReadOnlyList<EnqueueResult> results)
    {
        if (span is not { IsAllDataRequested: true } || results.Count != 1)
        {
            return;
        }

        span.SetTag(Names.TaskId, results[0].TaskId.ToString());
        span.SetTag(Names.EnqueueOutcome, Outcome(results[0].Outcome));
    }

    /// <summary>
    /// Marks the span as failed with the simple name of <paramref name="error"/>, as the JVM queue
    /// does.
    /// </summary>
    internal static void Failed(Activity? span, Exception error) => Instrumentation.RecordError(span, error.GetType().Name);

    /// <summary>The outcome as the snake-case value of the other SDKs.</summary>
    private static string Outcome(EnqueueOutcome outcome) => outcome switch
    {
        EnqueueOutcome.Accepted => "accepted",
        EnqueueOutcome.Replayed => "replayed",
        EnqueueOutcome.Replaced => "replaced",
        EnqueueOutcome.NonReplaceable => "non_replaceable",
        EnqueueOutcome.Coalesced => "coalesced",
        _ => "unknown",
    };
}
