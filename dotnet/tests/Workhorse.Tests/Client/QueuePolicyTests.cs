using Workhorse.Tests.Testing;
using static Workhorse.Tests.Client.QueueTesting;

namespace Workhorse.Tests.Client;

/// <summary>Concurrency policies, rate limit policies, budgets, and schedules.</summary>
public sealed class QueuePolicyTests(ScratchDatabase database)
{
    [Fact]
    public async Task SyncsAndListsConcurrencyPolicies()
    {
        var queue = new Queue(database.DataSource);
        var name = UniqueName("concurrency");
        var stored = await queue.SyncConcurrencyPoliciesAsync(UniqueName("ns"), [new ConcurrencyPolicyDefinition { Queue = name, MaxActive = 5, MaxActivePerKey = 2 }], Token);
        var policy = Assert.Single(stored);
        Assert.Equal(5, policy.MaxActive);
        Assert.Equal(2, policy.MaxActivePerKey);
        Assert.Equal(TimeSpan.Zero, policy.UpdatedAt.Offset);
        Assert.Equal(name, Assert.Single(await queue.ListConcurrencyPoliciesAsync([name], Token)).Queue);
        Assert.Contains(await queue.ListConcurrencyPoliciesAsync(Token), item => item.Queue == name);
    }

    [Fact]
    public async Task SyncsAndListsRateLimitPolicies()
    {
        var queue = new Queue(database.DataSource);
        var name = UniqueName("rate");
        var rate = new RateLimit { Limit = 10, Interval = TimeSpan.FromSeconds(1), Burst = 20 };
        await queue.SyncRateLimitPoliciesAsync(UniqueName("ns"), [new RateLimitPolicyDefinition { Queue = name, Rate = rate }], Token);
        var policy = Assert.Single(await queue.ListRateLimitPoliciesAsync([name], Token));
        Assert.Equal(rate, policy.Rate);
        Assert.Null(policy.PerKey);
    }

    [Fact]
    public async Task SyncsAndListsBudgetsAndATaskNamesOne()
    {
        var queue = new Queue(database.DataSource, new QueueOptions { DefaultQueue = UniqueName("budget") });
        var name = UniqueName("budget");
        await queue.SyncBudgetsAsync(UniqueName("ns"), [new BudgetDefinition { Name = name, MaxActive = 3 }], Token);
        var budget = Assert.Single(await queue.ListBudgetsAsync([name], Token));
        Assert.Equal(3, budget.MaxActive);
        Assert.Null(budget.Rate);

        var task = await queue.EnqueueAsync("t", 1, new EnqueueOptions { Budget = name }, Token);
        Assert.Equal(name, (await TaskAsync(database, task.TaskId))!.Text("budget_name"));
    }

    [Fact]
    public async Task RefusesInvalidDefinitionsBeforeAnyStatement()
    {
        var queue = new Queue(database.DataSource);
        await Assert.ThrowsAsync<ArgumentException>(() => queue.SyncConcurrencyPoliciesAsync("ns", [new ConcurrencyPolicyDefinition { Queue = "q", MaxActive = 0 }], Token));
        await Assert.ThrowsAsync<ArgumentException>(() => queue.SyncConcurrencyPoliciesAsync(
            "ns", [new ConcurrencyPolicyDefinition { Queue = "q", MaxActive = 1 }, new ConcurrencyPolicyDefinition { Queue = "q", MaxActive = 2 }], Token));
        await Assert.ThrowsAsync<ArgumentException>(() => queue.SyncBudgetsAsync("ns", [new BudgetDefinition { Name = "b" }], Token));
        await Assert.ThrowsAsync<ArgumentException>(() => queue.SyncRateLimitPoliciesAsync(
            "ns", [new RateLimitPolicyDefinition { Queue = "q", Rate = new RateLimit { Limit = 1, Interval = TimeSpan.FromDays(2), Burst = 1 } }], Token));
    }

    [Fact]
    public async Task SyncsSchedules()
    {
        var queue = new Queue(database.DataSource);
        var ns = UniqueName("schedules");
        await queue.SyncSchedulesAsync(ns,
        [
            new ScheduleDefinition
            {
                Name = "nightly",
                Schedule = "0 3 * * *",
                Task = new ScheduledTask { TaskType = "report", Payload = new { scope = "all" }, Priority = 4 },
                Timezone = "Europe/Berlin",
                CatchupPolicy = CatchupPolicy.Latest,
            },
        ], Token);
        Assert.Equal(1L, await ScalarAsync<long>(database, "SELECT count(*) FROM workhorse.schedule_definition WHERE namespace = $1 AND schedule_name = 'nightly'", new Npgsql.NpgsqlParameter { Value = ns }));
        // Prune disables the other schedules of the namespace.
        await queue.SyncSchedulesAsync(ns, [], Token);
        Assert.Equal(0L, await ScalarAsync<long>(database, "SELECT count(*) FROM workhorse.schedule_definition WHERE namespace = $1 AND configured_enabled", new Npgsql.NpgsqlParameter { Value = ns }));
    }
}
