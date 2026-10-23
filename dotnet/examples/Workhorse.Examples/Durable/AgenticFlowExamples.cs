namespace Workhorse.Examples.Durable;

/// <summary>The payload of the <c>agent.loop</c> task.</summary>
public sealed record AgentPayload(string ConversationId, string Prompt);

/// <summary>The C# tab of the site page about the durable agentic flow.</summary>
/// <param name="model">Plans the answer to a prompt.</param>
/// <param name="toolQueue">The queue of the tool tasks.</param>
/// <param name="cooldown">The wait before the loop asks for approval.</param>
public sealed class AgenticFlowExamples(Func<string, CancellationToken, Task<string>> model, string toolQueue, TimeSpan cooldown)
{
    /// <summary>Registers the <c>agent.loop</c> handler and the two tool handlers.</summary>
    public void Register(Worker worker)
    {
        ArgumentNullException.ThrowIfNull(worker);
        var toolOptions = new EnqueueOptions { Queue = toolQueue };
        worker.Handle<AgentPayload, object>(
            "agent.loop",
            async (context, payload) =>
            {
                var prompt = payload.Prompt;
                ChildRequest[] toolRequests =
                [
                    new() { Name = "research", TaskType = "agent.research", Payload = payload, Options = toolOptions },
                    new() { Name = "calculate", TaskType = "agent.calculate", Payload = payload, Options = toolOptions },
                ];
                // docs:start csharp-agentic-flow-loop
                var plan = await context.CheckpointAsync("plan", ct => CallModelAsync(prompt, ct));
                await context.SetProgressAsync(new { stage = "planned" });
                var tools = await context.RunChildrenAllAsync(toolRequests);
                await context.SleepAsync("model-cooldown", cooldown);
                var approval = await context.WaitForSignalAsync<Approval>("approval", null);
                // docs:end
                return new { plan, tools, approval };
            });
        worker.Handle<AgentPayload, object>("agent.research", (context, payload) => Task.FromResult<object>(new { sources = 3 }));
        worker.Handle<AgentPayload, object>("agent.calculate", (context, payload) => Task.FromResult<object>(new { total = 42 }));
    }

    private Task<string> CallModelAsync(string prompt, CancellationToken cancellationToken) => model(prompt, cancellationToken);
}
