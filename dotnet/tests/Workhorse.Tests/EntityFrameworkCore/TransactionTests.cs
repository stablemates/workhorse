using Microsoft.EntityFrameworkCore;
using Npgsql;
using Workhorse.EntityFrameworkCore;
using Workhorse.Tests.Testing;
using static Workhorse.Tests.Testing.WorkerHarness;

namespace Workhorse.Tests.EntityFrameworkCore;

/// <summary>An enqueue that joins a <c>DbContext</c> transaction (ADR 0107, "EF Core").</summary>
public sealed class TransactionTests(ScratchDatabase database) : IClassFixture<ScratchDatabase>
{
    private static CancellationToken Token => TestContext.Current.CancellationToken;

    internal sealed class ShopContext(DbContextOptions<ShopContext> options) : DbContext(options);

    [Fact]
    public async Task ATaskCommitsWithTheDbContextTransaction()
    {
        var queue = new Queue(database.DataSource, new QueueOptions { DefaultQueue = UniqueQueue("efcore") });
        await using var db = Context(database.DataSource);

        await using var transaction = await db.Database.BeginTransactionAsync(Token);
        var result = await queue.Using(db.Database.GetWorkhorseConnection()).EnqueueAsync("send-receipt", new { orderId = 1 }, Token);
        Assert.Equal(0L, await CountAsync(result.TaskId));

        await transaction.CommitAsync(Token);
        Assert.Equal(1L, await CountAsync(result.TaskId));
    }

    [Fact]
    public async Task ATaskRollsBackWithTheDbContextTransaction()
    {
        var queue = new Queue(database.DataSource, new QueueOptions { DefaultQueue = UniqueQueue("efcore") });
        await using var db = Context(database.DataSource);

        Guid taskId;
        await using (var transaction = await db.Database.BeginTransactionAsync(Token))
        {
            await db.Database.ExecuteSqlRawAsync("SELECT 1", Token);
            taskId = (await queue.Using(db.Database.GetWorkhorseConnection()).EnqueueAsync("send-receipt", new { orderId = 2 }, Token)).TaskId;
            await transaction.RollbackAsync(Token);
        }

        Assert.Equal(0L, await CountAsync(taskId));
    }

    [Fact]
    public async Task AClosedConnectionIsRefused()
    {
        await using var db = Context(database.DataSource);
        var error = Assert.Throws<InvalidOperationException>(() => db.Database.GetWorkhorseConnection());
        Assert.Contains("not open", error.Message, StringComparison.Ordinal);
    }

    private static ShopContext Context(NpgsqlDataSource dataSource) =>
        new(new DbContextOptionsBuilder<ShopContext>().UseNpgsql(dataSource).Options);

    /// <summary>Counts the task from another connection, so the count sees only committed rows.</summary>
    private async Task<long> CountAsync(Guid taskId) =>
        (long)(await ScalarAsync(database.DataSource, "SELECT count(*) FROM workhorse.task WHERE id = $1", taskId))!;
}
