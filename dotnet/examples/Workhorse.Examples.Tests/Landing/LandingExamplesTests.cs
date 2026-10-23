using System.Globalization;
using System.Security.Claims;
using System.Text.Json;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Hosting.Server;
using Microsoft.AspNetCore.Hosting.Server.Features;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Diagnostics.HealthChecks;
using Microsoft.Extensions.Logging;
using Workhorse.Examples.Landing;
using Workhorse.Examples.Tests.Testing;
using Workhorse.Hosting;
using Workhorse.Tests.Testing;

namespace Workhorse.Examples.Tests.Landing;

/// <summary>
/// Runs each C# snippet of the landing page against PostgreSQL. A snippet that runs a worker, or
/// that writes fixed names such as the <c>billing</c> idempotency key or the <c>workers</c>
/// policies, gets a database of its own.
/// </summary>
[Collection(ConsoleCapture.Name)]
public sealed class LandingExamplesTests(ScratchDatabase scratch)
{
    private static readonly string[] CanceledRows = ["row-1", "row-2"];
    private static readonly string[] ExportedRows = ["row-3"];

    private readonly ExampleDatabase _shared = ExampleDatabase.Shared(scratch);

    [Fact(Timeout = 120_000)]
    public async Task TheHeroWorkerRunsTheWelcomeTask()
    {
        var token = TestContext.Current.CancellationToken;
        await using var db = await ExampleDatabase.CreateIsolatedAsync(scratch);
        await LandingSupport.RunUntilAsync(
            stoppingToken => HeroExample.RunAsync(db.DataSource, stoppingToken),
            async () => (await db.TasksAsync("email.welcome", "to", "ada@example.com")) is [var taskId]
                && (await db.DetailAsync(taskId)).State == TaskState.Succeeded,
            "the welcome task succeeds",
            token);
        var task = await db.TaskAsync("email.welcome", "to", "ada@example.com");
        AssertJson("""{"deliveredTo": "ada@example.com"}""", task.Result);
    }

    [Fact]
    public async Task TheOrderAndItsTaskCommitTogether()
    {
        await using var db = await ExampleDatabase.CreateIsolatedAsync(scratch);
        await db.ExecuteAsync("CREATE TABLE orders (id text PRIMARY KEY, total bigint NOT NULL)");
        var orderId = $"csharp-{Guid.NewGuid()}";
        await EnqueueExample.CreateOrderAsync(db.DataSource, orderId, 4200);
        Assert.Equal(4200L, await db.ScalarAsync<long>("SELECT total FROM orders WHERE id = $1", orderId));
        Assert.Single(await db.TasksAsync("order.confirm", "orderId", orderId));
    }

    [Fact(Timeout = 120_000)]
    public async Task TheInvoiceHandlerStoresBothCheckpoints()
    {
        var token = TestContext.Current.CancellationToken;
        await using var db = await ExampleDatabase.CreateIsolatedAsync(scratch);
        var taskId = (await db.Queue.EnqueueAsync("invoice.issue", new { amount = 4200, email = "ada@example.com" }, token)).TaskId;
        await using (var worker = new Worker(db.DataSource, new WorkerOptions()))
        {
            CheckpointsExample.RegisterInvoice(worker);
            await LandingSupport.RunUntilAsync(worker, db, taskId, TaskState.Succeeded, token);
        }

        AssertJson("""{"chargeId": "ch_4200"}""", (await db.DetailAsync(taskId)).Result);
        Assert.Equal(2, (await db.Admin.ListCheckpointsAsync(taskId, token)).Count);
    }

    [Fact(Timeout = 120_000)]
    public async Task TheSettlementSleepsAfterItsCheckpoint()
    {
        var token = TestContext.Current.CancellationToken;
        await using var db = await ExampleDatabase.CreateIsolatedAsync(scratch);
        var orderId = $"csharp-{Guid.NewGuid()}";
        var taskId = (await db.Queue.EnqueueAsync("order.settle", new { orderId }, token)).TaskId;
        await using (var worker = new Worker(db.DataSource, new WorkerOptions()))
        {
            SleepExample.RegisterSettlement(worker);
            await LandingSupport.RunUntilAsync(worker, db, taskId, TaskState.Scheduled, token);
        }

        var place = await db.Admin.GetCheckpointAsync(taskId, "place", token);
        AssertJson($$"""{"orderId": "{{orderId}}"}""", place?.Value);
        var wait = await db.Admin.GetWaitAsync(taskId, "settlement-window", token);
        Assert.Equal(TimeSpan.FromHours(1), wait?.Duration);
    }

