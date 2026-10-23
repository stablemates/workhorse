using Workhorse.Examples.Start;
using Workhorse.Examples.Tests.Testing;
using Workhorse.Tests.Testing;

namespace Workhorse.Examples.Tests.Start;

/// <summary>Runs the C# snippets of the installation page, the quickstart, and the page for AI agents.</summary>
public sealed class StartPagesExamplesTests(ScratchDatabase scratch)
{
    [Fact]
    public async Task TheSchemaCheckAcceptsTheCurrentSchema()
    {
        await InstallationExamples.AssertCompatibleAsync(ExampleDatabase.Shared(scratch).DataSource);
    }

    [Fact]
    public async Task TheSchemaCheckRefusesADatabaseWithoutTheSchema()
    {
        await using var database = await ExampleDatabase.CreateIsolatedAsync(scratch);
        await database.ExecuteAsync("DROP SCHEMA workhorse CASCADE");
        var error = await Assert.ThrowsAsync<CompatibilityException>(
            () => InstallationExamples.AssertCompatibleAsync(database.DataSource));
        Assert.Equal(CompatibilityCode.SchemaNotInstalled, error.Code);
    }

    // The worker of the quickstart claims from `default`, so the test has its own database.
    [Fact(Timeout = 120_000)]
    public async Task TheWorkerRunsTheWelcomeTask()
    {
        await using var database = await ExampleDatabase.CreateIsolatedAsync(scratch);
        var connectionString = await StartDatabase.ConnectionStringAsync(scratch, database);
        var task = await QuickstartExamples.RunTaskAsync(connectionString).WaitAsync(TestContext.Current.CancellationToken);
        Assert.NotNull(task);
        Assert.Equal("email.welcome", task.Type);
        Assert.Equal(TaskState.Succeeded, task.State);
        Assert.Equal("ada@example.com", task.Result!.Value.GetProperty("deliveredTo").GetString());
    }

    [Fact]
    public async Task TheQuickstartOrderAndItsTaskCommitTogether()
    {
        await using var database = await ExampleDatabase.CreateIsolatedAsync(scratch);
        await database.ExecuteAsync("CREATE TABLE orders (id text PRIMARY KEY)");
        var orderId = $"csharp-{Guid.NewGuid()}";
        await QuickstartExamples.CreateOrderAsync(database.DataSource, database.Queue, orderId);
        Assert.Equal(1, await StartDatabase.OrdersAsync(database, orderId));
        Assert.Single(await database.TasksAsync("order.fulfill", "orderId", orderId));
    }

    [Fact]
    public async Task TheQuickstartOrderAndItsTaskRollBackTogether()
    {
        await using var database = await ExampleDatabase.CreateIsolatedAsync(scratch);
        await database.ExecuteAsync("CREATE TABLE orders (id text PRIMARY KEY)");
        // A trigger fails the commit after the insert and the enqueue ran in the transaction.
        await database.ExecuteAsync(
            "CREATE FUNCTION refuse_order() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'refused'; END $$");
        await database.ExecuteAsync(
            "CREATE CONSTRAINT TRIGGER refuse_order AFTER INSERT ON orders DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION refuse_order()");
        var orderId = $"csharp-{Guid.NewGuid()}";
        await Assert.ThrowsAnyAsync<Exception>(
            () => QuickstartExamples.CreateOrderAsync(database.DataSource, database.Queue, orderId));
        Assert.Equal(0, await StartDatabase.OrdersAsync(database, orderId));
        Assert.Empty(await database.TasksAsync("order.fulfill", "orderId", orderId));
    }

    // The worker of the integration claims from `default`, so the test has its own database.
    [Fact(Timeout = 120_000)]
    public async Task TheIntegrationCommitsTheOrderAndStoresTheResult()
    {
        await using var database = await ExampleDatabase.CreateIsolatedAsync(scratch);
        await database.ExecuteAsync("CREATE TABLE orders (id text PRIMARY KEY, status text NOT NULL)");
        var connectionString = await StartDatabase.ConnectionStringAsync(scratch, database);
        var task = await ForAiAgentsExamples.IntegrateAsync(connectionString).WaitAsync(TestContext.Current.CancellationToken);
        Assert.Equal(1, await StartDatabase.OrdersAsync(database, "order-42"));
        Assert.NotNull(task);
        Assert.Equal(TaskState.Succeeded, task.State);
        Assert.Equal(5, task.MaxAttempts);
        var policy = task.RetryPolicy!.Value;
        Assert.Equal("fixed", policy.GetProperty("type").GetString());
        Assert.Equal(1_000, policy.GetProperty("delayMs").GetInt64());
        var result = task.Result!.Value;
        Assert.Equal("order-42", result.GetProperty("processedOrderId").GetString());
        Assert.Equal("receipt-for-order-42", result.GetProperty("receipt").GetString());
    }
}
