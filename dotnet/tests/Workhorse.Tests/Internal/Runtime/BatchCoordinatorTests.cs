using System.Collections.Concurrent;
using System.Text.Json;
using Workhorse.Internal.Runtime;

namespace Workhorse.Tests.Internal.Runtime;

/// <summary>The batch coordinator against a host that models the worker's active attempts.</summary>
public sealed class BatchCoordinatorTests
{
    private static readonly BatchOptions LongLinger = new(2, TimeSpan.FromSeconds(60));

    /// <summary>A host whose active attempts the test sets, as the worker's <c>_active</c> set.</summary>
    private sealed class Host : BatchCoordinator.IHost
    {
        internal ConcurrentDictionary<(Guid TaskId, long FenceToken), byte> Active { get; } = new();

        public volatile bool IsDraining;

        public bool Draining => IsDraining;

        public long ClaimOrder(ClaimedTask task) => 0;

        public bool ArrivalsComplete(string taskType, string queue, IReadOnlySet<(Guid TaskId, long FenceToken)> entered) =>
            IsDraining && Active.Keys.All(entered.Contains);

        public bool Abandoned(ClaimedTask task) => false;

        public void BatchDispatched(string taskType, IReadOnlyList<ClaimedTask> tasks, bool full, long lingerMs)
        {
        }

        public Task RecordEvidenceAsync(bool failure, Guid batchId, string taskType, IReadOnlyList<ClaimedTask> tasks, bool full) => Task.CompletedTask;
    }

    /// <summary>A context whose durable members the coordinator never calls.</summary>
    private sealed class Context(ClaimedTask task) : HandlerContext(task, new TaskCancellation())
    {
        public override TaskGroupContext TaskGroup => throw new NotSupportedException();

        private protected override Task<TaskCheckpoint?> GetCheckpointCoreAsync(string name) => throw new NotSupportedException();

        private protected override Task<T> CheckpointCoreAsync<T>(string name, CheckpointOptions? options, Func<CancellationToken, Task<T>> operation) =>
            throw new NotSupportedException();

        private protected override Task SleepCoreAsync(string name, TimeSpan? duration, DateTimeOffset? time) => throw new NotSupportedException();

        private protected override Task<T> WaitForSignalCoreAsync<T>(string name, TimeSpan? timeout) => throw new NotSupportedException();

        private protected override Task<T> WaitForHumanCoreAsync<TContext, T>(string name, TContext context, TimeSpan? timeout) =>
            throw new NotSupportedException();

        private protected override Task<T> RunChildCoreAsync<TPayload, T>(string name, string taskType, TPayload payload, EnqueueOptions options) =>
            throw new NotSupportedException();

        private protected override Task<IReadOnlyDictionary<string, ChildOutcome>> RunChildrenCoreAsync(IReadOnlyList<ChildRequest> children) =>
            throw new NotSupportedException();

        private protected override Task<IReadOnlyDictionary<string, JsonElement>> RunChildrenAllCoreAsync(IReadOnlyList<ChildRequest> children) =>
            throw new NotSupportedException();

        private protected override Task<TaskProgress?> GetProgressCoreAsync() => throw new NotSupportedException();

        private protected override Task<TaskProgress> SetProgressCoreAsync<T>(T progress) => throw new NotSupportedException();
    }

    private static Context NewContext(Host host, Guid? id = null, long fenceToken = 1)
    {
        var task = new ClaimedTask
        {
            Id = id ?? Guid.NewGuid(),
            Queue = "batch",
            Type = "charge",
            Priority = 0,
            Payload = JsonDocument.Parse("null").RootElement.Clone(),
            RedactErrorDetails = false,
            Attempt = 1,
            MaxAttempts = 1,
            FenceToken = fenceToken,
        };
        host.Active[(task.Id, task.FenceToken)] = 0;
        return new Context(task);
    }

