using System.Text.Json;
using Workhorse.Examples.Programs.Tests.Testing;
using Workhorse.Tests.Testing;

namespace Workhorse.Examples.Programs.Tests;

/// <summary>
/// Runs each scenario program in a child process, as the JVM program tests run the programs of
/// <c>jvm/examples/programs</c>. Each run has a database of its own.
/// </summary>
public sealed class ScenarioProgramsTests(ScratchDatabase scratch)
{
    [Fact(Timeout = 180_000)]
    public async Task TheQuickstartRunsOneTask()
    {
        await using var db = await ScenarioDatabase.CreateAsync(scratch);
        await using var program = ProgramProcess.Start("quickstart", db.Url, TestContext.Current.CancellationToken);
        Assert.True(await program.ExitAsync() == 0, program.Describe());
        Assert.Equal("succeeded {\"deliveredTo\":\"ada@example.com\"}\n", program.Output());
    }

    [Fact(Timeout = 180_000)]
    public async Task TheTransactionCommitsOneTask()
    {
        await using var db = await ScenarioDatabase.CreateAsync(scratch);
        await using var program = ProgramProcess.Start("transaction", db.Url, TestContext.Current.CancellationToken);
        Assert.True(await program.ExitAsync() == 0, program.Describe());
        var task = await db.DetailAsync(Guid.Parse(program.Output().Trim()));
        Assert.Equal(("orders", "order.accepted", 3), (task.Queue, task.Type, task.MaxAttempts));
        Assert.Equal("order-42", task.Payload!.Value.GetProperty("orderId").GetString());
        var policy = task.RetryPolicy!.Value;
        Assert.Equal("exponential", policy.GetProperty("type").GetString());
        Assert.Equal(1_000, policy.GetProperty("initialDelayMs").GetInt64());
        Assert.Equal(2, policy.GetProperty("multiplier").GetInt64());
        Assert.Equal(60_000, policy.GetProperty("maxDelayMs").GetInt64());
    }

    [Fact(Timeout = 180_000)]
    public async Task TheDedicatedWorkerRunsATaskAndDrainsOnSigterm()
    {
        await using var db = await ScenarioDatabase.CreateAsync(scratch);
        await using var program = ProgramProcess.Start("dedicated-worker", db.Url, TestContext.Current.CancellationToken);
        var taskId = await EnqueueOrderAsync(db.Queue, "order.accepted");
        var task = await db.TerminalAsync(taskId, program, TestContext.Current.CancellationToken);
        Assert.True(task.State == TaskState.Succeeded, program.Describe());
        AssertJson("""{"payload":{"orderId":"order-42"},"prepared":true}""", task.Result);
        Assert.True(await program.TerminateRegisteredAsync(db) == 0, program.Describe());
        Assert.Equal(0, await db.RegisteredWorkersAsync());
    }

    [Fact(Timeout = 180_000)]
    public async Task TheOrchestrationRunsChildrenASignalAndAHumanWait()
    {
        await using var db = await ScenarioDatabase.CreateAsync(scratch);
        await using var program = ProgramProcess.Start("orchestration", db.Url, TestContext.Current.CancellationToken);
        var taskId = await EnqueueOrderAsync(db.Queue, "order.process");
        // The signal and the decision count only while the task waits for them.
        await ScenarioDatabase.EventuallyAsync(
            async () => (await db.Queue.SendSignalAsync(taskId, "approval", new { approved = true }, "approval-1", "test")).Status
                == SignalStatus.Delivered,
            $"the approval signal arrives; {program.Describe()}",
            TestContext.Current.CancellationToken);
        await ScenarioDatabase.EventuallyAsync(
            async () => (await db.Queue.CompleteHumanWaitAsync(taskId, "review", new { decision = "ship" }, "review-1", "test")).Status
                == HumanWaitStatus.Completed,
            $"the review decision arrives; {program.Describe()}",
            TestContext.Current.CancellationToken);

        var task = await db.TerminalAsync(taskId, program, TestContext.Current.CancellationToken);
        Assert.True(task.State == TaskState.Succeeded, program.Describe());
        var child = """{"completed":true,"payload":{"orderId":"order-42"}}""";
        AssertJson(
            $$$"""{"children":{"invoice":{{{child}}},"receipt":{{{child}}}},"approval":{"approved":true},"decision":{"decision":"ship"}}""",
            task.Result);
        Assert.True(await program.TerminateRegisteredAsync(db) == 0, program.Describe());
        Assert.Equal(0, await db.RegisteredWorkersAsync());
    }

    [Fact(Timeout = 180_000)]
    public async Task TheAgenticFlowCompletesItsDurableLifecycle()
    {
        await using var db = await ScenarioDatabase.CreateAsync(scratch);
        await using var program = ProgramProcess.Start("agentic-flow", db.Url, TestContext.Current.CancellationToken);
        Assert.True(await program.ExitAsync() == 0, program.Describe());
        using var outcome = JsonDocument.Parse(program.Output());
        var result = outcome.RootElement.GetProperty("result");
        Assert.Equal("completed", result.GetProperty("status").GetString());
        Assert.Equal("finalizing", outcome.RootElement.GetProperty("progress").GetProperty("stage").GetString());
        Assert.Equal(
            "Approved answer for Explain durable agent execution: durable context for Explain durable agent execution; total=31",
            result.GetProperty("response").GetProperty("text").GetString());
        var taskId = outcome.RootElement.GetProperty("taskId").GetGuid();
        Assert.Equal(TaskState.Succeeded, (await db.DetailAsync(taskId)).State);
    }

    /// <summary>Compares JSON values. PostgreSQL stores a result as <c>jsonb</c>, which orders the keys.</summary>
    private static void AssertJson(string expected, JsonElement? actual)
    {
        using var document = JsonDocument.Parse(expected);
        Assert.True(
            actual is { } value && JsonElement.DeepEquals(document.RootElement, value),
            $"expected {expected}, got {(actual is { } got ? got.GetRawText() : "null")}");
    }

    private static async Task<Guid> EnqueueOrderAsync(Queue queue, string taskType) =>
        (await queue.EnqueueAsync(taskType, new { orderId = "order-42" }, new EnqueueOptions { Queue = "orders" })).TaskId;
}
