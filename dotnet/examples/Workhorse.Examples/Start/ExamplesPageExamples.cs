using System.Text.Json;
using Npgsql;

namespace Workhorse.Examples.Start;

/// <summary>The C# tabs of the site page of examples.</summary>
public sealed class ExamplesPageExamples(NpgsqlDataSource dataSource, Queue queue, Admin admin)
{
    // docs:start csharp-examples-page-create-order
    public async Task CreateOrderAsync(string orderId, string[] items)
    {
        await using var connection = await dataSource.OpenConnectionAsync();
        await using var transaction = await connection.BeginTransactionAsync();
        await using (var insert = new NpgsqlCommand(
            "INSERT INTO orders (id, items) VALUES ($1, $2)", connection))
        {
            insert.Parameters.AddWithValue(orderId);
            insert.Parameters.AddWithValue(items);
            await insert.ExecuteNonQueryAsync();
        }

        await queue.Using(connection).EnqueueAsync(
            "order.fulfill",
            new { orderId },
            new EnqueueOptions { Queue = "orders" });
        await transaction.CommitAsync();
    }
    // docs:end

    // docs:start csharp-examples-page-trial-lifecycle
    public sealed record Trial(string To, DateTimeOffset FollowUpAt);

    public sealed record Sent(string DeliveredTo, string Kind, string IdempotencyKey);

    public sealed record Delivered(string DeliveredTo);

    // Stand-ins for a mail provider. A real send passes the key to the provider's
    // idempotency option, and the provider drops a repeated send with the same key.
    public static Task<Sent> SendWelcomeAsync(string to, string idempotencyKey) =>
        Task.FromResult(new Sent(to, "welcome", idempotencyKey));

    public static Task<Sent> SendFollowUpAsync(string to, string idempotencyKey) =>
        Task.FromResult(new Sent(to, "follow-up", idempotencyKey));

    public static void RegisterTrialHandler(Worker worker)
    {
        worker.Handle<Trial, Delivered>("trial.lifecycle", async (context, trial) =>
        {
            await context.CheckpointAsync(
                "welcome",
                _ => SendWelcomeAsync(trial.To, $"welcome:{context.Task.Id}"));
            await context.SleepUntilAsync("follow-up-window", trial.FollowUpAt);
            await context.CheckpointAsync(
                "follow-up",
                _ => SendFollowUpAsync(trial.To, $"follow-up:{context.Task.Id}"));
            return new Delivered(trial.To);
        });
    }
    // docs:end

    // docs:start csharp-examples-page-billing-worker
    public async Task RunBillingWorkerAsync(CancellationToken stoppingToken)
    {
        // Deployment step: reconcile the namespace to exactly this set.
        var nightly = new ScheduleDefinition
        {
            Name = "nightly-invoice-run",
            Schedule = "0 3 * * *",
            Task = new ScheduledTask
            {
                TaskType = "invoice.generate",
                Payload = new { scope = "due" },
                Queue = "billing",
            },
        };
        await queue.SyncSchedulesAsync("billing-production", [nightly], stoppingToken);

        // Worker process: evaluate and fire schedules for that namespace.
        await using var worker = new Worker(dataSource, new WorkerOptions
        {
            Queues = ["billing"],
            ScheduleNamespaces = ["billing-production"],
        });
        worker.Handle<JsonElement, object>(
            "invoice.generate",
            (context, payload) => Task.FromResult<object>(new { generated = true, payload }));
        await worker.RunAsync(stoppingToken);
    }
    // docs:end

    // docs:start csharp-examples-page-stripe-webhook
    public sealed record StripeEvent(string Id, string Type, JsonElement? Data);

    public async Task<Guid> HandleStripeWebhookAsync(StripeEvent stripeEvent)
    {
        var result = await queue.EnqueueAsync(
            "stripe.event",
            new { eventId = stripeEvent.Id, eventType = stripeEvent.Type },
            new EnqueueOptions
            {
                Queue = "webhooks",
                Idempotency = new Idempotency
                {
                    Key = $"stripe:{stripeEvent.Id}",
                    Scope = "stripe-webhooks",
                    Ttl = TimeSpan.FromDays(1),
                },
            });
        return result.TaskId;
    }
    // docs:end

    // docs:start csharp-examples-page-redrive-incident
    public async Task RedriveIncidentAsync()
    {
        var filter = new RedriveFilter { Queue = "billing", ErrorName = "ProviderTimeout", Limit = 100 };
        var audit = new AdminAudit
        {
            Actor = "reviewer@example.com",
            Reason = "provider incident INC-2041 resolved",
            RequestId = "INC-2041",
        };

        var preview = await admin.RedriveManyAsync(filter with { DryRun = true }, audit);
        Console.WriteLine($"{preview.Results.Count} tasks eligible");

        DeadLetterCursor? cursor = null;
        do
        {
            var page = await admin.RedriveManyAsync(filter with { Cursor = cursor }, audit);
            foreach (var result in page.Results)
            {
                Console.WriteLine($"{result.Status} {result.SourceTaskId} -> {result.TargetTaskId}");
            }

            cursor = page.NextCursor;
        }
        while (cursor is not null);
    }
    // docs:end

    // docs:start csharp-examples-page-cancel-export
    public sealed record Export(IReadOnlyList<string> Parts);

    public sealed record ExportResult(bool Exported);

    public static void UploadPart(string part) => Console.WriteLine($"uploading {part}");

    public async Task ConfigureExportAsync(Worker worker, Guid taskId)
    {
        await queue.CancelAsync(taskId, new CancelOptions
        {
            RequestedBy = "support@example.com",
            Reason = "customer withdrew the order",
        });

        worker.Handle<Export, ExportResult>("export.build", (context, export) =>
        {
            foreach (var part in export.Parts)
            {
                context.CancellationToken.ThrowIfCancellationRequested();
                UploadPart(part);
            }

            return Task.FromResult(new ExportResult(Exported: true));
        });
    }
    // docs:end

    // docs:start csharp-examples-page-agent-loop
    public interface IModel
    {
        Task<Plan> PlanAsync(string prompt, string idempotencyKey, CancellationToken cancellationToken);
    }

    public sealed record AgentRun(string Prompt, string ConversationId);

    public sealed record Tool(string Id, string? Query);

    public sealed record Plan(IReadOnlyList<Tool> Tools);

    public sealed record Approval(bool Approved);

    public sealed record AgentResult(
        Plan Plan,
        IReadOnlyDictionary<string, JsonElement> Tools,
        bool Approved);

    public static void RegisterAgent(Worker worker, IModel model, TimeSpan cooldown)
    {
        worker.Handle<AgentRun, AgentResult>("agent.run", async (context, run) =>
        {
            var plan = await context.CheckpointAsync(
                "plan",
                token => model.PlanAsync(run.Prompt, $"plan:{context.Task.Id}", token));

            var children = plan.Tools
                .Select(tool => new ChildRequest
                {
                    Name = tool.Id,
                    TaskType = "agent.tool",
                    Payload = tool,
                    Options = new EnqueueOptions { Queue = "tools", ConcurrencyKey = run.ConversationId },
                })
                .ToList();

            var tools = await context.RunChildrenAllAsync(children);
            await context.SleepAsync("model-cooldown", cooldown);
            var approval = await context.WaitForSignalAsync<Approval>("approval", null);
            return new AgentResult(plan, tools, approval.Approved);
        });
    }
    // docs:end
}
