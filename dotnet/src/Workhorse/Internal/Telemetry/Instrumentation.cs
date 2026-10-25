using System.Diagnostics;
using System.Diagnostics.Metrics;
using System.Text.Json;
using System.Text.Json.Nodes;
using Workhorse.Internal.Json;

namespace Workhorse.Internal.Telemetry;

/// <summary>
/// The <c>ActivitySource</c>, the <c>Meter</c>, and the instruments of the SDK, with the kind, unit,
/// and description of <c>api/telemetry.txt</c> (ADR 0107, "Telemetry").
/// </summary>
/// <remarks>
/// Both use the instrumentation name <c>workhorse</c> and the SDK version. Without a listener, the
/// source starts no activity and an instrument is not enabled. So each caller builds its tags only
/// after it has an activity, or after <see cref="Instrument.Enabled"/> is true.
/// </remarks>
internal static class Instrumentation
{
    /// <summary>The instrumentation name of the source and the meter.</summary>
    internal const string Name = "workhorse";

    /// <summary>The largest trace context that PostgreSQL stores, in bytes of its <c>jsonb</c> text.</summary>
    internal const int MaxTraceContextBytes = 1_024;

    /// <summary>The most attributes that Workhorse sets on one span.</summary>
    internal const int TraceAttributeCountLimit = 8;

    internal static readonly ActivitySource Source = new(Name, SdkVersion.Current);

    internal static readonly Meter Meter = new(Name, SdkVersion.Current);

    internal static readonly Counter<long> TasksClaimed =
        Meter.CreateCounter<long>("workhorse.tasks.claimed", "{task}", "Tasks claimed for handler execution");

    internal static readonly Counter<long> TasksCompleted =
        Meter.CreateCounter<long>("workhorse.tasks.completed", "{task}", "Tasks completed under a valid lease");

    internal static readonly Counter<long> TasksFailed =
        Meter.CreateCounter<long>("workhorse.tasks.failed", "{task}", "Handler failures submitted to PostgreSQL");

    internal static readonly Counter<long> TasksRetried =
        Meter.CreateCounter<long>("workhorse.tasks.retried", "{task}", "Failed or expired tasks returned to live work");

    internal static readonly Counter<long> LeasesExpired =
        Meter.CreateCounter<long>("workhorse.leases.expired", "{lease}", "Expired leases recovered by maintenance");

    internal static readonly Counter<double> HandlerRuntime =
        Meter.CreateCounter<double>("workhorse.handler.runtime", "ms", "Cumulative handler execution time");

    internal static readonly Counter<long> HandlerExecutions =
        Meter.CreateCounter<long>("workhorse.handler.executions", "{execution}", "Worker handler activations by outcome");

    internal static readonly Counter<long> HeartbeatFailure =
        Meter.CreateCounter<long>("workhorse.worker.heartbeat.failure", "{heartbeat}", "Worker heartbeats rejected by PostgreSQL ownership or timing checks");

    internal static readonly Counter<long> HeartbeatRoundFailure =
        Meter.CreateCounter<long>("workhorse.worker.heartbeat.round_failure", "{round}", "Worker heartbeat rounds that failed before PostgreSQL gave a verdict");

    internal static readonly Counter<long> ScheduleFired =
        Meter.CreateCounter<long>("workhorse.schedule.fired", "{occurrence}", "Recurring schedule occurrences durably fired");

    internal static readonly Counter<long> MaintenanceRuns =
        Meter.CreateCounter<long>("workhorse.maintenance.runs", "{run}", "Workhorse maintenance phase executions");

    internal static readonly Counter<long> MaintenanceRows =
        Meter.CreateCounter<long>("workhorse.maintenance.rows", "{row}", "Rows affected by Workhorse maintenance phases");

    internal static readonly Counter<long> MaintenanceErrors =
        Meter.CreateCounter<long>("workhorse.maintenance.errors", "{error}", "Workhorse maintenance phase failures");

    internal static readonly Histogram<double> ClaimDuration =
        Meter.CreateHistogram<double>("workhorse.claim.duration", "ms", "PostgreSQL claim operation latency");

    internal static readonly Histogram<double> HandlerDuration =
        Meter.CreateHistogram<double>("workhorse.handler.duration", "ms", "Handler execution latency");

    internal static readonly Histogram<double> HandlerBatchSize =
        Meter.CreateHistogram<double>("workhorse.handler.batch.size", "{task}", "Tasks delivered in one batch handler invocation");

