using System.Text.Json;
using Npgsql;

namespace Workhorse.Examples.Programs.Scenarios;

/// <summary>
/// A durable agentic flow in an ordinary handler: a checkpointed plan, child tool tasks, a durable
/// cooldown timer, and an approval signal. It is the C# counterpart of
/// <c>typescript/examples/agentic-flow.mjs</c>. The model and the tools are deterministic stubs, so
/// the program calls no model API.
/// </summary>
/// <remarks>Documentation: https://workhorse.run/docs/agentic-flow</remarks>
public static class AgenticFlowProgram
{
    public const string ParentQueue = "agentic-flow";
    public const string ToolQueue = "agentic-tools";
    public const string PolicyNamespace = "agentic-flow-example";

    private static readonly string[] ProgressOrder = ["planned", "tools-complete", "awaiting-approval", "finalizing"];
    private static readonly string[] PlanSteps = ["research the request", "calculate supporting evidence"];
    private static readonly JsonSerializerOptions OutputJson = new(JsonSerializerDefaults.Web);

    /// <summary>The model and the tool calls of the flow.</summary>
    public interface IEffects
    {
        /// <summary>Calls the model for <paramref name="phase"/> <c>plan</c> or <c>answer</c>.</summary>
        Task<JsonElement> CallModelAsync(
            string phase,
            string prompt,
            IReadOnlyDictionary<string, JsonElement>? tools,
            string key,
            CancellationToken cancellationToken);

        /// <summary>Calls the tool <paramref name="tool"/> with <paramref name="input"/>.</summary>
        Task<JsonElement> CallToolAsync(string tool, string input, string key, CancellationToken cancellationToken);
    }

    /// <summary>The payload of <c>agent.loop</c>.</summary>
    public sealed record AgentRequest(string ConversationId, string Prompt);

    /// <summary>The payload of <c>agent.tool</c>.</summary>
    public sealed record ToolCall(string Tool, string Input);

    /// <summary>The payload of the <c>approval</c> signal.</summary>
    public sealed record Approval(bool Approved);

    /// <summary>The stubs of <c>defaultEffects()</c> in the TypeScript program.</summary>
    public sealed class DefaultEffects : IEffects
    {
        public Task<JsonElement> CallModelAsync(
            string phase,
            string prompt,
            IReadOnlyDictionary<string, JsonElement>? tools,
            string key,
            CancellationToken cancellationToken)
        {
            if (phase == "plan")
            {
                return Task.FromResult(JsonSerializer.SerializeToElement(new
                {
                    idempotencyKey = key,
                    steps = PlanSteps,
                }));
            }

            var summary = Field(tools, "research", "summary");
            var total = Field(tools, "calculate", "total");
            return Task.FromResult(JsonSerializer.SerializeToElement(new
            {
                idempotencyKey = key,
                text = $"Approved answer for {prompt}: {summary}; total={total}",
            }));
        }

        public Task<JsonElement> CallToolAsync(string tool, string input, string key, CancellationToken cancellationToken) =>
            Task.FromResult(tool == "research"
                ? JsonSerializer.SerializeToElement(new { idempotencyKey = key, summary = $"durable context for {input}" })
                : JsonSerializer.SerializeToElement(new { idempotencyKey = key, total = input.Length }));

        /// <summary>The text of <c>tools[tool][name]</c>, or <c>null</c> when it is absent.</summary>
        private static string Field(IReadOnlyDictionary<string, JsonElement>? tools, string tool, string name) =>
            tools is not null
            && tools.TryGetValue(tool, out var result)
            && result.ValueKind == JsonValueKind.Object
            && result.TryGetProperty(name, out var value)
                ? value.ValueKind == JsonValueKind.String ? value.GetString()! : value.GetRawText()
                : "null";
    }

    /// <summary>Sets the progress stage, unless the task already reached it or a later one.</summary>
    public static async Task ReportProgressAsync(HandlerContext context, string stage)
    {
        var next = Array.IndexOf(ProgressOrder, stage);
        if (next < 0)
        {
            throw new ArgumentException($"Unknown progress stage {stage}", nameof(stage));
        }

        var progress = await context.GetProgressAsync();
        var reached = progress?.Value is { ValueKind: JsonValueKind.Object } value
            && value.TryGetProperty("stage", out var current)
            && current.ValueKind == JsonValueKind.String
                ? Array.IndexOf(ProgressOrder, current.GetString())
                : -1;
        if (reached >= next)
        {
            return;
        }

        await context.SetProgressAsync(new { stage });
    }

