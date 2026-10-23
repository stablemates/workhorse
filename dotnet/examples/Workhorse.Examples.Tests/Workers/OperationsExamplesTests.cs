using Workhorse.Examples.Tests.Testing;
using Workhorse.Examples.Workers;
using Workhorse.Tests.Testing;

namespace Workhorse.Examples.Tests.Workers;

/// <summary>Runs the C# snippet of the site page about operations.</summary>
public sealed class OperationsExamplesTests(ScratchDatabase scratch)
{
    [Fact(Timeout = 120_000)]
    public async Task TheOperatorPausesTheRegisteredWorker()
    {
        // The worker ID is fixed, so the test has its own registry.
        await using var db = await ExampleDatabase.CreateIsolatedAsync(scratch);
        await using var worker = new Worker(db.DataSource, new WorkerOptions
        {
            Queues = ["operations-pause"],
            WorkerId = "billing-worker-1",
            RegistryInterval = TimeSpan.FromMilliseconds(200),
        });
        using var stop = CancellationTokenSource.CreateLinkedTokenSource(TestContext.Current.CancellationToken);
        var running = worker.RunAsync(stop.Token);
        try
        {
            await ExampleDatabase.EventuallyAsync(
                async () => (await db.Admin.ListWorkersAsync(TestContext.Current.CancellationToken)).Any(candidate => candidate.WorkerId == "billing-worker-1"),
                "billing-worker-1 registers");

            var incidentId = $"csharp-{Guid.NewGuid()}";
            var (workers, result) = await new OperationsExamples(db.DataSource)
                .PauseWorkerAsync(new OperationsActor("dana@example.com"), incidentId);
            Assert.Contains(workers, candidate => candidate.WorkerId == "billing-worker-1");
            Assert.NotNull(result);
            Assert.True(result.Paused);
            Assert.Equal("dana@example.com", result.PausedBy);
            Assert.Equal("investigating slow provider", result.Reason);
            await ExampleDatabase.EventuallyAsync(() => Task.FromResult(worker.IsPaused), "the worker reads the pause");
        }
        finally
        {
            await stop.CancelAsync();
            await running;
        }
    }
}
