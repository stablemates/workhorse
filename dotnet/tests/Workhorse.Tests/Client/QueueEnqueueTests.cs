using System.Text.Json;
using System.Text.Json.Nodes;
using System.Transactions;
using Npgsql;
using Workhorse.Internal;
using Workhorse.Internal.Database;
using Workhorse.Tests.Testing;
using static Workhorse.Tests.Client.QueueTesting;

namespace Workhorse.Tests.Client;

/// <summary>The enqueue rows of the client table of <c>docs/parity.md</c>.</summary>
public sealed class QueueEnqueueTests(ScratchDatabase database) : IClassFixture<ScratchDatabase>
{
    private sealed record Order(int OrderId, string Note);

    [Fact]
    public async Task EnqueuesATaskWithTheDefaults()
    {
        var queueName = UniqueName("enqueue");
        var queue = new Queue(database.DataSource, new QueueOptions { DefaultQueue = queueName });
        var result = await queue.EnqueueAsync("orders.ship", new Order(7, "café"), Token);
        Assert.Equal(EnqueueOutcome.Accepted, result.Outcome);
        Assert.Null(result.Reason);

        var row = (await TaskAsync(database, result.TaskId))!;
        Assert.Equal(queueName, row.Text("queue_name"));
        Assert.Equal("orders.ship", row.Text("task_type"));
        Assert.Equal("""{"note": "café", "orderId": 7}""", row.Text("payload"));
        Assert.Equal(0, row.Integer("priority"));
        Assert.Equal(25, row.Integer("max_attempts"));
        Assert.Equal("ready", row.Text("state"));
    }

    [Fact]
    public async Task EnqueuesInsideACallerTransactionAndRollsBackWithIt()
    {
        var queueName = UniqueName("caller");
        var queue = new Queue(database.DataSource, new QueueOptions { DefaultQueue = queueName });
        await using var connection = await database.DataSource.OpenConnectionAsync(Token);

        await using (var transaction = await connection.BeginTransactionAsync(Token))
        {
            var rolledBack = await queue.Using(connection).EnqueueAsync("orders.ship", new Order(1, "a"), Token);
            await using (var visible = new NpgsqlCommand("SELECT count(*) FROM workhorse.task WHERE id = $1", connection))
            {
                visible.Parameters.Add(new NpgsqlParameter { Value = rolledBack.TaskId });
                Assert.Equal(1L, await visible.ExecuteScalarAsync(Token));
            }

            await transaction.RollbackAsync(Token);
            Assert.Null(await TaskAsync(database, rolledBack.TaskId));
        }

        Assert.Equal(0, await CountAsync(database, queueName));

        await using (var transaction = await connection.BeginTransactionAsync(Token))
        {
            var committed = await queue.Using(connection).EnqueueAsync("orders.ship", new Order(2, "b"), Token);
            Assert.Null(await TaskAsync(database, committed.TaskId));
            await transaction.CommitAsync(Token);
            Assert.NotNull(await TaskAsync(database, committed.TaskId));
        }
    }

    [Fact]
    public async Task TheCallerFormNeedsAnOpenConnection()
    {
        var queue = new Queue(database.DataSource);
        await using var connection = database.DataSource.CreateConnection();
        await Assert.ThrowsAsync<InvalidOperationException>(() => queue.Using(connection).EnqueueAsync("t", 1, Token));
    }

    [Fact]
    public async Task TheSourceFormIgnoresAnAmbientTransactionScope()
    {
        var queueName = UniqueName("scope");
        var queue = new Queue(database.DataSource, new QueueOptions { DefaultQueue = queueName });
        EnqueueResult result;
        using (new TransactionScope(TransactionScopeAsyncFlowOption.Enabled))
        {
            result = await queue.EnqueueAsync("t", 1, Token);

            // The scope ends without Complete. An enlisted enqueue would roll back.
        }

        Assert.NotNull(await TaskAsync(database, result.TaskId));
    }