    [Fact]
    public async Task ADrainRunsALingeringMemberWhileAnEarlierMemberStillSettles()
    {
        var host = new Host();
        var sizes = new ConcurrentQueue<int>();
        var coordinator = new BatchCoordinator(host, "charge", LongLinger, (members, _) =>
        {
            sizes.Enqueue(members.Count);
            return Task.FromResult<IReadOnlyList<BatchHandlerOutcome>>([.. members.Select(_ => new BatchSucceeded(null))]);
        });

        // The first pair fills a batch. Their handler calls end, but their attempts stay active, as
        // a completion that waits for a row lock keeps them.
        var first = NewContext(host);
        var second = NewContext(host);
        await Task.WhenAll(coordinator.RunAsync(first, () => null), coordinator.RunAsync(second, () => null));
        var third = NewContext(host);
        var lingering = coordinator.RunAsync(third, () => null);

        host.IsDraining = true;
        coordinator.Flush();

        // The earlier members count as arrived until their attempts end, so the lingering member runs
        // now, not after its 60 s linger.
        await lingering.WaitAsync(TimeSpan.FromSeconds(20), TestContext.Current.CancellationToken);
        Assert.Equal([2, 1], sizes);
    }

    [Fact]
    public async Task AMemberThatLeftNoLongerCountsAsArrived()
    {
        var host = new Host();
        var coordinator = new BatchCoordinator(host, "charge", LongLinger, (members, _) =>
            Task.FromResult<IReadOnlyList<BatchHandlerOutcome>>([.. members.Select(_ => new BatchSucceeded(null))]));
        var first = NewContext(host);
        var second = NewContext(host);
        await Task.WhenAll(coordinator.RunAsync(first, () => null), coordinator.RunAsync(second, () => null));

        // The worker ends both attempts. A task that is active and has not arrived holds the drain.
        coordinator.Leave(first.Task);
        coordinator.Leave(second.Task);
        host.Active.TryRemove((first.Task.Id, 1), out _);
        host.Active.TryRemove((second.Task.Id, 1), out _);
        var pending = NewContext(host);
        var lingering = coordinator.RunAsync(NewContext(host), () => null);
        host.IsDraining = true;
        coordinator.Flush();

        // The drain polls every 50 ms. The member waits while the pending task has not arrived.
        await Task.Delay(200, TestContext.Current.CancellationToken);
        Assert.False(lingering.IsCompleted);
        await coordinator.RunAsync(pending, () => null).WaitAsync(TimeSpan.FromSeconds(20), TestContext.Current.CancellationToken);
        await lingering.WaitAsync(TimeSpan.FromSeconds(20), TestContext.Current.CancellationToken);
    }

    [Fact]
    public async Task AnAttemptWhosePayloadDoesNotDecodeCountsAsArrivedUntilItEnds()
    {
        var host = new Host();
        var coordinator = new BatchCoordinator(host, "charge", LongLinger, (members, _) =>
            Task.FromResult<IReadOnlyList<BatchHandlerOutcome>>([.. members.Select(_ => new BatchSucceeded(null))]));
        var broken = NewContext(host);
        await Assert.ThrowsAsync<JsonException>(() => coordinator.RunAsync(broken, () => throw new JsonException("not an order")));

        // The broken attempt still settles, so it stays active. The healthy member must not wait for it.
        var healthy = coordinator.RunAsync(NewContext(host), () => null);
        host.IsDraining = true;
        coordinator.Flush();
        await healthy.WaitAsync(TimeSpan.FromSeconds(20), TestContext.Current.CancellationToken);
    }

    [Fact]
    public async Task TheEndOfAnEarlierAttemptKeepsTheArrivalOfItsRetry()
    {
        var host = new Host();
        var coordinator = new BatchCoordinator(host, "charge", LongLinger, (members, _) =>
            Task.FromResult<IReadOnlyList<BatchHandlerOutcome>>([.. members.Select(_ => new BatchSucceeded(null))]));
        var id = Guid.NewGuid();
        var earlier = NewContext(host, id, fenceToken: 1);
        await Assert.ThrowsAsync<JsonException>(() => coordinator.RunAsync(earlier, () => throw new JsonException("first attempt")));
        var retry = coordinator.RunAsync(NewContext(host, id, fenceToken: 2), () => null);

        // The earlier attempt ends after its retry arrived.
        coordinator.Leave(earlier.Task);
        host.Active.TryRemove((id, 1), out _);
        host.IsDraining = true;
        coordinator.Flush();
        await retry.WaitAsync(TimeSpan.FromSeconds(20), TestContext.Current.CancellationToken);
    }
}
