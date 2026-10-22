using Workhorse.Tests.Testing;
using static Workhorse.Tests.Client.QueueTesting;

namespace Workhorse.Tests.Client;

/// <summary>Task groups with completion callbacks (ADR 0095).</summary>
public sealed class QueueTaskGroupTests(ScratchDatabase database)
{
    [Fact]
    public async Task CreatesAddsListsFindsAndSealsAGroup()
    {
        var queue = new Queue(database.DataSource, new QueueOptions { DefaultQueue = UniqueName("group") });
        var group = await queue.CreateTaskGroupAsync(new TaskGroupCallbacks
        {
            OnFinish = new EnqueueRequest { TaskType = "group.finished", Payload = new { kind = "finish" } },
        }, Token);
        Assert.Equal(TaskGroupState.Open, group.State);
        Assert.Equal([TaskGroupCallbackKind.OnFinish], group.Callbacks.Select(callback => callback.Kind));

        var added = await queue.AddToTaskGroupAsync(group.Id, [.. Enumerable.Range(1, 3).Select(index => new EnqueueRequest { TaskType = "member", Payload = index })], Token);
        Assert.Equal(3, added.Count);

        var first = await queue.ListTaskGroupMembersAsync(group.Id, 0, 2, Token);
        Assert.Equal([1L, 2L], first.Members.Select(member => member.Position));
        Assert.Equal(2, first.NextAfter);
        var last = await queue.ListTaskGroupMembersAsync(group.Id, first.NextAfter!.Value, 2, Token);
        Assert.Equal(added[2].TaskId, Assert.Single(last.Members).TaskId);
        Assert.Null(last.NextAfter);
        Assert.Equal(TaskState.Ready, last.Members[0].State);

        var link = await queue.FindTaskGroupAsync(added[0].TaskId, Token);
        Assert.Equal(TaskGroupRole.Member, link!.Role);
        Assert.Equal(group.Id, link.Group.Id);
        Assert.Null(await queue.FindTaskGroupAsync(Guid.NewGuid(), Token));

        var sealedGroup = await queue.SealTaskGroupAsync(group.Id, Token);
        Assert.Equal(TaskGroupState.Sealed, sealedGroup.State);
        Assert.Equal(3, sealedGroup.Counts.Total);
        Assert.Equal(sealedGroup.Id, (await queue.GetTaskGroupAsync(group.Id, Token))!.Id);
        Assert.Null(await queue.GetTaskGroupAsync(Guid.NewGuid(), Token));
    }

    [Fact]
    public async Task TheBlockFormCreatesAndSealsInOneStatement()
    {
        var queue = new Queue(database.DataSource, new QueueOptions { DefaultQueue = UniqueName("block") });
        var result = await queue.TaskGroupAsync(
            new TaskGroupCallbacks { OnSuccess = new EnqueueRequest { TaskType = "group.succeeded" } },
            group => group.Add("member", 1).Add("member", 2, new EnqueueOptions { Priority = 5 }),
            Token);
        Assert.Equal(TaskGroupState.Sealed, result.Group.State);
        Assert.Equal(2, result.Tasks.Count);

        var empty = await queue.TaskGroupAsync(new TaskGroupCallbacks(), _ => { }, Token);
        Assert.Equal(TaskGroupState.Finished, empty.Group.State);
        Assert.Equal(TaskGroupResult.Succeeded, empty.Group.Result);
    }

    [Fact]
    public async Task ABlockThatThrowsEnqueuesNothing()
    {
        var queueName = UniqueName("block-throws");
        var queue = new Queue(database.DataSource, new QueueOptions { DefaultQueue = queueName });
        await Assert.ThrowsAsync<InvalidOperationException>(() => queue.TaskGroupAsync(
            new TaskGroupCallbacks(),
            group =>
            {
                group.Add("member", 1);
                throw new InvalidOperationException("stop");
            },
            Token));
        Assert.Equal(0, await CountAsync(database, queueName));
    }

    [Fact]
    public async Task RefusesACallbackWithACoalescingOption()
    {
        var queue = new Queue(database.DataSource);
        await Assert.ThrowsAsync<ArgumentException>(() => queue.CreateTaskGroupAsync(new TaskGroupCallbacks
        {
            OnFailure = new EnqueueRequest { TaskType = "t", Options = new EnqueueOptions { Idempotency = new Idempotency { Key = "k" } } },
        }, Token));
        await Assert.ThrowsAsync<ArgumentException>(() => queue.AddToTaskGroupAsync(
            Guid.NewGuid(),
            [new EnqueueRequest { TaskType = "t", Options = new EnqueueOptions { Throttle = new Throttle { Key = "k", Window = TimeSpan.FromSeconds(1) } } }],
            Token));
        await Assert.ThrowsAsync<ArgumentOutOfRangeException>(() => queue.ListTaskGroupMembersAsync(Guid.NewGuid(), 0, 0, Token));
    }

    [Fact]
    public async Task ASealedGroupRefusesAnAddWithFallbackDetailsByDefault()
    {
        var queue = new Queue(database.DataSource, new QueueOptions { DefaultQueue = UniqueName("closed") });
        var group = await queue.TaskGroupAsync(new TaskGroupCallbacks(), _ => { }, Token);
        var error = await Assert.ThrowsAsync<TaskGroupClosedException>(() =>
            queue.AddToTaskGroupAsync(group.Group.Id, [new EnqueueRequest { TaskType = "late" }], Token));
        Assert.Null(error.GroupId);
        Assert.Null(error.Reason);
    }

    [Fact]
    public async Task ASealedGroupRefusesAnAddWithItsDetailsWhenTheConnectionIncludesThem()
    {
        await using var dataSource = database.CreateDataSource(builder => builder.IncludeErrorDetail = true);
        var queue = new Queue(dataSource, new QueueOptions { DefaultQueue = UniqueName("closed-detail") });
        var group = await queue.TaskGroupAsync(new TaskGroupCallbacks(), _ => { }, Token);
        var error = await Assert.ThrowsAsync<TaskGroupClosedException>(() =>
            queue.AddToTaskGroupAsync(group.Group.Id, [new EnqueueRequest { TaskType = "late" }], Token));
        Assert.Equal(group.Group.Id, error.GroupId);
        Assert.Equal(TaskGroupClosedReason.Finished, error.Reason);
        Assert.Equal(TaskGroupState.Finished, error.State);
    }
}