    [Fact]
    public async Task EnqueuesAnAtomicBatchInRequestOrder()
    {
        var queueName = UniqueName("batch");
        var queue = new Queue(database.DataSource, new QueueOptions { DefaultQueue = queueName });
        var results = await queue.EnqueueManyAsync(
        [
            new EnqueueRequest { TaskType = "first", Payload = 1 },
            new EnqueueRequest { TaskType = "second", Payload = new JsonObject { ["n"] = 2 }, Options = new EnqueueOptions { Priority = 9 } },
        ], Token);
        Assert.Equal(2, results.Count);
        Assert.Equal("first", (await TaskAsync(database, results[0].TaskId))!.Text("task_type"));
        Assert.Equal(9, (await TaskAsync(database, results[1].TaskId))!.Integer("priority"));
        Assert.Empty(await queue.EnqueueManyAsync([], Token));

        // A request that PostgreSQL refuses enqueues nothing of the batch. A fast-tier queue
        // refuses dependencies with P1007 (ADR 0077).
        var fast = UniqueName("fast");
        await using (var tier = database.DataSource.CreateCommand(SqlCatalogue.SetQueueTierV1.Sql))
        {
            tier.Parameters.AddRange(new[] { Parameters.Text(fast), Parameters.Text("fast"), Parameters.Text("test"), Parameters.Text("test") });
            await tier.ExecuteNonQueryAsync(Token);
        }

        var dependencies = new Dependencies
        {
            PrerequisiteTaskIds = [results[0].TaskId],
            OnSuccess = DependencyPolicy.Release,
            OnFailure = DependencyPolicy.Cancel,
            OnCancellation = DependencyPolicy.Cancel,
        };
        var error = await Assert.ThrowsAsync<FastTierUnsupportedException>(() => queue.EnqueueManyAsync(
        [
            new EnqueueRequest { TaskType = "third", Payload = 3 },
            new EnqueueRequest { TaskType = "fourth", Payload = 4, Options = new EnqueueOptions { Queue = fast, Dependencies = dependencies } },
        ], Token));
        Assert.Equal(fast, error.Queue);
        Assert.Equal("dependencies", error.Feature);
        Assert.Equal(2, error.Ordinal);
        Assert.Equal(2, await CountAsync(database, queueName));
        Assert.Equal(0, await CountAsync(database, fast));
    }

    [Fact]
    public async Task RefusesABatchAboveTheSharedLimit()
    {
        var queue = new Queue(database.DataSource);
        var requests = Enumerable.Range(0, 1001).Select(index => new EnqueueRequest { TaskType = "t", Payload = index });
        await Assert.ThrowsAsync<ArgumentException>(() => queue.EnqueueManyAsync(requests, Token));
    }

    [Fact]
    public async Task StoresDelayPriorityTagsAttemptsPolicyDeadlineTimeoutAndConcurrencyKey()
    {
        var queueName = UniqueName("options");
        var queue = new Queue(database.DataSource);
        var runAt = DateTimeOffset.UtcNow.AddHours(1).ToOffset(TimeSpan.FromHours(-5));
        var deadline = DateTimeOffset.UtcNow.AddDays(1);
        var result = await queue.EnqueueAsync("t", "x", new EnqueueOptions
        {
            Queue = queueName,
            RunAt = runAt,
            Priority = 42,
            Tags = ["a", "b"],
            MaxAttempts = 3,
            RetryPolicy = RetryPolicy.Exponential(TimeSpan.FromSeconds(1), 2, TimeSpan.FromMinutes(1)),
            Deadline = deadline,
            ExecutionTimeout = TimeSpan.FromSeconds(30),
            ConcurrencyKey = "customer-1",
        }, Token);

        var row = (await TaskAsync(database, result.TaskId))!;
        Assert.True(row.RequiredInstant("run_at") > DateTimeOffset.UtcNow.AddMinutes(30));
        Assert.Equal(runAt.ToUnixTimeMilliseconds(), row.RequiredInstant("run_at").ToUnixTimeMilliseconds());
        Assert.Equal(deadline.ToUnixTimeMilliseconds(), row.RequiredInstant("deadline_at").ToUnixTimeMilliseconds());
        Assert.Equal(42, row.Integer("priority"));
        Assert.Equal(["a", "b"], row.TextList("tags")!);
        Assert.Equal(3, row.Integer("max_attempts"));
        Assert.Equal(30_000, row.Long("execution_timeout_ms"));
        Assert.Equal("customer-1", row.Text("concurrency_key"));
        using var policy = JsonDocument.Parse(row.RequiredText("retry_policy"));
        Assert.Equal("exponential", policy.RootElement.GetProperty("type").GetString());
        Assert.Equal(1000, policy.RootElement.GetProperty("initialDelayMs").GetInt64());
        Assert.Equal(60_000, policy.RootElement.GetProperty("maxDelayMs").GetInt64());
    }

