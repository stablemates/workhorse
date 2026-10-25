using System.Collections.Concurrent;
using System.Text.Json;
using System.Text.Json.Nodes;
using Workhorse.Examples.Durable;
using Workhorse.Examples.Tests.Testing;
using Workhorse.Tests.Testing;

namespace Workhorse.Examples.Tests.Durable;

/// <summary>Compares a stored JSON value with the JSON text that a test expects.</summary>
internal static class JsonAssert
{
    public static void Equal(string expected, JsonElement? actual)
    {
        Assert.NotNull(actual);
        var actualNode = JsonNode.Parse(actual.Value.GetRawText());
        Assert.True(
            JsonNode.DeepEquals(JsonNode.Parse(expected), actualNode),
            $"expected {expected}, got {actual.Value.GetRawText()}");
    }
}

/// <summary>The input of the <c>welcome</c> checkpoint in the input-conflict test.</summary>
public sealed record WelcomeInput(string To, string Template);

/// <summary>Runs the C# handlers of the site page about durable execution.</summary>
public sealed class DurableExecutionExamplesTests(ScratchDatabase scratch) : IPayments, ILogistics, ITrialMailer
{
    private readonly ExampleDatabase _db = ExampleDatabase.Shared(scratch);
    private readonly ConcurrentQueue<string> _calls = new();
    private int _shipments;

    [Fact(Timeout = 120_000)]
    public async Task ARetryReturnsTheStoredChargeAndDoesNotChargeAgain()
    {
        var driver = new DurableFlowDriver(_db);
        await using var worker = driver.CreateWorker();
        new DurableExecutionExamples(this, this, this).RegisterCheckpoints(worker);
        var taskId = await driver.EnqueueAsync("order.fulfill", new { orderId = "ord-7" }, TestContext.Current.CancellationToken);
        var task = await driver.FinishAsync(worker, taskId);
        Assert.Equal(TaskState.Succeeded, task.State);
        Assert.Equal(2, task.CurrentAttempt);
        Assert.Equal(["charge ord-7 charge:ord-7", "ship ord-7", "ship ord-7"], _calls);
        JsonAssert.Equal("""{"shipmentId":"ship-ord-7","chargeId":"ch-ord-7"}""", task.Result);
    }

    [Fact(Timeout = 120_000)]
    public async Task TheFollowUpWaitsForItsTimeAndTheWelcomeRunsOneTime()
    {
        var driver = new DurableFlowDriver(_db);
        await using var worker = driver.CreateWorker();
        new DurableExecutionExamples(this, this, this).RegisterFollowUp(worker);
        var followUpAt = DateTimeOffset.UtcNow.AddMilliseconds(500);
        var taskId = await driver.EnqueueAsync("trial.follow-up", new { to = "person@example.com", followUpAt }, TestContext.Current.CancellationToken);
        var task = await driver.FinishAsync(worker, taskId);
        Assert.Equal(TaskState.Succeeded, task.State);
        Assert.Equal(1, task.CurrentAttempt);
        Assert.Equal(["welcome person@example.com", "follow-up person@example.com"], _calls);
    }

    [Fact(Timeout = 120_000)]
    public async Task TheReviewReturnsTheSignalAndTheDecision()
    {
        var driver = new DurableFlowDriver(_db);
        await using var worker = driver.CreateWorker();
        DurableExecutionExamples.RegisterExternalWaits(worker);
        var taskId = await driver.EnqueueAsync("order.review", new { orderId = "ord-5" }, TestContext.Current.CancellationToken);
        await driver.DeliverSignalAsync(worker, taskId, "provider-event", new { id = "evt-5" });
        await driver.CompleteHumanWaitAsync(worker, taskId, "operator-review", new { approved = true });
        var task = await driver.FinishAsync(worker, taskId);
        Assert.Equal(TaskState.Succeeded, task.State);
        JsonAssert.Equal("""{"event":{"id":"evt-5"},"review":{"approved":true}}""", task.Result);
    }

