using System.Diagnostics;
using System.Diagnostics.Metrics;
using System.Reflection;
using System.Runtime.CompilerServices;
using Workhorse.Internal;
using Workhorse.Internal.Telemetry;
using Workhorse.Tests.Testing;

namespace Workhorse.Tests.Telemetry;

/// <summary>
/// Holds the names that the .NET SDK declares to <c>api/telemetry.txt</c> (ADR 0107, "Telemetry",
/// in the form of the ADR 0103 amendment of 2026-10-18).
/// </summary>
/// <remarks>
/// The file is the TypeScript surface. The .NET SDK declares the span and metric set of the JVM SDK.
/// Each name in the file is declared here or is on <see cref="NotEmitted"/>, so a name that the file
/// adds fails this test until the .NET SDK emits it or the list names it.
/// </remarks>
public sealed class TelemetrySurfaceTests
{
    /// <summary>
    /// The queue and budget gauges of the TypeScript-only <c>registerQueueMetrics</c> operator
    /// function (SM-1532).
    /// </summary>
    private static readonly string[] QueueMetrics =
    [
        "workhorse.budget.blocked_ready",
        "workhorse.budget.concurrency.active",
        "workhorse.budget.concurrency.limit",
        "workhorse.budget.name",
        "workhorse.budget.next_eligible_delay",
        "workhorse.budget.rate_limit.available_tokens",
        "workhorse.budget.rate_limit.configured",
        "workhorse.queue.children.canceled_parents",
        "workhorse.queue.children.capped",
        "workhorse.queue.children.failed_parents",
        "workhorse.queue.children.pending",
        "workhorse.queue.children.unjoined_results",
        "workhorse.queue.children.waiting_parents",
        "workhorse.queue.concurrency.active",
        "workhorse.queue.concurrency.blocked_ready",
        "workhorse.queue.concurrency.limit",
        "workhorse.queue.dependencies.blocked",
        "workhorse.queue.dependencies.capped",
        "workhorse.queue.dependencies.failed_resolutions",
        "workhorse.queue.dependencies.pending_edges",
        "workhorse.queue.depth",
        "workhorse.queue.oldest_ready_age",
        "workhorse.queue.rate_limit.available_tokens",
        "workhorse.queue.rate_limit.configured",
        "workhorse.queue.rate_limit.next_eligible_delay",
        "workhorse.queue.rate_limit.throttled_ready",
    ];

    /// <summary>The gauges of the TypeScript-only <c>WorkhorseMetricsObserver</c> operator class.</summary>
    private static readonly string[] MetricsObserver =
    [
        "workhorse.deadline.overdue",
        "workhorse.execution_timeout.overdue",
        "workhorse.lease.expired",
        "workhorse.maintenance.routine",
        "workhorse.maintenance.routine.age",
        "workhorse.maintenance.routine.overdue",
        "workhorse.queue.oldest_ready.age",
        "workhorse.queue.paused",
        "workhorse.retention.category",
        "workhorse.retention.enabled",
        "workhorse.retention.lag",
        "workhorse.retention.lag_budget",
        "workhorse.tasks.count",
        "workhorse.wait.delivery.rejected",
        "workhorse.wait.kind",
        "workhorse.wait.overdue",
        "workhorse.wait.pending",
        "workhorse.worker.active",
        "workhorse.worker.capacity",
        "workhorse.worker.count",
        "workhorse.worker.state",
    ];

    /// <summary>The span of the TypeScript <c>Queue.heartbeat</c> method. The .NET SDK has no single heartbeat.</summary>
    private static readonly string[] SingleHeartbeat = ["workhorse.heartbeat"];

    /// <summary>The TypeScript-only <c>syncMaintenancePolicy</c> and <c>setColdExportPolicy</c> methods.</summary>
    private static readonly string[] PolicySync = ["workhorse.cold_export.enabled", "workhorse.maintenance.timezone"];

    /// <summary>The TypeScript batch completion span. The .NET worker gives each completion its own span.</summary>
    private static readonly string[] FusedCompletion = ["workhorse.complete.batch_size"];

