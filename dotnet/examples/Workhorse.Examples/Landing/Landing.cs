using System.Text.Json;
using Microsoft.AspNetCore.Routing;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Npgsql;
using Workhorse.AspNetCore;
using Workhorse.Hosting;

namespace Workhorse.Examples.Landing;

// The C# snippets of the landing page (https://workhorse.run). Each `docs:start landing-<name>-csharp`
// region is one snippet. Each class holds one snippet, as each class of Landing.java does, so two
// snippets can use the same method name. Workhorse.Examples.Tests/Landing runs each region.

/// <summary>The first snippet of the page: enqueue a task and run a worker.</summary>
public static class HeroExample
{
    // docs:start landing-hero-csharp
    public sealed record Welcome(string To);

    public static async Task RunAsync(NpgsqlDataSource dataSource, CancellationToken stoppingToken)
    {
        await new Queue(dataSource).EnqueueAsync("email.welcome", new { to = "ada@example.com" }, stoppingToken);

        await using var worker = new Worker(dataSource, new WorkerOptions { Concurrency = 4 });
        worker.Handle(
            "email.welcome",
            (HandlerContext context, Welcome welcome) => Task.FromResult(new { deliveredTo = welcome.To }));
        await worker.RunAsync(stoppingToken);
    }
    // docs:end
}

/// <summary>Enqueue in the transaction of the application.</summary>
public static class EnqueueExample
{
    // docs:start landing-enqueue-csharp
    public static async Task CreateOrderAsync(NpgsqlDataSource dataSource, string orderId, long total)
    {
        await using var connection = await dataSource.OpenConnectionAsync();
        await using var transaction = await connection.BeginTransactionAsync();
        await using (var insert = new NpgsqlCommand(
            "INSERT INTO orders (id, total) VALUES (@id, @total)", connection, transaction))
        {
            insert.Parameters.AddWithValue("id", orderId);
            insert.Parameters.AddWithValue("total", total);
            await insert.ExecuteNonQueryAsync();
        }

        // Same transaction: the task exists exactly when the order does.
        await new Queue(dataSource).Using(connection).EnqueueAsync("order.confirm", new { orderId });
        await transaction.CommitAsync();
    }
    // docs:end
}

/// <summary>Checkpoints.</summary>
public static class CheckpointsExample
{
    // docs:start landing-checkpoints-csharp
    public sealed record Invoice(long Amount, string Email);

    public sealed record Charge(string Id);

    public sealed record Pdf(string ChargeId);

    public static Task<Charge> ChargeCardAsync(long amount) =>
        Task.FromResult(new Charge($"ch_{amount}"));

    public static Task<Pdf> RenderInvoiceAsync(string chargeId) =>
        Task.FromResult(new Pdf(chargeId));

    public static void RegisterInvoice(Worker worker)
    {
        worker.Handle(
            "invoice.issue",
            async (HandlerContext context, Invoice invoice) =>
            {
                // Later runs return the stored checkpoint result.
                var charge = await context.CheckpointAsync(
                    "charge", _ => ChargeCardAsync(invoice.Amount));

                var pdf = await context.CheckpointAsync(
                    "render", _ => RenderInvoiceAsync(charge.Id));

                Console.WriteLine($"email {invoice.Email} {pdf}");
                return new { chargeId = charge.Id };
            });
    }
    // docs:end
}

/// <summary>A durable sleep.</summary>
public static class SleepExample
{
    // docs:start landing-sleep-csharp
    public sealed record Order(string OrderId);

    public static Task<Order> PlaceOrderAsync(Order payload) => Task.FromResult(new Order(payload.OrderId));

    public static void RegisterSettlement(Worker worker)
    {
        worker.Handle("order.settle", async (HandlerContext context, Order payload) =>
        {
            var order = await context.CheckpointAsync("place", _ => PlaceOrderAsync(payload));

            // Slot released here. The process can restart, deploy, or die.
            await context.SleepAsync("settlement-window", TimeSpan.FromHours(1));

            return new { settled = order.OrderId };
        });
    }
    // docs:end
}