    [Fact]
    public async Task TheReminderCarriesItsDeadlineTimeoutAndRetryPolicy()
    {
        var matchId = $"csharp-{Guid.NewGuid()}";
        var kickoff = DateTimeOffset.UtcNow.AddDays(2);
        kickoff = kickoff.AddTicks(-(kickoff.Ticks % TimeSpan.TicksPerSecond));
        var result = await RetriesExample.RemindAsync(_shared.Queue, matchId, kickoff);
        var task = await _shared.DetailAsync(result.TaskId);
        Assert.Equal(kickoff, task.DeadlineAt);
        Assert.Equal(TimeSpan.FromSeconds(30), task.ExecutionTimeout);
        Assert.Equal(5, task.MaxAttempts);
        var policy = task.RetryPolicy!.Value;
        Assert.Equal("exponential", policy.GetProperty("type").GetString());
        Assert.Equal(1_000, policy.GetProperty("initialDelayMs").GetInt64());
        Assert.Equal(2, policy.GetProperty("multiplier").GetInt64());
        Assert.Equal(60_000, policy.GetProperty("maxDelayMs").GetInt64());
    }

    [Fact]
    public async Task ASecondCaptureReplaysTheFirstTask()
    {
        await using var db = await ExampleDatabase.CreateIsolatedAsync(scratch);
        var first = await IdempotencyExample.CaptureAsync(db.Queue);
        var second = await IdempotencyExample.CaptureAsync(db.Queue);
        Assert.Equal(first.TaskId, second.TaskId);
        Assert.Equal(EnqueueOutcome.Replayed, second.Outcome);
        Assert.Equal("billing", (await db.DetailAsync(first.TaskId)).Queue);
    }

    [Fact(Timeout = 120_000)]
    public async Task TheScheduleIsStoredAndTheWorkerRuns()
    {
        var token = TestContext.Current.CancellationToken;
        await using var db = await ExampleDatabase.CreateIsolatedAsync(scratch);
        await LandingSupport.RunUntilAsync(
            stoppingToken => SchedulesExample.RunAsync(db.DataSource, stoppingToken),
            async () =>
                await db.ScalarAsync<long>(
                    "SELECT count(*) FROM workhorse.schedule_definition WHERE namespace = $1 AND schedule_name = $2",
                    "billing",
                    "nightly-invoice-run") == 1
                && (await db.Admin.ListWorkersAsync(token)).Count > 0,
            "the schedule is stored and the worker registers",
            token);
    }

    [Fact]
    public async Task ThePoliciesAndTheMailTaskReachTheDatabase()
    {
        var token = TestContext.Current.CancellationToken;
        await using var db = await ExampleDatabase.CreateIsolatedAsync(scratch);
        var messageId = $"csharp-{Guid.NewGuid()}";
        await FlowControlExample.ConfigureAsync(db.Queue, messageId, "acme");

        var mail = Assert.Single(await db.Queue.ListConcurrencyPoliciesAsync(["mail"], token));
        Assert.Equal("workers", mail.Namespace);
        Assert.Equal(20, mail.MaxActive);
        Assert.Equal(2, mail.MaxActivePerKey);
        var provider = Assert.Single(await db.Queue.ListRateLimitPoliciesAsync(["provider-api"], token));
        Assert.Equal(new RateLimit { Limit = 100, Interval = TimeSpan.FromSeconds(1), Burst = 200 }, provider.Rate);

        var task = await db.TaskAsync("mail.send", "messageId", messageId);
        Assert.Equal("mail", task.Queue);
        Assert.Equal("tenant:acme", task.ConcurrencyKey);
    }

    [Fact]
    public async Task TheConfirmationWaitsForTheReservation()
    {
        var orderId = $"csharp-{Guid.NewGuid()}";
        await DependenciesExample.ConfirmAsync(_shared.Queue, orderId);
        var inventory = Assert.Single(await _shared.TasksAsync("inventory.reserve", "orderId", orderId));
        var confirm = await _shared.TaskAsync("order.confirm", "orderId", orderId);
        Assert.Equal([inventory], confirm.PrerequisiteTaskIds);
        Assert.Equal(TaskState.Blocked, confirm.State);
    }