    /// <summary>The cancel, redrive, schedule sync, and enqueue outcome names, which SM-1609 owns for every SDK.</summary>
    private static readonly string[] QueueAndAdmin =
    [
        "workhorse.cancellation.status",
        "workhorse.operation.status",
        "workhorse.redrive.dry_run",
        "workhorse.redrive.status",
        "workhorse.redrive.target_task_id",
        "workhorse.schedule.count",
        "workhorse.schedule.definition_count",
        "workhorse.schedule.synchronize",
        "workhorse.task.count",
        "workhorse.task.state",
        "workhorse.tasks.cancellation",
        "workhorse.tasks.enqueue.outcomes",
        "workhorse.tasks.enqueued",
        "workhorse.tasks.redrive",
    ];

    /// <summary>
    /// The attributes of the JVM log records. The .NET worker and queue log through <c>ILogger</c>
    /// (ADR 0107, "Telemetry"), which names each value by its message template, so no log record
    /// carries these attributes.
    /// </summary>
    private static readonly string[] LogRecordAttributes =
    [
        "workhorse.cancel.accepted",
        "workhorse.checkpoint.name",
        "workhorse.checkpoint.status",
        "workhorse.child.count",
        "workhorse.child.name",
        "workhorse.child.status",
        "workhorse.expiration.status",
        "workhorse.handler.batch.evidence_phase",
        "workhorse.handler.batch.linger_ms",
        "workhorse.handler.batch.max_size",
        "workhorse.handler.duration_ms",
        "workhorse.human_wait.name",
        "workhorse.human_wait.status",
        "workhorse.progress.status",
        "workhorse.release.status",
        "workhorse.signal.name",
        "workhorse.signal.status",
        "workhorse.wait.name",
        "workhorse.wait.status",
        "workhorse.worker.active_slots",
        "workhorse.worker.concurrency",
        "workhorse.worker.deregistered",
        "workhorse.worker.draining",
        "workhorse.worker.elapsed_ms",
        "workhorse.worker.id",
        "workhorse.worker.paused",
        "workhorse.worker.pool_max_size",
        "workhorse.worker.queues",
        "workhorse.worker.statement",
    ];

    /// <summary>
    /// The TypeScript-only counter of failed heartbeat rounds and its attribute. SM-1704 adds them
    /// to the .NET worker and removes this group.
    /// </summary>
    private static readonly string[] HeartbeatRoundFailure =
    [
        "workhorse.heartbeat.failure_reason",
        "workhorse.worker.heartbeat.round_failure",
    ];

    /// <summary>The names of <c>api/telemetry.txt</c> that the .NET SDK does not emit.</summary>
    private static readonly string[][] NotEmitted =
        [QueueMetrics, MetricsObserver, SingleHeartbeat, PolicySync, FusedCompletion, QueueAndAdmin, LogRecordAttributes, HeartbeatRoundFailure];

    private static readonly TelemetrySurface Surface = TelemetrySurface.Read();

    [Fact]
    public void TheSourceAndTheMeterUseTheInstrumentationNameAndTheSdkVersion()
    {
        Assert.Equal("workhorse", Instrumentation.Source.Name);
        Assert.Equal("workhorse", Instrumentation.Meter.Name);
        Assert.NotNull(SdkVersion.Current);
        Assert.Equal(SdkVersion.Current, Instrumentation.Source.Version);
        Assert.Equal(Instrumentation.Source.Version, Instrumentation.Meter.Version);
    }

    [Fact]
    public void DeclaresEachInstrumentWithTheKindUnitAndDescriptionOfTheFile()
    {
        var declared = DeclaredInstruments();
        Assert.NotEmpty(declared);
        foreach (var instrument in declared)
        {
            Assert.True(Surface.Instruments.TryGetValue(instrument.Name, out var governed), $"{instrument.Name} is not an instrument in api/telemetry.txt");
            Assert.Equal(governed.Kind, Kind(instrument));
            Assert.Equal(governed.Unit, instrument.Unit);
            Assert.Equal(governed.Description, instrument.Description);
        }
    }

