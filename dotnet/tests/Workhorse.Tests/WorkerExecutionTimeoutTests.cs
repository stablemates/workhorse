using Workhorse.Tests.Testing;
using static Workhorse.Tests.Testing.WorkerHarness;

namespace Workhorse.Tests;

/// <summary>
/// The execution-timeout test runs alone (SM-1684). The maintenance tick of any running worker times
/// out every overdue attempt in the scratch database. If a tick wins, the worker's own expiration
/// answers <c>stale</c>, and the handler sees <see cref="CancelReason.LeaseLost"/>. With no parallel
/// test, only this worker's local timer can settle the attempt. The suite runs about 1 s longer.
/// </summary>
[CollectionDefinition(nameof(WorkerExecutionTimeoutTests), DisableParallelization = true)]
public sealed class WorkerExecutionTimeoutRunsAlone;

/// <summary>The C# worker's local execution-timeout timer against PostgreSQL.</summary>
[Collection(nameof(WorkerExecutionTimeoutTests))]
public sealed class WorkerExecutionTimeoutTests(ScratchDatabase database)
{
    private sealed record Order(int OrderId);

    [Fact]
    public async Task AnExecutionTimeoutCancelsTheHandlerAndSettlesTheAttempt()
    {
        var queue = UniqueQueue("timeout");
        // After its startup pass, the worker sends no tick until the test ends.
        await using var worker = new Worker(database.DataSource, Options(queue, options => options.MaintenanceInterval = TimeSpan.FromMinutes(10)));
        var witness = new CancellationWitness();
        worker.Handle<Order>("slow", (context, _) => witness.WaitForCancellationAsync(context));
        var startedAt = await ScalarAsync(database.DataSource, "SELECT clock_timestamp()");

        await using var running = new RunningWorker(worker);
        await EventuallyAsync(
            async () => await ScalarAsync(
                database.DataSource,
                "SELECT last_completed_at > $1 FROM workhorse.maintenance_state WHERE routine_name = 'tick'",
                startedAt!) is true,
            "the startup maintenance pass completes");
        var taskId = await EnqueueAsync(database.DataSource, queue, "slow", new { orderId = 1 }, new { maxAttempts = 1, executionTimeoutMs = 300 });

        await TaskInStateAsync(database.DataSource, taskId, "failed");
        await witness.AssertReasonAsync(CancelReason.ExecutionTimeout);
        await running.StopAsync();
    }
}