/// <summary>Deadlines, timeouts, and retries.</summary>
public static class RetriesExample
{
    // docs:start landing-retries-csharp
    public static Task<EnqueueResult> RemindAsync(Queue queue, string matchId, DateTimeOffset kickoff) =>
        queue.EnqueueAsync(
            "match.reminder",
            new { matchId },
            new EnqueueOptions
            {
                // Pointless after kickoff, whatever else happens.
                Deadline = kickoff,
                // Any single attempt is stuck after 30 seconds.
                ExecutionTimeout = TimeSpan.FromSeconds(30),
                MaxAttempts = 5,
                RetryPolicy = RetryPolicy.Exponential(
                    initialDelay: TimeSpan.FromSeconds(1),
                    multiplier: 2,
                    maxDelay: TimeSpan.FromSeconds(60)),
            });
    // docs:end
}

/// <summary>Enqueue idempotency.</summary>
public static class IdempotencyExample
{
    // docs:start landing-idempotency-csharp
    // A retried webhook gets the same TaskId back instead of a second capture.
    public static Task<EnqueueResult> CaptureAsync(Queue queue) =>
        queue.EnqueueAsync(
            "invoice.capture",
            new { invoiceId = "inv-1" },
            new EnqueueOptions
            {
                Queue = "billing",
                Idempotency = new Idempotency
                {
                    Key = "capture:inv-1",
                    Scope = "tenant-42",
                    Ttl = TimeSpan.FromDays(1),
                },
            });
    // docs:end
}

/// <summary>Schedules.</summary>
public static class SchedulesExample
{
    // docs:start landing-schedules-csharp
    public static async Task RunAsync(
        NpgsqlDataSource dataSource,
        CancellationToken stoppingToken)
    {
        // Run on every deployment with the complete list.
        var schedule = new ScheduleDefinition
        {
            Name = "nightly-invoice-run",
            Schedule = "0 2 * * *",
            Task = new ScheduledTask
            {
                TaskType = "invoices.generate",
                Payload = new { },
            },
        };
        var queue = new Queue(dataSource);
        await queue.SyncSchedulesAsync(
            "billing", [schedule], prune: true, stoppingToken);

        // Any worker in the namespace fires due schedules itself.
        var options = new WorkerOptions
        {
            ScheduleNamespaces = ["billing"],
        };
        await using var worker = new Worker(dataSource, options);
        await worker.RunAsync(stoppingToken);
    }
    // docs:end
}

/// <summary>Concurrency and rate limits.</summary>
public static class FlowControlExample
{
    // docs:start landing-flow-control-csharp
    public static async Task ConfigureAsync(
        Queue queue,
        string messageId,
        string tenantId)
    {
        // At most 20 mail tasks active; at most 2 per tenant.
        var mail = new ConcurrencyPolicyDefinition
        {
            Queue = "mail",
            MaxActive = 20,
            MaxActivePerKey = 2,
        };
        await queue.SyncConcurrencyPoliciesAsync(
            "workers", [mail], prune: false);

        var provider = new RateLimitPolicyDefinition
        {
            Queue = "provider-api",
            Rate = new RateLimit
            {
                Limit = 100,
                Interval = TimeSpan.FromSeconds(1),
                Burst = 200,
            },
        };
        await queue.SyncRateLimitPoliciesAsync(
            "workers", [provider], prune: false);

        await queue.EnqueueAsync(
            "mail.send",
            new { messageId },
            new EnqueueOptions
            {
                Queue = "mail",
                ConcurrencyKey = $"tenant:{tenantId}",
            });
    }
    // docs:end
}

/// <summary>Dependencies and child tasks.</summary>
public static class DependenciesExample
{
    // docs:start landing-dependencies-csharp
    public static async Task ConfirmAsync(Queue queue, string orderId)
    {
        var order = new { orderId };
        var inventory = await queue.EnqueueAsync(
            "inventory.reserve", order);

        var dependencies = new Dependencies
        {
            PrerequisiteTaskIds = [inventory.TaskId],
            OnSuccess = DependencyPolicy.Release,
            OnFailure = DependencyPolicy.Cancel,
            OnCancellation = DependencyPolicy.Cancel,
        };
        var options = new EnqueueOptions { Dependencies = dependencies };
        await queue.EnqueueAsync("order.confirm", order, options);
    }