    [Fact(Timeout = 120_000)]
    public async Task TheFulfillmentReturnsTheReceiptOfItsChild()
    {
        var token = TestContext.Current.CancellationToken;
        await using var db = await ExampleDatabase.CreateIsolatedAsync(scratch);
        var orderId = $"csharp-{Guid.NewGuid()}";
        var taskId = (await db.Queue.EnqueueAsync("order.fulfill", new { id = orderId }, token)).TaskId;
        await using (var worker = new Worker(db.DataSource, new WorkerOptions { Queues = ["default", "payments"] }))
        {
            worker.Handle(
                "payment.capture",
                (HandlerContext _, DependenciesExample.Capture capture) => Task.FromResult(new { captured = capture.OrderId }));
            DependenciesExample.RegisterFulfillment(worker);
            await LandingSupport.RunUntilAsync(worker, db, taskId, TaskState.Succeeded, token);
        }

        AssertJson($$$"""{"receipt": {"captured": "{{{orderId}}}"}}""", (await db.DetailAsync(taskId)).Result);
    }

    [Fact]
    public async Task TheSecondReindexReplacesTheFirst()
    {
        var documentId = $"csharp-{Guid.NewGuid()}";
        var lines = await LandingSupport.StandardOutputAsync(
            () => CoalescingExample.ReindexAsync(_shared.Queue, documentId, TimeSpan.FromMinutes(5)));
        Assert.Contains("Accepted Replaced", lines);
        var task = await _shared.TaskAsync("search.reindex", "documentId", documentId);
        AssertJson($$"""{"documentId": "{{documentId}}", "revision": 2}""", task.Payload);
    }

    [Fact(Timeout = 120_000)]
    public async Task TheReleasePublishesAfterTheScanAndTheApproval()
    {
        var token = TestContext.Current.CancellationToken;
        await using var db = await ExampleDatabase.CreateIsolatedAsync(scratch);
        var taskId = (await db.Queue.EnqueueAsync("release.publish", new { id = "release-csharp" }, token)).TaskId;
        await using (var worker = new Worker(db.DataSource, new WorkerOptions()))
        {
            ExternalWaitsExample.RegisterRelease(worker);
            await LandingSupport.RunUntilAsync(
                async stoppingToken =>
                {
                    var running = worker.RunAsync(stoppingToken);
                    await ExampleDatabase.EventuallyAsync(
                        async () => (await db.Admin.ListSignalWaitsAsync(new SignalWaitQuery(), token)).Items.Any(wait => wait.TaskId == taskId),
                        "the release waits for the scan");
                    await ExternalWaitsExample.DeliverScanAsync(db.Queue, taskId, new { clean = true }, "scan-delivery-csharp");
                    await ExampleDatabase.EventuallyAsync(
                        async () => (await db.Admin.ListHumanWaitsAsync(new HumanWaitQuery(), token)).Items.Any(wait => wait.TaskId == taskId),
                        "the release waits for the approval");
                    var waits = await db.Admin.ListHumanWaitsAsync(new HumanWaitQuery(), token);
                    AssertJson(
                        """{"releaseId": "release-csharp", "scan": {"clean": true}}""",
                        waits.Items.Single(wait => wait.TaskId == taskId).Context);
                    await db.Queue.CompleteHumanWaitAsync(
                        taskId, "release-approval", new { approved = true }, "approval-csharp", "dana", token);
                    await running;
                },
                async () => (await db.DetailAsync(taskId)).State == TaskState.Succeeded,
                "the release is published",
                token);
        }

        AssertJson("""{"published": true}""", (await db.DetailAsync(taskId)).Result);
    }

    [Fact(Timeout = 120_000)]
    public async Task TheBatchHandlerReturnsEachPayload()
    {
        var token = TestContext.Current.CancellationToken;
        await using var db = await ExampleDatabase.CreateIsolatedAsync(scratch);
        var first = (await db.Queue.EnqueueAsync("email.send", new { to = "ada@example.com" }, token)).TaskId;
        var second = (await db.Queue.EnqueueAsync("email.send", new { to = "grace@example.com" }, token)).TaskId;
        await using (var worker = new Worker(db.DataSource, new WorkerOptions { Concurrency = 10 }))
        {
            BatchHandlersExample.RegisterEmailBatch(worker, 10, TimeSpan.FromMilliseconds(100));
            await LandingSupport.RunUntilAsync(
                worker,
                async () => (await db.DetailAsync(first)).State == TaskState.Succeeded
                    && (await db.DetailAsync(second)).State == TaskState.Succeeded,
                "both emails are sent",
                token);
        }

        AssertJson("""{"to": "ada@example.com"}""", (await db.DetailAsync(first)).Result);
        AssertJson("""{"to": "grace@example.com"}""", (await db.DetailAsync(second)).Result);
    }

