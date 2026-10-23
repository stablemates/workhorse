using System.Text.Json;
using Npgsql;
using Workhorse.Internal.Runtime;
using static Workhorse.Tests.Testing.WorkerHarness;

namespace Workhorse.Tests.Internal.Runtime;

/// <summary>
/// SM-1649: a heartbeat round that read the membership before the release can settle the attempt
/// while PostgreSQL refuses its completion. The refused completion and that round take the attempt's
/// settlement lock, so the first one decides. These cases need no database: the data source points
/// at a closed port, so a statement fails the case.
/// </summary>
public sealed class RefusedCompletionTests : IAsyncDisposable
{
    private readonly NpgsqlDataSource _dataSource = NpgsqlDataSource.Create("Host=127.0.0.1;Port=1;Timeout=1");
    private readonly Ownership _ownership = new(Monotonic.Now(), Monotonic.Millis(30_000));
    private readonly Arbiter _arbiter = new();
    private readonly ClaimedTask _task = new()
    {
        Id = Guid.NewGuid(),
        Queue = "default",
        Type = "sample",
        Priority = 0,
        Payload = JsonDocument.Parse("null").RootElement.Clone(),
        RedactErrorDetails = false,
        Attempt = 1,
        MaxAttempts = 1,
        FenceToken = 7,
    };

    public async ValueTask DisposeAsync() => await _dataSource.DisposeAsync();

    [Fact]
    public async Task ARefusedCompletionWaitsForAHeartbeatSettlementThatHoldsTheLock()
    {
        await using var worker = new Worker(_dataSource, Options("default"));
        await _ownership.Settlement.WaitAsync(TestContext.Current.CancellationToken);
        var reconciliation = worker.ReconcileRejectedCompletionAsync(_task, _ownership, _arbiter, CancellationToken.None);
        Assert.False(reconciliation.IsCompleted, "the reconciliation did not wait for the lock");
        _arbiter.Submit(Outcome.AttemptTimeout);
        _ownership.Settlement.Release();
        await reconciliation;

        Assert.Equal(Outcome.AttemptTimeout, _arbiter.Current);
    }

    [Fact]
    public async Task ARefusedCompletionThrowsTheLostLeaseOfAHeartbeatSettlementThatDecidedFirst()
    {
        await using var worker = new Worker(_dataSource, Options("default"));
        _arbiter.Submit(Outcome.LeaseExpired);
        var error = await Assert.ThrowsAsync<LeaseLostException>(
            () => worker.ReconcileRejectedCompletionAsync(_task, _ownership, _arbiter, CancellationToken.None));
        Assert.Equal("heartbeat", error.Operation);
    }
}
