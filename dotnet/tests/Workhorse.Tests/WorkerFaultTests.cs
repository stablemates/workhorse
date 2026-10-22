using Npgsql;
using Workhorse.Internal.Runtime;
using Workhorse.Tests.Testing;
using static Workhorse.Tests.Testing.WorkerHarness;

namespace Workhorse.Tests;

/// <summary>
/// The fault tests of ADR 0107, "Concurrency": a heartbeat statement that never ends closes the claim
/// gate at the round bound B. The worker does not wait for <see cref="NpgsqlCommand.Cancel"/>, which
/// can block for the connection timeout, or without limit with <c>Cancellation Timeout=0</c>.
/// </summary>
public sealed class WorkerFaultTests(ScratchDatabase database)
{
    /// <summary>
    /// The longest delay after B that the test accepts for the gate to close. The heartbeat thread
    /// waits on a monitor until B, so the delay is scheduling time on a busy machine, far below the
    /// cancellation's own wait.
    /// </summary>
    private static readonly TimeSpan GateSlack = TimeSpan.FromSeconds(2);

    [Fact]
    public Task AnUnreachableCancellationEndpointDoesNotHoldTheClaimGate() =>
        RoundNeverEndsAsync(refuseConnections: true, cancellationTimeoutMs: 2_000);

    [Fact]
    public Task ACancellationTimeoutOfZeroDoesNotHoldTheClaimGate() =>
        RoundNeverEndsAsync(refuseConnections: false, cancellationTimeoutMs: 0);

    private async Task RoundNeverEndsAsync(bool refuseConnections, int cancellationTimeoutMs)
    {
        var direct = new NpgsqlConnectionStringBuilder(database.DataSource.ConnectionString);
        await using var proxy = new FaultProxy(direct.Host!, direct.Port);
        // A data source of its own, so its shared heartbeat and pool serve only this test.
        await using var dataSource = database.CreateDataSource(builder =>
        {
            builder.Host = "127.0.0.1";
            builder.Port = proxy.Port;
            builder.CancellationTimeout = cancellationTimeoutMs;
            builder.Timeout = 2;
        });
        var queue = UniqueQueue("fault");
        var started = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        CancelReason? seen = null;
        await using var worker = new Worker(dataSource, Options(queue, options =>
        {
            options.Lease = TimeSpan.FromSeconds(3);
            options.Heartbeat = TimeSpan.FromSeconds(1);
            options.PollingOnly = true;
            options.DisableRegistry = true;
            options.ShutdownGrace = TimeSpan.FromSeconds(1);
        }));
        worker.Handle<string>("held", async (context, _) =>
        {
            using var registration = context.CancellationToken.Register(() => seen = context.CancelReason);
            started.SetResult();
            // The handler ignores its token, so only the lease watchdog can end its lease.
            await release.Task;
        });
        await EnqueueAsync(database.DataSource, queue, "held", "x");

        var running = new RunningWorker(worker);
        var heartbeat = worker.HeartbeatForTests;
        try
        {
            await started.Task.WaitAsync(Patience, TestContext.Current.CancellationToken);
            var rounds = heartbeat.RoundsStarted;
            await EventuallyAsync(() => heartbeat.RoundsStarted > rounds, "a heartbeat round renews the lease");

            await proxy.FreezeAsync(refuseConnections);

            // The next round never gets an answer. At B the heartbeat marks its connection lost and
            // closes the claim gate, while the cleanup task still waits for the cancellation.
            // The pool can still hold idle connections from before the freeze, and the replacement can
            // take one at once, so the gate can open again on a dead connection. Its next round then
            // loses it at B too. So the test reads when the gate closed, not whether it is closed now.
            await EventuallyAsync(() => heartbeat.ConnectionsLost > 0, "a round loses its connection at B");
            Assert.InRange(Monotonic.Span(heartbeat.LastLossLateness), TimeSpan.Zero, GateSlack);
            var lost = heartbeat.LastLost!;
            await lost.CleanupStarted.WaitAsync(Patience, TestContext.Current.CancellationToken);
            if (cancellationTimeoutMs == 0)
            {
                // Cancel() of this connection waits without limit, and the gate closed all the same.
                Assert.False(lost.CleanupEnded, "the cleanup task still waits for Cancel()");
            }

            // No round renews the lease now, so the watchdog ends the attempt (SM-1445).
            await EventuallyAsync(() => seen is not null, "the lease watchdog cancels the handler");
            Assert.Equal(CancelReason.LeaseLost, seen);
        }
        finally
        {
            proxy.Thaw();
            release.TrySetResult();
        }

        // After the outage the replacement connection opens the gate again, and the run drains.
        await EventuallyAsync(() => heartbeat.Connected, "the replacement heartbeat connection arrives");
        await running.StopAsync();
    }
}