    [Fact(Timeout = 120_000)]
    public async Task TheExportIsCanceledAndAnotherExportRuns()
    {
        var token = TestContext.Current.CancellationToken;
        await using var db = await ExampleDatabase.CreateIsolatedAsync(scratch);
        var canceled = (await db.Queue.EnqueueAsync("rows.export", CanceledRows, token)).TaskId;
        await using var worker = new Worker(db.DataSource, new WorkerOptions());
        await CancellationExample.ConfigureExportAsync(db.Queue, worker, canceled);
        Assert.Equal(TaskState.Canceled, (await db.DetailAsync(canceled)).State);

        var exported = (await db.Queue.EnqueueAsync("rows.export", ExportedRows, token)).TaskId;
        await LandingSupport.RunUntilAsync(worker, db, exported, TaskState.Succeeded, token);
        AssertJson("""{"stopped": false}""", (await db.DetailAsync(exported)).Result);
    }

    [Fact(Timeout = 120_000)]
    public async Task TheDeclinedChargeIsRedriven()
    {
        var token = TestContext.Current.CancellationToken;
        await using var db = await ExampleDatabase.CreateIsolatedAsync(scratch);
        var taskId = (await db.Queue.EnqueueAsync(
            "charge.capture",
            new { chargeId = "csharp" },
            new EnqueueOptions { Queue = "billing", MaxAttempts = 1 },
            token)).TaskId;
        await using (var worker = new Worker(db.DataSource, new WorkerOptions { Queues = ["billing"] }))
        {
            worker.Handle("charge.capture", (HandlerContext _, JsonElement _) => throw new CardDeclined());
            await LandingSupport.RunUntilAsync(worker, db, taskId, TaskState.Failed, token);
        }

        await DeadLettersExample.RedriveBillingAsync(db.Admin);
        var letters = await db.Admin.ListDeadLettersAsync(new DeadLetterQuery { Queue = "billing" }, token);
        Assert.Equal(1, letters.Items.Single(item => item.TaskId == taskId).RedriveCount);
    }

    [Fact(Timeout = 120_000)]
    public async Task TheDashboardAnswersOnlyAnAdministrator()
    {
        var token = TestContext.Current.CancellationToken;
        var builder = WebApplication.CreateSlimBuilder();
        builder.WebHost.UseKestrel().UseUrls("http://127.0.0.1:0");
        builder.Logging.ClearProviders();
        await using var app = builder.Build();
        // A stand-in for the application's authentication: the test names the user and the role.
        app.Use((context, next) =>
        {
            if (context.Request.Headers.TryGetValue("X-Test-User", out var user))
            {
                Claim[] claims = [new(ClaimTypes.Name, user.ToString()), new(ClaimTypes.Role, context.Request.Headers["X-Test-Role"].ToString())];
                context.User = new ClaimsPrincipal(new ClaimsIdentity(claims, "test"));
            }

            return next(context);
        });
        app.UseRouting();
        OperateDashboardExample.Mount(app, _shared.DataSource);
        app.MapFallback(() => "application");
        await app.StartAsync(token);
        var address = app.Services.GetRequiredService<IServer>().Features.Get<IServerAddressesFeature>()!.Addresses.First();
        using var client = new HttpClient(new SocketsHttpHandler { AllowAutoRedirect = false }) { BaseAddress = new Uri(address) };

        Assert.Equal(401, await StatusAsync(client, "/workhorse", null, null, token));
        Assert.Equal(401, await StatusAsync(client, "/workhorse", "dana", "viewer", token));
        Assert.Equal(302, await StatusAsync(client, "/workhorse", "dana", "admin", token));
        Assert.Equal(200, await StatusAsync(client, "/other", null, null, token));
        await app.StopAsync(token);
    }

