using Microsoft.EntityFrameworkCore;
using Npgsql;
using Workhorse.Examples.Enqueue;
using Workhorse.Examples.Tests.Testing;
using Workhorse.Tests.Testing;

namespace Workhorse.Examples.Tests.Enqueue;

/// <summary>
/// Runs the C# snippets that enqueue in the transaction of the caller. Each test has its own
/// database with an <c>account</c> table. The unique email is checked at commit, so a second
/// account with the same email fails at <c>COMMIT</c>, after the enqueue ran in the transaction.
/// </summary>
public sealed class TransactionExamplesTests(ScratchDatabase scratch)
{
    private static CancellationToken Token => TestContext.Current.CancellationToken;

    [Fact]
    public async Task TheShortFormCommitsTheAccountAndTheTaskTogether()
    {
        await using var db = await AccountDatabaseAsync();
        var id = $"csharp-{Guid.NewGuid()}";
        await using (var connection = await db.DataSource.OpenConnectionAsync(Token))
        {
            await Examples(db).EnqueueInTransactionAsync(connection, id, $"{id}@example.com");
        }

        Assert.Equal(1L, await AccountsAsync(db, id));
        Assert.Single(await db.TasksAsync("account.created", "accountId", id));
    }

    [Fact]
    public async Task TheNpgsqlTransactionCommitsTheAccountAndTheTaskTogether()
    {
        await using var db = await AccountDatabaseAsync();
        var id = $"csharp-{Guid.NewGuid()}";
        await Examples(db).CreateAccountAsync(id, $"{id}@example.com", Token);

        Assert.Equal(1L, await AccountsAsync(db, id));
        Assert.Single(await db.TasksAsync("account.created", "accountId", id));
    }

    [Fact]
    public async Task TheNpgsqlTransactionRollsBackTheTaskWithTheAccount()
    {
        await using var db = await AccountDatabaseAsync();
        var email = $"csharp-{Guid.NewGuid()}@example.com";
        await Examples(db).CreateAccountAsync($"csharp-{Guid.NewGuid()}", email, Token);

        var id = $"csharp-{Guid.NewGuid()}";
        var error = await Assert.ThrowsAsync<PostgresException>(() => Examples(db).CreateAccountAsync(id, email, Token));
        Assert.Equal(PostgresErrorCodes.UniqueViolation, error.SqlState);
        Assert.Equal(0L, await AccountsAsync(db, id));
        Assert.Empty(await db.TasksAsync("account.created", "accountId", id));
    }

    [Fact]
    public async Task TheEfCoreTransactionCommitsTheAccountAndTheTaskTogether()
    {
        await using var db = await AccountDatabaseAsync();
        var id = $"csharp-{Guid.NewGuid()}";
        await using (var context = Context(db))
        {
            await Examples(db).CreateAccountAsync(context, id, $"{id}@example.com", Token);
        }

        Assert.Equal(1L, await AccountsAsync(db, id));
        Assert.Single(await db.TasksAsync("account.created", "accountId", id));
    }

    [Fact]
    public async Task TheEfCoreTransactionRollsBackTheTaskWithTheAccount()
    {
        await using var db = await AccountDatabaseAsync();
        var email = $"csharp-{Guid.NewGuid()}@example.com";
        await using (var context = Context(db))
        {
            await Examples(db).CreateAccountAsync(context, $"csharp-{Guid.NewGuid()}", email, Token);
        }

        var id = $"csharp-{Guid.NewGuid()}";
        await using (var context = Context(db))
        {
            var error = await Assert.ThrowsAsync<PostgresException>(
                () => Examples(db).CreateAccountAsync(context, id, email, Token));
            Assert.Equal(PostgresErrorCodes.UniqueViolation, error.SqlState);
        }

        Assert.Equal(0L, await AccountsAsync(db, id));
        Assert.Empty(await db.TasksAsync("account.created", "accountId", id));
    }

    private static TransactionExamples Examples(ExampleDatabase db) => new(db.DataSource, db.Queue);

    private static AccountsDbContext Context(ExampleDatabase db) =>
        new(new DbContextOptionsBuilder<AccountsDbContext>().UseNpgsql(db.DataSource).Options);

    private static Task<long> AccountsAsync(ExampleDatabase db, string id) =>
        db.ScalarAsync<long>("SELECT count(*) FROM account WHERE id = $1", id);

    private async Task<ExampleDatabase> AccountDatabaseAsync()
    {
        var db = await ExampleDatabase.CreateIsolatedAsync(scratch);
        await db.ExecuteAsync(
            "CREATE TABLE account (id text PRIMARY KEY, email text NOT NULL UNIQUE DEFERRABLE INITIALLY DEFERRED)");
        return db;
    }
}
