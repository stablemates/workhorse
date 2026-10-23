using Workhorse.Examples.Enqueue;
using Workhorse.Examples.Tests.Testing;
using Workhorse.Tests.Testing;

namespace Workhorse.Examples.Tests.Enqueue;

/// <summary>
/// Runs the C# snippets that synchronize schedules, payload contracts, policies, and budgets. Each
/// test has its own database, because a synchronization replaces every definition of its namespace
/// and a contract applies to every enqueue of its task type.
/// </summary>
public sealed class PolicyExamplesTests(ScratchDatabase scratch)
{
    private static CancellationToken Token => TestContext.Current.CancellationToken;

    [Fact]
    public async Task TheScheduleSynchronizationStoresTheDefinition()
    {
        await using var db = await ExampleDatabase.CreateIsolatedAsync(scratch);
        await new SchedulesExamples(db.Queue, db.DataSource).SyncSchedulesAsync("0 2 * * *");

        Assert.Equal(
            "0 2 * * *|America/New_York|billing|invoice.generate|due|t|skip",
            await db.ScalarAsync<string>(
                "SELECT concat_ws('|', cron_expression, timezone, queue_name, task_type, payload ->> 'scope', configured_enabled, catchup_policy) FROM workhorse.schedule_definition WHERE namespace = 'billing-production' AND schedule_name = 'invoice-run'"));
    }

    [Fact(Timeout = 120_000)]
    public async Task TheWorkerThatOffersTheNamespaceFiresItsSchedule()
    {
        var token = TestContext.Current.CancellationToken;
        // The snippet's worker reads the default queue, so the test has its own database.
        await using var db = await ExampleDatabase.CreateIsolatedAsync(scratch);
        var scope = $"csharp-{Guid.NewGuid()}";
        // Each second is an occurrence, so the worker fires one at its next maintenance pass.
        await db.Queue.SyncSchedulesAsync(
            "billing-production",
            [
                new ScheduleDefinition
                {
                    Name = "invoice-run",
                    Schedule = "* * * * * *",
                    Task = new ScheduledTask { TaskType = "invoice.generate", Payload = new { scope }, Queue = "billing" },
                },
            ],
            token);

        await using var worker = new SchedulesExamples(db.Queue, db.DataSource).ScheduleWorker();
        using var stop = CancellationTokenSource.CreateLinkedTokenSource(token);
        var run = worker.RunAsync(stop.Token);
        try
        {
            await ExampleDatabase.EventuallyAsync(
                async () => (await db.TasksAsync("invoice.generate", "scope", scope)).Count > 0,
                "the schedule fires");
            var taskId = (await db.TasksAsync("invoice.generate", "scope", scope))[0];
            Assert.Equal("billing", (await db.DetailAsync(taskId)).Queue);
        }
        finally
        {
            await stop.CancelAsync();
            await run;
        }
    }

    [Fact]
    public async Task TheContractRejectsAPayloadWithoutTheRecipient()
    {
        await using var db = await ExampleDatabase.CreateIsolatedAsync(scratch);
        await new ContractsExamples(db.Queue).SyncContractsAsync();

        var error = await Assert.ThrowsAsync<ContractValidationException>(
            () => db.Queue.EnqueueAsync("mail.send", new { to = "ada@example.com" }, Token));
        Assert.Equal("mail.send", error.TaskType);
        Assert.Equal("mail-current", error.Version);
        Assert.Equal("payload", error.Part);
        Assert.Empty(await db.TasksAsync("mail.send", "to", "ada@example.com"));

        var accepted = await db.Queue.EnqueueAsync("mail.send", new { recipient = "ada@example.com" }, Token);
        Assert.Equal("mail-current", (await db.DetailAsync(accepted.TaskId)).ContractVersion);
    }

    [Fact]
    public async Task TheRateLimitPolicyHasItsQueueAndPerKeyRates()
    {
        await using var db = await ExampleDatabase.CreateIsolatedAsync(scratch);
        var policy = Assert.Single(await new RateLimitsExamples(db.Queue).SyncPoliciesAsync());

        Assert.Equal("provider-api", policy.Queue);
        Assert.Equal("workers", policy.Namespace);
        Assert.Equal(new RateLimit { Limit = 60, Interval = TimeSpan.FromMinutes(1), Burst = 10 }, policy.Rate);
        Assert.Equal(new RateLimit { Limit = 5, Interval = TimeSpan.FromMinutes(1), Burst = 2 }, policy.PerKey);
    }

    [Fact]
    public async Task TheConcurrencyPolicyLimitsTheQueueAndEachKey()
    {
        await using var db = await ExampleDatabase.CreateIsolatedAsync(scratch);
        var examples = new ConcurrencyPoliciesExamples(db.Queue);
        var policy = Assert.Single(await examples.SyncPoliciesAsync());
        Assert.Equal("mail", policy.Queue);
        Assert.Equal(20, policy.MaxActive);
        Assert.Equal(3, policy.MaxActivePerKey);

        var messageId = $"csharp-{Guid.NewGuid()}";
        await examples.EnqueueWithKeyAsync(messageId, "tenant-7");
        var task = await db.TaskAsync("mail.send", "messageId", messageId);
        Assert.Equal("mail", task.Queue);
        Assert.Equal("tenant-7", task.ConcurrencyKey);
    }

    [Fact]
    public async Task OneBudgetCoversTasksOnTwoQueues()
    {
        await using var db = await ExampleDatabase.CreateIsolatedAsync(scratch);
        var budget = Assert.Single(await new ConcurrencyPoliciesExamples(db.Queue).BudgetsAsync());
        Assert.Equal("vendor-api", budget.Name);
        Assert.Equal(4, budget.MaxActive);
        Assert.Null(budget.Rate);

        Assert.Equal(
            "billing,crm",
            await db.ScalarAsync<string>(
                "SELECT string_agg(queue_name, ',' ORDER BY queue_name) FROM workhorse.task WHERE budget_name = 'vendor-api'"));
    }

    [Fact]
    public async Task TheTenantOptionsReachThePolicyTheBudgetAndTheTask()
    {
        await using var db = await ExampleDatabase.CreateIsolatedAsync(scratch);
        var result = await new MultiTenancyExamples(db.Queue).TenantOptionsAsync();

        var policy = Assert.Single(await db.Queue.ListConcurrencyPoliciesAsync(Token));
        Assert.Equal(("reports", 40, (int?)4), (policy.Queue, policy.MaxActive, policy.MaxActivePerKey));
        var budget = Assert.Single(await db.Queue.ListBudgetsAsync(Token));
        Assert.Equal(("acme", (int?)8), (budget.Name, budget.MaxActive));

        var task = await db.DetailAsync(result.TaskId);
        Assert.Equal("reports", task.Queue);
        Assert.Equal("acme", task.ConcurrencyKey);
        Assert.Equal(["tenant:acme"], task.Tags);
        Assert.Equal("acme", await db.ScalarAsync<string>("SELECT budget_name FROM workhorse.task WHERE id = $1", result.TaskId));
    }
}
