using Npgsql;
using Workhorse.Tests.Testing;
using static Workhorse.Tests.Client.QueueTesting;

namespace Workhorse.Tests.Client;

/// <summary>Cancel, signals, human waits, health, and the compatibility check.</summary>
public sealed class QueueControlTests(ScratchDatabase database)
{
    [Fact]
    public async Task CancelsAReadyTask()
    {
        var queue = new Queue(database.DataSource, new QueueOptions { DefaultQueue = UniqueName("cancel") });
        var task = await queue.EnqueueAsync("t", 1, Token);
        var result = await queue.CancelAsync(task.TaskId, new CancelOptions { RequestedBy = "ops", Reason = "test" }, Token);
        Assert.Equal(CancelStatus.Canceled, result.Status);
        Assert.Equal(TaskState.Canceled, result.State);
        Assert.Equal(TimeSpan.Zero, result.FinishedAt!.Value.Offset);

        var again = await queue.CancelAsync(task.TaskId, new CancelOptions(), Token);
        Assert.Equal(TaskState.Canceled, again.State);
        Assert.Equal(CancelStatus.NotFound, (await queue.CancelAsync(Guid.NewGuid(), new CancelOptions(), Token)).Status);
    }

    [Fact]
    public async Task ASignalOrADecisionForATaskThatDoesNotWaitIsNotWaiting()
    {
        var queue = new Queue(database.DataSource, new QueueOptions { DefaultQueue = UniqueName("deliver") });
        var task = await queue.EnqueueAsync("t", 1, Token);
        var signal = await queue.SendSignalAsync(task.TaskId, "approved", new { by = "ops" }, UniqueName("key"), "ops", Token);
        Assert.Equal(SignalStatus.NotWaiting, signal.Status);
        Assert.Equal("approved", signal.Name);
        var decision = await queue.CompleteHumanWaitAsync(task.TaskId, "review", new { approved = true }, UniqueName("key"), "ops", Token);
        Assert.Equal(HumanWaitStatus.NotWaiting, decision.Status);
        Assert.Equal(SignalStatus.NotFound, (await queue.SendSignalAsync(Guid.NewGuid(), "approved", 1, "k", "ops", Token)).Status);
    }

    [Fact]
    public async Task RefusesAnInvalidDeliveryBeforeAnyStatement()
    {
        var queue = new Queue(database.DataSource);
        await Assert.ThrowsAsync<ArgumentException>(() => queue.SendSignalAsync(Guid.NewGuid(), " padded", 1, "k", "ops", Token));
        await Assert.ThrowsAsync<ArgumentException>(() => queue.SendSignalAsync(Guid.NewGuid(), "name", 1, "", "ops", Token));
        await Assert.ThrowsAsync<ArgumentException>(() => queue.CompleteHumanWaitAsync(Guid.NewGuid(), "name", 1, "k", "", Token));

        // The limit is on the jsonb text, which writes ", " between members: 60,001 compact bytes
        // become 71,999 bytes of jsonb text.
        var large = Enumerable.Repeat(1000, 12_000).ToArray();
        await Assert.ThrowsAsync<ArgumentException>(() => queue.SendSignalAsync(Guid.NewGuid(), "name", large, "k", "ops", Token));
    }

    [Fact]
    public async Task ReadsTheHealthSnapshot()
    {
        var queue = new Queue(database.DataSource);
        var health = await queue.HealthAsync(Token);
        Assert.NotEmpty(health.Snapshot);
    }

    [Fact]
    public async Task AssertsCompatibilityForTheSourceAndForACaller()
    {
        var queue = new Queue(database.DataSource);
        await queue.AssertCompatibleAsync(Token);
        await using var connection = await database.DataSource.OpenConnectionAsync(Token);
        await queue.Using(connection).AssertCompatibleAsync(Token);
    }

    [Fact]
    public async Task RefusesBeforeAMutationWhenTheSchemaIsMissing()
    {
        var queueName = UniqueName("refused");
        var queue = new Queue(database.DataSource, new QueueOptions { DefaultQueue = queueName });
        await using var connection = await database.DataSource.OpenConnectionAsync(Token);
        await using var transaction = await connection.BeginTransactionAsync(Token);
        await using (var hide = new NpgsqlCommand("ALTER SCHEMA workhorse RENAME TO workhorse_hidden_queue", connection))
        {
            await hide.ExecuteNonQueryAsync(Token);
        }

        var error = await Assert.ThrowsAsync<CompatibilityException>(() => queue.Using(connection).EnqueueAsync("t", 1, Token));
        Assert.Equal(CompatibilityCode.SchemaNotInstalled, error.Code);
        await transaction.RollbackAsync(Token);
        Assert.Equal(0, await CountAsync(database, queueName));
    }
}