    [Fact]
    public async Task TheHealthCheckPrintsTheNumberOfLiveTasks()
    {
        var token = TestContext.Current.CancellationToken;
        await _shared.Queue.EnqueueAsync(
            "report.build",
            new { reportId = "csharp" },
            new EnqueueOptions { RunAt = DateTimeOffset.UtcNow.AddDays(1) },
            token);
        var lines = await LandingSupport.StandardOutputAsync(() => OperateHealthExample.InspectAsync(_shared.DataSource));
        Assert.True(int.Parse(lines[^1], CultureInfo.InvariantCulture) >= 1, string.Join('\n', lines));

        var services = new ServiceCollection();
        services.AddLogging();
        services.AddSingleton(_shared.DataSource);
        services.AddWorkhorse(new ConfigurationBuilder().Build());
        OperateHealthExample.AddHealthCheck(services);
        await using var provider = services.BuildServiceProvider();
        var report = await provider.GetRequiredService<HealthCheckService>().CheckHealthAsync(token);
        Assert.Equal(HealthStatus.Healthy, report.Entries["workhorse"].Status);
    }

    [Fact(Timeout = 120_000)]
    public async Task TheBillingWorkerIsPaused()
    {
        var token = TestContext.Current.CancellationToken;
        await using var db = await ExampleDatabase.CreateIsolatedAsync(scratch);
        await using var worker = new Worker(db.DataSource, new WorkerOptions { Queues = ["billing"], WorkerId = "billing-csharp" });
        await LandingSupport.RunUntilAsync(
            async stoppingToken =>
            {
                var running = worker.RunAsync(stoppingToken);
                await ExampleDatabase.EventuallyAsync(
                    async () => (await db.Admin.ListWorkersAsync(token)).Any(entry => entry.WorkerId == "billing-csharp"),
                    "the billing worker registers");
                await OperateFleetExample.PauseBillingAsync(db.DataSource);
                await running;
            },
            async () => (await db.Admin.ListWorkersAsync(token)).Any(entry => entry.WorkerId == "billing-csharp" && entry.Paused),
            "the billing worker is paused",
            token);
    }

    [Fact(Timeout = 120_000)]
    public async Task TheDeployedWorkerSendsTheEmail()
    {
        var token = TestContext.Current.CancellationToken;
        await using var db = await ExampleDatabase.CreateIsolatedAsync(scratch);
        var database = await db.ScalarAsync<string>("SELECT current_database()");
        string? connectionString = null;
        await using (scratch.CreateDataSource(builder =>
        {
            builder.Database = database;
            connectionString = builder.ConnectionString;
        }))
        {
        }

        var to = "deploy-csharp@example.com";
        var taskId = (await db.Queue.EnqueueAsync("email.send", new { to }, new EnqueueOptions { Queue = "email" }, token)).TaskId;
        await LandingSupport.RunUntilAsync(
            stoppingToken => DeployExample.RunAsync([$"--ConnectionStrings:Workhorse={connectionString}"], stoppingToken),
            async () => (await db.DetailAsync(taskId)).State == TaskState.Succeeded,
            "the deployed worker sends the email",
            token);
        AssertJson($$"""{"sent": "{{to}}"}""", (await db.DetailAsync(taskId)).Result);
    }

    private static async Task<int> StatusAsync(HttpClient client, string path, string? user, string? role, CancellationToken token)
    {
        using var request = new HttpRequestMessage(HttpMethod.Get, path);
        if (user is not null)
        {
            request.Headers.Add("X-Test-User", user);
            request.Headers.Add("X-Test-Role", role);
        }

        using var response = await client.SendAsync(request, token);
        return (int)response.StatusCode;
    }

    private static void AssertJson(string expected, JsonElement? actual)
    {
        Assert.NotNull(actual);
        using var document = JsonDocument.Parse(expected);
        Assert.True(JsonElement.DeepEquals(document.RootElement, actual.Value), $"expected {expected}, got {actual.Value.GetRawText()}");
    }
}

/// <summary>The error of the declined card in the dead letter snippet. Workhorse records its type name.</summary>
#pragma warning disable CA1710 // The snippet filters on the error name CardDeclined.
public sealed class CardDeclined : Exception
#pragma warning restore CA1710
{
    public CardDeclined()
        : base("card declined")
    {
    }

    public CardDeclined(string message)
        : base(message)
    {
    }

    public CardDeclined(string message, Exception innerException)
        : base(message, innerException)
    {
    }
}