    [Fact]
    public void DeclaresOnlySpansAndAttributesOfTheFile()
    {
        foreach (var span in Declared(spans: true))
        {
            Assert.True(Surface.Spans.Contains(span), $"{span} is not a span in api/telemetry.txt");
        }

        foreach (var attribute in Declared(spans: false))
        {
            Assert.True(Surface.Attributes.Contains(attribute), $"{attribute} is not an attribute in api/telemetry.txt");
        }
    }

    [Fact]
    public void AccountsForEveryNameOfTheFile()
    {
        var declared = new SortedSet<string>([.. Declared(spans: true), .. Declared(spans: false), .. DeclaredInstruments().Select(instrument => instrument.Name)], StringComparer.Ordinal);
        var listed = new List<string>();
        foreach (var group in NotEmitted)
        {
            Assert.Equal([.. group.Order(StringComparer.Ordinal)], group);
            listed.AddRange(group);
        }

        Assert.Equal(listed.Count, listed.Distinct(StringComparer.Ordinal).Count());
        Assert.Equal([], Surface.Names.Where(name => !declared.Contains(name) && !listed.Contains(name)));
        Assert.Equal([], listed.Where(name => declared.Contains(name) || !Surface.Names.Contains(name)));
    }

    /// <summary>
    /// The test checks itself: a span name or an attribute that the file does not list fails the
    /// check that each database test makes on the captured spans. The spans are detached, so no
    /// listener of another test captures them.
    /// </summary>
    [Fact]
    public void AnUngovernedNameFailsTheChecks()
    {
        const string Unknown = "workhorse.not.governed";
        Assert.DoesNotContain(Unknown, Surface.Names);
        TelemetryRecorder.AssertGoverned(Surface, [new Activity(Names.SpanClaim).SetTag(Names.QueueName, "orders")]);
        Assert.ThrowsAny<Xunit.Sdk.XunitException>(() => TelemetryRecorder.AssertGoverned(Surface, [new Activity(Unknown)]));
        Assert.ThrowsAny<Xunit.Sdk.XunitException>(() => TelemetryRecorder.AssertGoverned(Surface, [new Activity(Names.SpanClaim).SetTag(Unknown, "orders")]));
    }

    /// <summary>The span names, or the attribute names, of <see cref="Names"/>.</summary>
    private static List<string> Declared(bool spans) =>
    [
        .. typeof(Names).GetFields(BindingFlags.Static | BindingFlags.NonPublic | BindingFlags.Public)
            .Where(field => field.IsLiteral && field.FieldType == typeof(string) && field.Name.StartsWith("Span", StringComparison.Ordinal) == spans)
            .Select(field => (string)field.GetRawConstantValue()!),
    ];

    /// <summary>Each instrument that the <c>workhorse</c> meter publishes, as a listener sees it.</summary>
    private static List<Instrument> DeclaredInstruments()
    {
        RuntimeHelpers.RunClassConstructor(typeof(Instrumentation).TypeHandle);
        var instruments = new List<Instrument>();
        using var listener = new MeterListener
        {
            InstrumentPublished = (instrument, _) =>
            {
                if (ReferenceEquals(instrument.Meter, Instrumentation.Meter))
                {
                    instruments.Add(instrument);
                }
            },
        };
        listener.Start();
        return instruments;
    }

    /// <summary>The kind that <c>api/telemetry.txt</c> prints for a runtime instrument.</summary>
    private static string Kind(Instrument instrument) => instrument.GetType().GetGenericTypeDefinition() switch
    {
        var type when type == typeof(Counter<>) => "counter",
        var type when type == typeof(Histogram<>) => "histogram",
        var type when type == typeof(Gauge<>) => "gauge",
        var type when type == typeof(ObservableGauge<>) => "observable_gauge",
        var type => throw new InvalidOperationException($"{instrument.Name} has the kind {type.Name}, which api/telemetry.txt does not print"),
    };
}
