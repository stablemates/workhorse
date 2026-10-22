using System.Collections.Concurrent;
using System.Diagnostics;
using System.Diagnostics.Metrics;
using Workhorse.Internal.Telemetry;

namespace Workhorse.Tests.Testing;

/// <summary>
/// Records the activities and the measurements of the <c>workhorse</c> source and meter with the
/// runtime's <see cref="ActivityListener"/> and <see cref="MeterListener"/>, so the tests need no
/// OpenTelemetry package (ADR 0107, "Telemetry").
/// </summary>
/// <remarks>
/// Both listeners see the whole process, and other test classes run at the same time. So a test
/// selects its own records by a task ID, a queue name, or a trace ID.
/// </remarks>
internal sealed class TelemetryRecorder : IDisposable
{
    /// <summary>The name of <see cref="Caller"/>.</summary>
    private const string CallerName = "Workhorse.Tests.Caller";

    /// <summary>The source of the caller spans that the tests start around an enqueue.</summary>
    internal static readonly ActivitySource Caller = new(CallerName);

    private readonly ActivityListener _activities;
    private readonly MeterListener _meters = new();
    private readonly ConcurrentQueue<Activity> _spans = new();
    private readonly ConcurrentQueue<Measurement> _measurements = new();
    private readonly ConcurrentDictionary<string, System.Diagnostics.Metrics.Instrument> _instruments = new(StringComparer.Ordinal);

    /// <summary>
    /// One recorded measurement, and the trace of the activity that was current where the SDK
    /// recorded it, so a test can select the measurements of its own run.
    /// </summary>
    internal sealed record Measurement(string Instrument, double Value, IReadOnlyDictionary<string, object?> Tags, ActivityTraceId? Trace);

    internal TelemetryRecorder()
    {
        _activities = new ActivityListener
        {
            // The listener compares names: a comparison with the static field can run before the
            // field is set, while the field's own source asks the listeners whether they listen.
            ShouldListenTo = source => source.Name is Instrumentation.Name or CallerName,
            Sample = (ref ActivityCreationOptions<ActivityContext> _) => ActivitySamplingResult.AllDataAndRecorded,
            ActivityStopped = _spans.Enqueue,
        };
        ActivitySource.AddActivityListener(_activities);
        _meters.InstrumentPublished = (instrument, listener) =>
        {
            if (instrument.Meter.Name == Instrumentation.Name)
            {
                _instruments[instrument.Name] = instrument;
                listener.EnableMeasurementEvents(instrument);
            }
        };
        _meters.SetMeasurementEventCallback<long>((instrument, value, tags, _) => Record(instrument, value, tags));
        _meters.SetMeasurementEventCallback<double>((instrument, value, tags, _) => Record(instrument, value, tags));
        _meters.Start();
    }

    /// <summary>Each instrument of the <c>workhorse</c> meter that the listener saw published.</summary>
    internal IReadOnlyDictionary<string, System.Diagnostics.Metrics.Instrument> Instruments => _instruments;

    /// <summary>Each stopped activity.</summary>
    internal IReadOnlyList<Activity> Spans => [.. _spans];

    /// <summary>Each measurement.</summary>
    internal IReadOnlyList<Measurement> Measurements => [.. _measurements];

    /// <summary>The stopped activities named <paramref name="name"/> that <paramref name="match"/> selects.</summary>
    internal IReadOnlyList<Activity> SpansNamed(string name, Func<Activity, bool>? match = null) =>
        [.. _spans.Where(span => span.OperationName == name && (match is null || match(span)))];

    /// <summary>The measurements of <paramref name="instrument"/> that <paramref name="match"/> selects.</summary>
    internal IReadOnlyList<Measurement> Of(string instrument, Func<Measurement, bool>? match = null) =>
        [.. _measurements.Where(measurement => measurement.Instrument == instrument && (match is null || match(measurement)))];

    /// <summary>
    /// Fails when a recorded <c>workhorse</c> span, instrument, or attribute is not in
    /// <c>api/telemetry.txt</c>, or a span has more attributes than the limit.
    /// </summary>
    internal void AssertGoverned(TelemetrySurface surface)
    {
        AssertGoverned(surface, _spans.Where(span => span.Source.Name == Instrumentation.Name));
        foreach (var measurement in _measurements)
        {
            Assert.True(surface.Instruments.ContainsKey(measurement.Instrument), $"{measurement.Instrument} is not an instrument in api/telemetry.txt");
            foreach (var key in measurement.Tags.Keys)
            {
                AssertGovernedAttribute(surface, key);
            }
        }
    }

    /// <summary>
    /// Fails when one of <paramref name="spans"/> has a name or an attribute that is not in
    /// <c>api/telemetry.txt</c>, or more attributes than the limit.
    /// </summary>
    internal static void AssertGoverned(TelemetrySurface surface, IEnumerable<Activity> spans)
    {
        foreach (var span in spans)
        {
            Assert.True(surface.Spans.Contains(span.OperationName), $"{span.OperationName} is not a span in api/telemetry.txt");
            var tags = span.TagObjects.ToList();
            Assert.True(tags.Count <= Instrumentation.TraceAttributeCountLimit, $"{span.OperationName} carries {tags.Count} attributes");
            foreach (var (key, _) in tags.Concat(span.Events.SelectMany(@event => @event.Tags)))
            {
                AssertGovernedAttribute(surface, key);
            }
        }
    }

    public void Dispose()
    {
        _activities.Dispose();
        _meters.Dispose();
    }

    private static void AssertGovernedAttribute(TelemetrySurface surface, string key)
    {
        if (key.StartsWith("workhorse.", StringComparison.Ordinal))
        {
            Assert.True(surface.Attributes.Contains(key), $"{key} is not an attribute in api/telemetry.txt");
        }
    }

    private void Record(System.Diagnostics.Metrics.Instrument instrument, double value, ReadOnlySpan<KeyValuePair<string, object?>> tags)
    {
        var copy = new Dictionary<string, object?>(StringComparer.Ordinal);
        foreach (var (key, tag) in tags)
        {
            copy[key] = tag;
        }

        _measurements.Enqueue(new Measurement(instrument.Name, value, copy, Activity.Current?.TraceId));
    }
}