    internal static readonly Histogram<double> HandlerBatchLinger =
        Meter.CreateHistogram<double>("workhorse.handler.batch.linger", "ms", "Time from the first batch member arriving until dispatch");

    internal static readonly Histogram<double> ScheduleLag =
        Meter.CreateHistogram<double>("workhorse.schedule.lag", "s", "Delay between a scheduled occurrence and its durable firing");

    internal static readonly Histogram<double> MaintenanceDuration =
        Meter.CreateHistogram<double>("workhorse.maintenance.duration", "ms", "Workhorse maintenance phase duration");

    internal static readonly Histogram<double> MaintenanceDrift =
        Meter.CreateHistogram<double>("workhorse.maintenance.drift", "ms", "Delay beyond a worker maintenance loop's configured cadence");

    /// <summary>
    /// Starts an internal span whose parent is the current activity, or returns <c>null</c> when no
    /// listener samples it.
    /// </summary>
    internal static Activity? StartSpan(string name) => Source.StartActivity(name);

    /// <summary>
    /// Marks <paramref name="span"/> as failed and adds one <c>exception</c> event with
    /// <c>exception.type</c>. The span records no message and no stack, as the JVM span does.
    /// </summary>
    internal static void RecordError(Activity? span, string errorType)
    {
        if (span is not { IsAllDataRequested: true })
        {
            return;
        }

        span.SetStatus(ActivityStatusCode.Error);
        span.AddEvent(new ActivityEvent("exception", tags: new ActivityTagsCollection
        {
            { "exception.type", errorType },
            { "exception.escaped", false },
        }));
    }

    /// <summary>
    /// The W3C trace context of the current activity, which each enqueued task carries. It is
    /// <c>null</c> without a current activity, when <c>DistributedContextPropagator.Current</c>
    /// writes no <c>traceparent</c>, or when PostgreSQL would measure it as larger than
    /// <see cref="MaxTraceContextBytes"/>.
    /// </summary>
    /// <remarks>
    /// <c>valid_trace_context_v1</c> accepts only <c>traceparent</c> and <c>tracestate</c>, so the
    /// carrier keeps only those two fields of the propagator.
    /// </remarks>
    internal static JsonObject? InjectTraceContext()
    {
        if (Activity.Current is not { } current)
        {
            return null;
        }

        var carrier = new Dictionary<string, string>(StringComparer.Ordinal);
        DistributedContextPropagator.Current.Inject(current, carrier, static (state, field, value) =>
        {
            if (state is Dictionary<string, string> fields && value is not null
                && (string.Equals(field, "traceparent", StringComparison.OrdinalIgnoreCase)
                    || string.Equals(field, "tracestate", StringComparison.OrdinalIgnoreCase)))
            {
                fields[field.ToLowerInvariant()] = value;
            }
        });
        return StoredTraceContext(carrier);
    }

    /// <summary>
    /// The <c>traceContext</c> document of <paramref name="carrier"/>, or <c>null</c> without a
    /// <c>traceparent</c> or when PostgreSQL would measure it as larger than
    /// <see cref="MaxTraceContextBytes"/>.
    /// </summary>
    internal static JsonObject? StoredTraceContext(IReadOnlyDictionary<string, string> carrier)
    {
        if (!carrier.ContainsKey("traceparent"))
        {
            return null;
        }

        var document = new JsonObject();
        foreach (var (field, value) in carrier.OrderBy(entry => entry.Key, StringComparer.Ordinal))
        {
            document[field] = value;
        }

        return JsonbSize.Of(document.ToJsonString()) <= MaxTraceContextBytes ? document : null;
    }

    /// <summary>
    /// The remote parent that a stored trace context names, or <c>default</c> when the task has no
    /// valid trace context.
    /// </summary>
    internal static ActivityContext ExtractTraceContext(JsonElement? stored)
    {
        if (stored is not { ValueKind: JsonValueKind.Object } carrier)
        {
            return default;
        }

        DistributedContextPropagator.Current.ExtractTraceIdAndState(
            carrier,
            static (state, field, out value, out values) =>
            {
                value = null;
                values = null;
                if (state is not JsonElement document)
                {
                    return;
                }

                foreach (var member in document.EnumerateObject())
                {
                    if (member.Value.ValueKind == JsonValueKind.String && string.Equals(member.Name, field, StringComparison.OrdinalIgnoreCase))
                    {
                        value = member.Value.GetString();
                        return;
                    }
                }
            },
            out var traceParent,
            out var traceState);
        return ActivityContext.TryParse(traceParent, traceState, isRemote: true, out var context) ? context : default;
    }
}