    /// <summary>The parent worker that runs <c>agent.loop</c>.</summary>
    public static Worker ParentWorker(NpgsqlDataSource dataSource, IEffects effects, TimeSpan cooldown)
    {
        var worker = new Worker(dataSource, new WorkerOptions
        {
            Queues = [ParentQueue],
            WorkerId = "agentic-flow-parent",
            PollInterval = TimeSpan.FromMilliseconds(1),
        });
        worker.Handle("agent.loop", async (HandlerContext context, AgentRequest payload) =>
        {
            var taskId = context.Task.Id;
            var plan = await context.CheckpointAsync(
                "plan",
                token => effects.CallModelAsync("plan", payload.Prompt, null, $"{taskId}:plan", token));
            await ReportProgressAsync(context, "planned");

            var toolOptions = new EnqueueOptions { Queue = ToolQueue, ConcurrencyKey = payload.ConversationId };
            var tools = await context.RunChildrenAllAsync(
            [
                new ChildRequest
                {
                    Name = "research",
                    TaskType = "agent.tool",
                    Payload = new ToolCall("research", payload.Prompt),
                    Options = toolOptions,
                },
                new ChildRequest
                {
                    Name = "calculate",
                    TaskType = "agent.tool",
                    Payload = new ToolCall("calculate", payload.Prompt),
                    Options = toolOptions,
                },
            ]);
            await ReportProgressAsync(context, "tools-complete");

            await context.SleepAsync("model-cooldown", cooldown);
            await ReportProgressAsync(context, "awaiting-approval");
            var approval = await context.WaitForSignalAsync<Approval>("approval", timeout: null);
            if (!approval.Approved)
            {
                return (object)new { status = "rejected", plan, tools };
            }

            await ReportProgressAsync(context, "finalizing");
            var response = await context.CheckpointAsync(
                "final-response",
                token => effects.CallModelAsync("answer", payload.Prompt, tools, $"{taskId}:final-response", token));
            return new { status = "completed", plan, tools, response };
        });
        return worker;
    }

    /// <summary>The tool worker that runs <c>agent.tool</c>.</summary>
    public static Worker ToolWorker(NpgsqlDataSource dataSource, IEffects effects)
    {
        var worker = new Worker(dataSource, new WorkerOptions
        {
            Queues = [ToolQueue],
            WorkerId = "agentic-flow-tools",
            Concurrency = 2,
            PollInterval = TimeSpan.FromMilliseconds(1),
        });
        worker.Handle("agent.tool", async (HandlerContext context, ToolCall payload) =>
        {
            var key = $"{context.Task.Id}:tool-call";
            var result = await context.CheckpointAsync(
                "tool-call",
                token => effects.CallToolAsync(payload.Tool, payload.Input, key, token));
            await ReportProgressAsync(context, "planned");
            return result;
        });
        return worker;
    }

    /// <summary>
    /// Runs one flow to its end, and returns the task id, its result, and its last progress value.
    /// The loop runs a bounded number of passes.
    /// </summary>
    public static async Task<FlowOutcome> RunFlowAsync(
        NpgsqlDataSource dataSource,
        string conversationId,
        string prompt,
        TimeSpan cooldown,
        IEffects effects)
    {
        var queue = new Queue(dataSource);
        await queue.AssertCompatibleAsync();
        var admin = new Admin(dataSource);
        await queue.SyncRateLimitPoliciesAsync(
            PolicyNamespace,
            [
                new RateLimitPolicyDefinition
                {
                    Queue = ToolQueue,
                    Rate = new RateLimit { Limit = 100, Interval = TimeSpan.FromSeconds(1), Burst = 100 },
                    PerKey = new RateLimit { Limit = 10, Interval = TimeSpan.FromSeconds(1), Burst = 10 },
                },
            ],
            prune: false);

        await using var parent = ParentWorker(dataSource, effects, cooldown);
        await using var tools = ToolWorker(dataSource, effects);
        var taskId = (await queue.EnqueueAsync(
            "agent.loop",
            new AgentRequest(conversationId, prompt),
            new EnqueueOptions
            {
                Queue = ParentQueue,
                Idempotency = new Idempotency { Key = $"agentic-flow:{conversationId}" },
            })).TaskId;

        var approvalDelivered = false;
        for (var pass = 0; pass < 100; pass++)
        {
            await parent.RunOnceAsync();
            await tools.RunOnceAsync();

            if (!approvalDelivered)
            {
                var delivery = await queue.SendSignalAsync(
                    taskId,
                    "approval",
                    new Approval(true),
                    $"agentic-flow:{conversationId}:approval",
                    "agentic-flow-example");
                approvalDelivered = delivery.Status is SignalStatus.Delivered or SignalStatus.Duplicate;
            }

            var snapshot = await admin.GetTaskAsync(taskId)
                ?? throw new InvalidOperationException($"task {taskId} does not exist");
            if (snapshot.State == TaskState.Succeeded)
            {
                return new FlowOutcome(taskId, snapshot.Result, snapshot.Progress?.Value);
            }

            if (snapshot.State is TaskState.Failed or TaskState.Canceled)
            {
                throw new InvalidOperationException($"Agentic flow finished in {snapshot.State} state");
            }

            await Task.Delay(20);
        }

        throw new InvalidOperationException($"Agentic flow {taskId} did not finish within the bounded example loop");
    }

    public static async Task RunAsync()
    {
        await using var dataSource = ProgramDatabase.DataSource();
        var outcome = await RunFlowAsync(
            dataSource,
            "conversation-example",
            "Explain durable agent execution",
            TimeSpan.FromMilliseconds(10),
            new DefaultEffects());
        Console.WriteLine(JsonSerializer.Serialize(outcome, OutputJson));
    }

    /// <summary>The task id, the result, and the last progress value of one flow.</summary>
    public sealed record FlowOutcome(Guid TaskId, JsonElement? Result, JsonElement? Progress);
}
