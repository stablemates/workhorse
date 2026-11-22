using System.Diagnostics;
using System.Diagnostics.Metrics;
using System.Reflection;
using System.Runtime.Loader;
using Workhorse.Internal.Telemetry;

namespace Workhorse.Tests.Telemetry;

/// <summary>
/// A listener can throw when the meter publishes <c>workhorse.tasks.redrive</c>. The redrive count is
/// then lost, but the spans and the other instruments of the SDK stay usable.
/// </summary>
/// <remarks>
/// The SDK of this process published its instruments before the test starts. So the test loads a
/// fresh copy of the SDK assembly, whose static classes have not run, and throws only for the
/// counter of that copy.
/// </remarks>
public sealed class RedriveCounterPublicationTests
{
    [Fact]
    public void AFailedPublicationOfTheRedriveCounterKeepsTheSpansUsable()
    {
        var context = new AssemblyLoadContext("redrive-counter-publication", isCollectible: true);
        try
        {
            var fresh = context.LoadFromAssemblyPath(typeof(Admin).Assembly.Location);
            using var listener = new MeterListener
            {
                InstrumentPublished = (instrument, _) =>
                {
                    if (instrument.Name == "workhorse.tasks.redrive" && !ReferenceEquals(instrument.Meter, Instrumentation.Meter))
                    {
                        throw new InvalidOperationException("counter publication failed");
                    }
                },
            };
            listener.Start();
            // The test samples the spans of the fresh copy itself, so the span starts also when no
            // listener of another test is active.
            using var spans = new ActivityListener
            {
                ShouldListenTo = source => source.Name == Instrumentation.Name && !ReferenceEquals(source, Instrumentation.Source),
                Sample = (ref ActivityCreationOptions<ActivityContext> _) => ActivitySamplingResult.AllDataAndRecorded,
            };
            ActivitySource.AddActivityListener(spans);

            Invoke(fresh, "Workhorse.Internal.Telemetry.AdminTelemetry", "Redrive", "not_found", 1L);
            using var span = Assert.IsType<Activity>(Invoke(fresh, "Workhorse.Internal.Telemetry.Instrumentation", "StartSpan", "workhorse.enqueue"));

            Assert.Equal("workhorse.enqueue", span.OperationName);
        }
        finally
        {
            context.Unload();
        }
    }

    private static object? Invoke(Assembly assembly, string type, string method, params object[] arguments) =>
        assembly.GetType(type, throwOnError: true)!
            .GetMethod(method, BindingFlags.Static | BindingFlags.NonPublic)!
            .Invoke(null, arguments);
}