    public sealed record Fulfillment(string Id);

    public sealed record Capture(string OrderId);

    public static void RegisterFulfillment(Worker worker)
    {
        worker.Handle(
            "order.fulfill",
            async (HandlerContext context, Fulfillment order) =>
            {
                var options = new EnqueueOptions { Queue = "payments" };
                var capture = new Capture(order.Id);
                var receipt = await context
                    .RunChildAsync<Capture, JsonElement>(
                        "charge", "payment.capture", capture, options);
                return new { receipt };
            });
    }
    // docs:end
}

/// <summary>Debounce.</summary>
public static class CoalescingExample
{
    // docs:start landing-coalescing-csharp
    public static async Task ReindexAsync(Queue queue, string documentId, TimeSpan quietPeriod)
    {
        var debounce = new Debounce
        {
            Key = documentId,
            Window = quietPeriod,
            Schedule = DebounceSchedule.Reset,
            Scope = "search-index",
        };
        var options = new EnqueueOptions { Debounce = debounce };
        var first = await queue.EnqueueAsync("search.reindex", new { documentId, revision = 1 }, options);
        var latest = await queue.EnqueueAsync("search.reindex", new { documentId, revision = 2 }, options);
        Console.WriteLine($"{first.Outcome} {latest.Outcome}");
    }
    // docs:end
}

/// <summary>Signals and human waits.</summary>
public static class ExternalWaitsExample
{
    // docs:start landing-external-waits-csharp
    public sealed record Release(string Id);

    public sealed record ApprovalRequest(
        string ReleaseId,
        JsonElement Scan);

    public sealed record Review(bool Approved);

    public static void RegisterRelease(Worker worker)
    {
        worker.Handle(
            "release.publish",
            async (HandlerContext context, Release release) =>
            {
                var scan = await context.WaitForSignalAsync<JsonElement>(
                    "security-scan", timeout: null);

                var request = new ApprovalRequest(release.Id, scan);
                var review = await context
                    .WaitForHumanAsync<ApprovalRequest, Review>(
                        "release-approval", request, timeout: null);

                return new { published = review.Approved };
            });
    }

    public static Task DeliverScanAsync(
        Queue queue,
        Guid taskId,
        object result,
        string deliveryId) =>
        queue.SendSignalAsync(
            taskId,
            "security-scan",
            result,
            deliveryId,
            "security-scanner");
    // docs:end
}

/// <summary>Batch handlers.</summary>
public static class BatchHandlersExample
{
    // docs:start landing-batch-handlers-csharp
    public static void RegisterEmailBatch(Worker worker, int batchSize, TimeSpan linger)
    {
        worker.HandleBatch<JsonElement>(
            "email.send",
            new BatchOptions { MaxSize = batchSize, Linger = linger },
            (items, cancellationToken) => Task.FromResult<IReadOnlyList<BatchHandlerOutcome>>(
                [.. items.Select(item => new BatchSucceeded(item.Payload))]));
    }
    // docs:end
}

/// <summary>Cancellation.</summary>
public static class CancellationExample
{
    // docs:start landing-cancellation-csharp
    public static Task UploadAsync(string row, CancellationToken cancellationToken)
    {
        Console.WriteLine($"upload {row}");
        return Task.CompletedTask;
    }

    public static async Task ConfigureExportAsync(Queue queue, Worker worker, Guid taskId)
    {
        worker.Handle("rows.export", async (HandlerContext context, string[] rows) =>
        {
            foreach (var row in rows)
            {
                context.CancellationToken.ThrowIfCancellationRequested();
                await UploadAsync(row, context.CancellationToken);
            }

            return new { stopped = false };
        });

        await queue.CancelAsync(
            taskId,
            new CancelOptions { RequestedBy = "operator@example.com", Reason = "customer withdrew the request" });
    }
    // docs:end
}