    [Fact]
    public async Task StoresNoExecutionTimeoutForAnOmittedOrZeroValue()
    {
        var queueName = UniqueName("timeout");
        var queue = new Queue(database.DataSource, new QueueOptions { DefaultQueue = queueName });
        async Task<long?> Stored(TimeSpan? timeout)
        {
            var result = await queue.EnqueueAsync("t", 1, new EnqueueOptions { ExecutionTimeout = timeout }, Token);
            return (await TaskAsync(database, result.TaskId))!.Long("execution_timeout_ms");
        }

        Assert.Null(await Stored(null));
        Assert.Null(await Stored(TimeSpan.Zero));
        Assert.Equal(1, await Stored(TimeSpan.FromMilliseconds(1)));
        Assert.Equal(1, await Stored(TimeSpan.FromTicks(5_000)));
        Assert.Equal(31_536_000_000, await Stored(TimeSpan.FromMilliseconds(31_536_000_000)));
        foreach (var refused in new[] { TimeSpan.FromTicks(4_000), TimeSpan.FromTicks(1), TimeSpan.FromTicks(-4_000), TimeSpan.FromMilliseconds(31_536_000_001) })
        {
            var error = await Assert.ThrowsAsync<ArgumentException>(() => queue.EnqueueAsync("t", 1, new EnqueueOptions { ExecutionTimeout = refused }, Token));
            Assert.Equal("enqueue request 1: execution timeout must be a TimeSpan between 0.001 and 31536000 seconds", error.Message);
        }

        Assert.Equal(5, await CountAsync(database, queueName));
    }

    [Fact]
    public async Task ReplaysAnIdempotentEnqueueAndRefusesADifferentRequest()
    {
        var queue = new Queue(database.DataSource, new QueueOptions { DefaultQueue = UniqueName("idempotency") });
        var options = new EnqueueOptions { Idempotency = new Idempotency { Key = UniqueName("key") } };
        var first = await queue.EnqueueAsync("t", 1, options, Token);
        var replay = await queue.EnqueueAsync("t", 1, options, Token);
        Assert.Equal(EnqueueOutcome.Accepted, first.Outcome);
        Assert.Equal(EnqueueOutcome.Replayed, replay.Outcome);
        Assert.Equal(first.TaskId, replay.TaskId);
        await Assert.ThrowsAsync<EnqueueIdempotencyConflictException>(() => queue.EnqueueAsync("t", 2, options, Token));
    }

    [Fact]
    public async Task DebouncesAndThrottlesByKey()
    {
        var queue = new Queue(database.DataSource, new QueueOptions { DefaultQueue = UniqueName("coalesce") });
        var debounce = new EnqueueOptions { Debounce = new Debounce { Key = UniqueName("debounce"), Window = TimeSpan.FromMinutes(5) } };
        var first = await queue.EnqueueAsync("t", 1, debounce, Token);
        var second = await queue.EnqueueAsync("t", 2, debounce, Token);
        Assert.Equal(EnqueueOutcome.Replaced, second.Outcome);
        Assert.Equal(first.TaskId, second.TaskId);

        var throttle = new EnqueueOptions { Throttle = new Throttle { Key = UniqueName("throttle"), Window = TimeSpan.FromMinutes(5) } };
        var kept = await queue.EnqueueAsync("t", 1, throttle, Token);
        var joined = await queue.EnqueueAsync("t", 1, throttle, Token);
        Assert.Equal(EnqueueOutcome.Coalesced, joined.Outcome);
        Assert.Equal(kept.TaskId, joined.TaskId);
    }

