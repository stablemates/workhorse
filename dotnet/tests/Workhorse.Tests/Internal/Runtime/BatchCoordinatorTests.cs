using System.Collections.Concurrent;
using System.Text.Json;
using Workhorse.Internal.Runtime;

namespace Workhorse.Tests.Internal.Runtime;

/// <summary>The batch coordinator against a host that models the worker's active attempts.</summary>
public sealed class BatchCoordinatorTests
{
    private static readonly BatchOptions LongLinger = new() { MaxSize = 2, Linger = TimeSpan.FromSeconds(60) };

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

    private static Context NewContext(Host host, Guid? id = null, long fenceToken = 1, int priority = 0)
    {
        var task = new ClaimedTask
        {
            Id = id ?? Guid.NewGuid(),
            Queue = "batch",
            Type = "charge",
            Priority = priority,
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

    // SM-1709: a member whose token was cancelled while it waited stayed in the batch. The handler
    // then got a task that the worker no longer owned, and the member settled only after the linger.
    [Fact]
    public async Task ACancelledWaitingMemberLeavesAndItsPeersKeepTheirOrder()
    {
        var host = new Host();
        var batches = new ConcurrentQueue<long[]>();
        var options = new BatchOptions { MaxSize = 4, Linger = TimeSpan.FromSeconds(2) };
        var coordinator = new BatchCoordinator(host, "charge", options, (members, _) =>
        {
            batches.Enqueue([.. members.Select(member => (long)member.Task.Priority)]);
            return Task.FromResult<IReadOnlyList<BatchHandlerOutcome>>([.. members.Select(member => new BatchSucceeded(member.Task.Priority))]);
        });
        var first = NewContext(host, priority: 3);
        var cancelled = NewContext(host, priority: 2);
        var last = NewContext(host, priority: 1);
        var firstResult = coordinator.RunAsync(first, () => null);
        var cancelledResult = coordinator.RunAsync(cancelled, () => null);
        var lastResult = coordinator.RunAsync(last, () => null);

        cancelled.Cancellation.Cancel(CancelReason.LeaseLost);

        // The member settles with the cancellation of its own token before the linger ends.
        var stopped = await Assert.ThrowsAnyAsync<OperationCanceledException>(
            () => cancelledResult.WaitAsync(TimeSpan.FromSeconds(20), TestContext.Current.CancellationToken));
        Assert.Equal(cancelled.CancellationToken, stopped.CancellationToken);
        Assert.Empty(batches);

        Assert.Equal(3, await firstResult.WaitAsync(TimeSpan.FromSeconds(20), TestContext.Current.CancellationToken));
        Assert.Equal(1, await lastResult.WaitAsync(TimeSpan.FromSeconds(20), TestContext.Current.CancellationToken));
        Assert.Equal([new long[] { 3, 1 }], batches);
    }

    [Fact]
    public async Task TheLingerEndsWhenTheLastWaitingMemberIsCancelled()
    {
        var host = new Host();
        var handled = 0;
        var coordinator = new BatchCoordinator(host, "charge", LongLinger, (members, _) =>
        {
            Interlocked.Increment(ref handled);
            return Task.FromResult<IReadOnlyList<BatchHandlerOutcome>>([.. members.Select(_ => new BatchSucceeded(null))]);
        });
        var only = NewContext(host);
        var result = coordinator.RunAsync(only, () => null);

        only.Cancellation.Cancel(CancelReason.Requested);

        // The member does not wait for its 60 s linger.
        await Assert.ThrowsAnyAsync<OperationCanceledException>(
            () => result.WaitAsync(TimeSpan.FromSeconds(20), TestContext.Current.CancellationToken));
        Assert.Equal(0, Volatile.Read(ref handled));
    }

    [Fact]
    public async Task AMemberCancelledBeforeItArrivesNeverJoinsABatch()
    {
        var host = new Host();
        var handled = 0;
        var options = new BatchOptions { MaxSize = 2, Linger = TimeSpan.Zero };
        var coordinator = new BatchCoordinator(host, "charge", options, (members, _) =>
        {
            Interlocked.Increment(ref handled);
            return Task.FromResult<IReadOnlyList<BatchHandlerOutcome>>([.. members.Select(_ => new BatchSucceeded(null))]);
        });
        var late = NewContext(host);
        late.Cancellation.Cancel(CancelReason.Requested);

        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => coordinator.RunAsync(late, () => null));
        Assert.Equal(0, Volatile.Read(ref handled));
    }

    // SM-1709: at the end of the shutdown grace, the worker cancels each token with Shutdown. A member
    // that still lingers then leaves its batch with the cancellation of its own token, which the worker
    // turns into a release without a charged attempt. The handler never runs a payload after the
    // deadline.
    [Fact]
    public async Task AMemberThatStillLingersAtTheShutdownDeadlineLeavesItsBatch()
    {
        var host = new Host();
        var handled = 0;
        var coordinator = new BatchCoordinator(host, "charge", LongLinger, (members, _) =>
        {
            Interlocked.Increment(ref handled);
            return Task.FromResult<IReadOnlyList<BatchHandlerOutcome>>([.. members.Select(_ => new BatchSucceeded(null))]);
        });
        // An admitted attempt that has not reached the coordinator keeps the drain flush from
        // dispatching the batch.
        _ = NewContext(host);
        var lingering = NewContext(host);
        var result = coordinator.RunAsync(lingering, () => null);
        host.IsDraining = true;
        coordinator.Flush();
        await Task.Delay(100, TestContext.Current.CancellationToken);
        Assert.False(result.IsCompleted);

        lingering.Cancellation.Cancel(CancelReason.Shutdown);

        var stopped = await Assert.ThrowsAnyAsync<OperationCanceledException>(
            () => result.WaitAsync(TimeSpan.FromSeconds(20), TestContext.Current.CancellationToken));
        Assert.Equal(lingering.CancellationToken, stopped.CancellationToken);
        Assert.Equal(CancelReason.Shutdown, lingering.CancelReason);
        Assert.Equal(0, Volatile.Read(ref handled));
    }

    // SM-1709: the registration of a member runs on the thread pool after its token is cancelled, so it
    // can come after a selection. The selection must still never take a member whose token is cancelled.
    [Fact]
    public async Task ASelectionSkipsACancelledMemberWhoseRegistrationHasNotRun()
    {
        var host = new Host();
        var batches = new ConcurrentQueue<long[]>();
        var options = new BatchOptions { MaxSize = 2, Linger = TimeSpan.FromSeconds(60) };
        var coordinator = new BatchCoordinator(host, "charge", options, (members, _) =>
        {
            batches.Enqueue([.. members.Select(member => (long)member.Task.Priority)]);
            return Task.FromResult<IReadOnlyList<BatchHandlerOutcome>>([.. members.Select(member => new BatchSucceeded(member.Task.Priority))]);
        });
        var cancelled = NewContext(host, priority: 3);
        var cancelledResult = coordinator.RunAsync(cancelled, () => null);
        // A callback that runs before the registration of the coordinator holds it back.
        using var gate = new ManualResetEventSlim();
        using var held = cancelled.CancellationToken.Register(() => gate.Wait(TimeSpan.FromSeconds(20)));
        cancelled.Cancellation.Cancel(CancelReason.Requested);

        try
        {
            // Two later members fill a batch. The selection must not take the cancelled member.
            var first = coordinator.RunAsync(NewContext(host, priority: 2), () => null);
            var last = coordinator.RunAsync(NewContext(host, priority: 1), () => null);
            Assert.Equal(2, await first.WaitAsync(TimeSpan.FromSeconds(20), TestContext.Current.CancellationToken));
            Assert.Equal(1, await last.WaitAsync(TimeSpan.FromSeconds(20), TestContext.Current.CancellationToken));
            Assert.Equal([new long[] { 2, 1 }], batches);
        }
        finally
        {
            gate.Set();
        }

        await Assert.ThrowsAnyAsync<OperationCanceledException>(
            () => cancelledResult.WaitAsync(TimeSpan.FromSeconds(20), TestContext.Current.CancellationToken));
    }
}