/// <summary>Dead letters.</summary>
public static class DeadLettersExample
{
    // docs:start landing-dead-letters-csharp
    public static async Task RedriveBillingAsync(Admin admin)
    {
        var query = new DeadLetterQuery { Queue = "billing", ErrorName = "CardDeclined", Limit = 100 };
        var page = await admin.ListDeadLettersAsync(query);

        foreach (var failure in page.Items)
        {
            var audit = new AdminAudit
            {
                Actor = "operator@example.com",
                Reason = "provider incident resolved",
                RequestId = $"incident-2026-08-03:{failure.TaskId}",
            };
            await admin.RedriveAsync(failure.TaskId, audit);
        }
    }
    // docs:end
}

/// <summary>The dashboard.</summary>
public static class OperateDashboardExample
{
    // docs:start landing-operate-dashboard-csharp
    public static void Mount(IEndpointRouteBuilder endpoints, NpgsqlDataSource dataSource)
    {
        endpoints.MapWorkhorseDashboard("/workhorse", new DashboardOptions
        {
            DataSource = dataSource,
            Authorize = context =>
            {
                // The application's own authentication sets context.User.
                var user = context.User;
                var actor = user.IsInRole("admin") ? user.Identity?.Name : null;
                return ValueTask.FromResult(actor is not null
                    ? DashboardAuthorization.Principal(actor, claims: null)
                    : DashboardAuthorization.Deny());
            },
        });
    }
    // docs:end
}

/// <summary>Queue health and the task list.</summary>
public static class OperateHealthExample
{
    // docs:start landing-operate-health-csharp
    public static async Task InspectAsync(NpgsqlDataSource dataSource)
    {
        var health = await new Queue(dataSource).HealthAsync();
        if (health.Snapshot.TryGetValue("status", out var status)
            && status.GetProperty("level").GetString() != "healthy")
        {
            Console.WriteLine(status.GetProperty("reasons"));
        }

        // Cross-state listing on a dedicated projection: reading it never slows dispatch down.
        var query = new TaskQuery { States = [TaskState.Active, TaskState.Scheduled], Limit = 100 };
        var live = await new Admin(dataSource).ListTasksAsync(query);
        Console.WriteLine(live.Items.Count);
    }

    // A Generic Host reports the same database and schema check on its health endpoint.
    public static void AddHealthCheck(IServiceCollection services) =>
        services.AddHealthChecks().AddWorkhorse();
    // docs:end
}

/// <summary>The worker fleet.</summary>
public static class OperateFleetExample
{
    // docs:start landing-operate-fleet-csharp
    public static async Task PauseBillingAsync(NpgsqlDataSource dataSource)
    {
        var admin = new Admin(dataSource);
        foreach (var entry in await admin.ListWorkersAsync())
        {
            if (entry.Queue != "billing")
            {
                continue;
            }

            var audit = new AdminAudit
            {
                Actor = "operator@example.com",
                Reason = "rolling deploy",
                RequestId = $"deploy-2026-08-23:{entry.WorkerId}",
            };
            await admin.SetWorkerPausedAsync(entry.WorkerId, paused: true, audit);
        }
    }
    // docs:end
}

/// <summary>A worker process for deployment.</summary>
public static class DeployExample
{
    // docs:start landing-deploy-csharp
    public sealed record Email(string To);

    public static async Task RunAsync(string[] args, CancellationToken cancellationToken)
    {
        var builder = Host.CreateApplicationBuilder(args);

        // The application supplies the pool. ConnectionStrings:Workhorse holds an Npgsql connection string.
        var connectionString = builder.Configuration.GetConnectionString("Workhorse")
            ?? throw new InvalidOperationException("ConnectionStrings:Workhorse is not set");
        builder.Services.AddSingleton(_ => NpgsqlDataSource.Create(connectionString));

        builder.Services.AddWorkhorse(builder.Configuration);
        builder.Services.Configure<WorkerOptions>(options =>
        {
            options.Queues = ["email"];
            options.Concurrency = 8;
            // Bounded graceful drain when the host stops on SIGTERM.
            options.ShutdownGrace = TimeSpan.FromSeconds(25);
        });
        builder.Services.AddWorkhorseWorker(worker => worker.Handle(
            "email.send",
            (HandlerContext context, Email email) => Task.FromResult(new { sent = email.To })));

        await builder.Build().RunAsync(cancellationToken);
    }
    // docs:end
}