    [Fact]
    public async Task BlocksATaskOnItsPrerequisites()
    {
        var queue = new Queue(database.DataSource, new QueueOptions { DefaultQueue = UniqueName("dependencies") });
        var prerequisite = await queue.EnqueueAsync("t", 1, Token);
        var dependent = await queue.EnqueueAsync("t", 2, new EnqueueOptions
        {
            Dependencies = new Dependencies
            {
                PrerequisiteTaskIds = [prerequisite.TaskId],
                OnSuccess = DependencyPolicy.Release,
                OnFailure = DependencyPolicy.Cancel,
                OnCancellation = DependencyPolicy.Fail,
            },
        }, Token);
        Assert.Equal("blocked", (await TaskAsync(database, dependent.TaskId))!.Text("state"));

        // PostgreSQL stores the prerequisite and each policy, so a wrong policy fails here.
        var stored = await Workhorse.Tests.Testing.WorkerHarness.TaskAsync(database.DataSource, dependent.TaskId);
        Assert.Equal(prerequisite.TaskId, stored.Uuid("prerequisite_task_id"));
        Assert.Equal("release", stored.Text("dependency_on_success"));
        Assert.Equal("cancel", stored.Text("dependency_on_failure"));
        Assert.Equal("fail", stored.Text("dependency_on_cancellation"));
    }

    [Theory]
    [InlineData("priority")]
    [InlineData("tags")]
    [InlineData("keys")]
    [InlineData("debounce-run-at")]
    [InlineData("dependencies")]
    [InlineData("retry")]
    [InlineData("payload")]
    public async Task RefusesInvalidOptionsBeforeAnyStatement(string invalid)
    {
        // The data source points at no server, so a statement would fail with a database error.
        await using var unreachable = NpgsqlDataSource.Create("Host=127.0.0.1;Port=1;Timeout=1");
        var queue = new Queue(unreachable);
        var options = invalid switch
        {
            "priority" => new EnqueueOptions { Priority = 101 },
            "tags" => new EnqueueOptions { Tags = [new string('x', 101)] },
            "keys" => new EnqueueOptions { Idempotency = new Idempotency { Key = "a" }, Throttle = new Throttle { Key = "b", Window = TimeSpan.FromSeconds(1) } },
            "debounce-run-at" => new EnqueueOptions { RunAt = DateTimeOffset.UtcNow, Debounce = new Debounce { Key = "a", Window = TimeSpan.FromSeconds(1) } },
            "dependencies" => new EnqueueOptions { Dependencies = new Dependencies { PrerequisiteTaskIds = [], OnSuccess = DependencyPolicy.Release, OnFailure = DependencyPolicy.Cancel, OnCancellation = DependencyPolicy.Cancel } },
            "retry" => new EnqueueOptions { RetryPolicy = RetryPolicy.Exponential(TimeSpan.FromSeconds(10), 2, TimeSpan.FromSeconds(1)) },
            _ => new EnqueueOptions(),
        };
        object? payload = invalid == "payload" ? double.NaN : 1;
        await Assert.ThrowsAsync<ArgumentException>(() => queue.EnqueueAsync("t", payload, options, Token));
    }

    [Fact]
    public async Task AnUndefinedEnumMemberLeavesTheCallerTransactionUsable()
    {
        var queueName = UniqueName("undefined");
        var queue = new Queue(database.DataSource, new QueueOptions { DefaultQueue = queueName });
        await using var connection = await database.DataSource.OpenConnectionAsync(Token);
        await using var transaction = await connection.BeginTransactionAsync(Token);
        await Assert.ThrowsAsync<ArgumentException>(() => queue.Using(connection).EnqueueAsync("t", 1, new EnqueueOptions
        {
            Debounce = new Debounce { Key = "k", Window = TimeSpan.FromSeconds(1), Schedule = (DebounceSchedule)99 },
        }, Token));
        await queue.Using(connection).EnqueueAsync("t", 2, Token);
        await transaction.CommitAsync(Token);
        Assert.Equal(1, await CountAsync(database, queueName));
    }

    [Fact]
    public async Task RefusesALoneSurrogateInThePayload()
    {
        var queue = new Queue(database.DataSource);
        await Assert.ThrowsAsync<ArgumentException>(() => queue.EnqueueAsync("t", new Order(1, "\uD800"), Token));
    }

    [Fact]
    public void RefusesAMultiplexingDataSource()
    {
        using var dataSource = NpgsqlDataSource.Create("Host=localhost;Multiplexing=true");
        Assert.Throws<ArgumentException>(() => new Queue(dataSource));
    }

    [Fact]
    public async Task ACancelledTokenThrowsOperationCanceledException()
    {
        var queue = new Queue(database.DataSource);
        using var cancelled = new CancellationTokenSource();
        await cancelled.CancelAsync();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => queue.EnqueueAsync("t", 1, cancelled.Token));
    }
}