    [Fact]
    public void ANamingPolicyChangesTheInputFingerprint()
    {
        // The guide states that a naming policy changes the JSON text, and so the fingerprint.
        var input = new { To = "person@example.com", Template = "welcome-v1" };
        var web = Checkpoints.InputFingerprint(input);
        var pascal = Checkpoints.InputFingerprint(input, new JsonSerializerOptions());
        Assert.Equal(64, web.Length);
        Assert.NotEqual(web, pascal);
        Assert.Equal(web, Checkpoints.InputFingerprint(new { template = "welcome-v1", to = "person@example.com" }));
    }

    [Fact(Timeout = 120_000)]
    public async Task ANamingPolicyChangeFailsTheReplayWithAnInputConflict()
    {
        var driver = new DurableFlowDriver(_db);
        var taskId = await driver.EnqueueAsync(
            "trial.follow-up", new { to = "person@example.com", followUpAt = DateTimeOffset.UtcNow.AddHours(1) }, TestContext.Current.CancellationToken);
        await using (var before = driver.CreateWorker())
        {
            RegisterWelcomeWithInput(before);
            Assert.True(await before.RunOnceAsync(TestContext.Current.CancellationToken));
        }

        // The first attempt suspends at the sleep, an hour away. The test then makes the task due.
        Assert.Equal(TaskState.Scheduled, (await _db.DetailAsync(taskId)).State);
        await _db.ExecuteAsync(
            "UPDATE workhorse.task_runtime SET run_at = clock_timestamp() - interval '1 millisecond' WHERE task_id = $1", taskId);

        var welcome = await _db.Admin.GetCheckpointAsync(taskId, "welcome", TestContext.Current.CancellationToken);
        Assert.Equal(
            Checkpoints.InputFingerprint(new WelcomeInput("person@example.com", "welcome-v1")),
            welcome!.InputFingerprint);

        // The new deployment writes PascalCase names, so the same input has another fingerprint.
        await using var after = driver.CreateWorker(new JsonSerializerOptions { PropertyNameCaseInsensitive = true });
        RegisterWelcomeWithInput(after);
        var task = await driver.FinishAsync(after, taskId);
        Assert.Equal(TaskState.Failed, task.State);
        Assert.Equal(nameof(CheckpointInputConflictException), task.Error!.Value.GetProperty("name").GetString());
        Assert.Equal(["welcome person@example.com"], _calls);
    }

    private void RegisterWelcomeWithInput(Worker worker) =>
        worker.Handle<TrialPayload>(
            "trial.follow-up",
            async (context, payload) =>
            {
                await context.CheckpointAsync(
                    "welcome",
                    new CheckpointOptions { Input = new WelcomeInput(payload.To, "welcome-v1") },
                    ct => WelcomeAsync(payload.To, ct));
                await context.SleepUntilAsync("follow-up-window", payload.FollowUpAt);
                await context.CheckpointAsync("follow-up", ct => FollowUpAsync(payload.To, ct));
            });

    Task<Charge> IPayments.ChargeAsync(string orderId, string idempotencyKey, CancellationToken cancellationToken)
    {
        _calls.Enqueue($"charge {orderId} {idempotencyKey}");
        return Task.FromResult(new Charge($"ch-{orderId}"));
    }

    Task<Shipment> ILogistics.CreateShipmentAsync(string orderId, Charge charge, CancellationToken cancellationToken)
    {
        _calls.Enqueue($"ship {orderId}");
        if (Interlocked.Increment(ref _shipments) == 1)
        {
            throw new InvalidOperationException("the shipment service is not available");
        }

        return Task.FromResult(new Shipment($"ship-{orderId}", charge.Id));
    }

    public Task<MailResult> WelcomeAsync(string recipient, CancellationToken cancellationToken)
    {
        _calls.Enqueue($"welcome {recipient}");
        return Task.FromResult(new MailResult(true));
    }

    public Task<MailResult> FollowUpAsync(string recipient, CancellationToken cancellationToken)
    {
        _calls.Enqueue($"follow-up {recipient}");
        return Task.FromResult(new MailResult(true));
    }
}
