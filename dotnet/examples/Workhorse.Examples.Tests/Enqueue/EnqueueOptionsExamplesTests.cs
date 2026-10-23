using Workhorse.Examples.Enqueue;
using Workhorse.Examples.Tests.Testing;
using Workhorse.Tests.Testing;

namespace Workhorse.Examples.Tests.Enqueue;

/// <summary>
/// Runs the C# snippets of the site pages about idempotency, debounce, throttle, priority, and
/// task dependencies. Each snippet writes only tasks, so the tests share the scratch database.
/// </summary>
public sealed class EnqueueOptionsExamplesTests(ScratchDatabase scratch)
{
    private readonly ExampleDatabase _db = ExampleDatabase.Shared(scratch);

    [Fact]
    public async Task ASecondRequestWithTheSameKeyReturnsTheSameTask()
    {
        var examples = new IdempotencyExamples(_db.Queue);
        var invoiceId = $"csharp-{Guid.NewGuid()}";
        var first = await examples.EnqueueOnceAsync(invoiceId);
        var second = await examples.EnqueueOnceAsync(invoiceId);

        Assert.Equal(first, second);
        Assert.Equal(first, (await _db.TaskAsync("invoice.capture", "invoiceId", invoiceId)).Id);
        Assert.Equal("billing", (await _db.DetailAsync(first)).Queue);
    }

    [Fact]
    public async Task TheResultSaysIfTheRequestWasADuplicate()
    {
        var examples = new IdempotencyExamples(_db.Queue);
        var invoiceId = $"csharp-{Guid.NewGuid()}";
        var key = $"capture:{invoiceId}";
        var first = await examples.EnqueueWithResultAsync(invoiceId, key);
        var second = await examples.EnqueueWithResultAsync(invoiceId, key);

        Assert.Equal(EnqueueOutcome.Accepted, first.Outcome);
        Assert.Equal(EnqueueOutcome.Replayed, second.Outcome);
        Assert.Equal(first.TaskId, second.TaskId);
    }

    [Fact]
    public async Task AChangedRequestWithTheSameKeyThrowsAConflictWithItsDetails()
    {
        var examples = new IdempotencyExamples(_db.Queue);
        var key = $"capture:csharp-{Guid.NewGuid()}";
        var first = await examples.EnqueueWithResultAsync("invoice-1", key);

        // The data source has the default Npgsql settings, so the details arrive through HINT.
        var error = await Assert.ThrowsAsync<EnqueueIdempotencyConflictException>(
            () => examples.EnqueueWithResultAsync("invoice-2", key));
        Assert.Equal(first.TaskId.ToString(), error.Details["existingTaskId"].GetString());
        Assert.Contains("payload", error.Details["conflictingFields"].EnumerateArray().Select(field => field.GetString()));
    }

    [Fact]
    public async Task ADebounceReplacesThePendingTask()
    {
        var examples = new DebounceExamples(_db.Queue);
        var documentId = $"csharp-{Guid.NewGuid()}";
        var first = await examples.DebounceAsync(documentId, 1, TimeSpan.FromMinutes(5));
        var second = await examples.DebounceAsync(documentId, 2, TimeSpan.FromMinutes(5));

        Assert.Equal(EnqueueOutcome.Accepted, first.Outcome);
        Assert.Equal(EnqueueOutcome.Replaced, second.Outcome);
        Assert.Equal(first.TaskId, second.TaskId);
        var task = await _db.TaskAsync("search.reindex", "documentId", documentId);
        Assert.Equal(2, task.Payload!.Value.GetProperty("revision").GetInt32());
        Assert.Equal(TaskState.Scheduled, task.State);
    }

    [Fact]
    public async Task AThrottleKeepsTheFirstTaskAndCoalescesTheRepeat()
    {
        var examples = new ThrottleExamples(_db.Queue);
        var accountId = $"csharp-{Guid.NewGuid()}";
        var first = await examples.ThrottleAsync(accountId, TimeSpan.FromHours(1));
        var second = await examples.ThrottleAsync(accountId, TimeSpan.FromHours(1));

        Assert.Equal(EnqueueOutcome.Accepted, first.Outcome);
        Assert.Equal(EnqueueOutcome.Coalesced, second.Outcome);
        Assert.Equal(first.TaskId, second.TaskId);
        Assert.Single(await _db.TasksAsync("email.digest", "accountId", accountId));
    }

    [Fact]
    public async Task ThePriorityReachesTheTask()
    {
        var invoiceId = $"csharp-{Guid.NewGuid()}";
        await new PriorityExamples(_db.Queue).EnqueueUrgentAsync(invoiceId);

        var task = await _db.TaskAsync("invoice.remind", "invoiceId", invoiceId);
        Assert.Equal(10, task.Priority);
        Assert.Equal("billing", task.Queue);
    }

    [Fact]
    public async Task TheNotificationWaitsForTheImportWithItsPolicies()
    {
        var importId = await new TaskDependenciesExamples(_db.Queue).EnqueueImportAndNotifyAsync();
        var notify = await _db.TaskAsync("contacts.notify", "importId", importId.ToString());

        Assert.Equal(TaskState.Blocked, notify.State);
        Assert.Equal([importId], notify.PrerequisiteTaskIds);
        Assert.Equal(
            new TaskDependencyPolicy
            {
                OnSuccess = DependencyPolicy.Release,
                OnFailure = DependencyPolicy.Fail,
                OnCancellation = DependencyPolicy.Cancel,
            },
            notify.DependencyPolicy);

        // A cancellation of the import cancels the notification, as OnCancellation says.
        await _db.Queue.CancelAsync(importId, new CancelOptions { Reason = "the test ends", RequestedBy = "docs-example" }, TestContext.Current.CancellationToken);
        Assert.Equal(TaskState.Canceled, (await _db.TerminalAsync(notify.Id)).State);
    }
}
