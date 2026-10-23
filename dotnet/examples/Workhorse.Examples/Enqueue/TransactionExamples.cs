using Microsoft.EntityFrameworkCore;
using Npgsql;
using Workhorse.EntityFrameworkCore;

namespace Workhorse.Examples.Enqueue;

/// <summary>One row of the <c>account</c> table of the transaction examples.</summary>
public sealed class Account
{
    public required string Id { get; init; }

    public required string Email { get; init; }
}

/// <summary>The EF Core context of the transaction examples, on the <c>account</c> table.</summary>
public sealed class AccountsDbContext(DbContextOptions<AccountsDbContext> options) : DbContext(options)
{
    public DbSet<Account> Accounts => Set<Account>();

    protected override void OnModelCreating(ModelBuilder modelBuilder)
    {
        ArgumentNullException.ThrowIfNull(modelBuilder);
        modelBuilder.Entity<Account>(account =>
        {
            account.ToTable("account");
            account.Property(row => row.Id).HasColumnName("id");
            account.Property(row => row.Email).HasColumnName("email");
        });
    }
}

/// <summary>The C# examples of an enqueue in the transaction of the caller.</summary>
public sealed class TransactionExamples(NpgsqlDataSource dataSource, Queue queue)
{
    public async Task EnqueueInTransactionAsync(NpgsqlConnection connection, string id, string email)
    {
        ArgumentNullException.ThrowIfNull(connection);
        // docs:start csharp-enqueue-in-transaction
        await using var transaction = await connection.BeginTransactionAsync();
        await using (var insert = new NpgsqlCommand(
            "INSERT INTO account (id, email) VALUES ($1, $2)", connection))
        {
            insert.Parameters.AddWithValue(id);
            insert.Parameters.AddWithValue(email);
            await insert.ExecuteNonQueryAsync();
        }

        await queue.Using(connection).EnqueueAsync("account.created", new { accountId = id });
        await transaction.CommitAsync();
        // docs:end
    }

    // docs:start csharp-enqueue-npgsql-transaction
    public async Task CreateAccountAsync(string id, string email, CancellationToken cancellationToken)
    {
        await using var connection = await dataSource.OpenConnectionAsync(cancellationToken);
        await using var transaction = await connection.BeginTransactionAsync(cancellationToken);
        await using (var insert = new NpgsqlCommand(
            "INSERT INTO account (id, email) VALUES ($1, $2)", connection))
        {
            insert.Parameters.AddWithValue(id);
            insert.Parameters.AddWithValue(email);
            await insert.ExecuteNonQueryAsync(cancellationToken);
        }

        await queue.Using(connection)
            .EnqueueAsync("account.created", new { accountId = id }, cancellationToken);
        await transaction.CommitAsync(cancellationToken);
    }
    // docs:end

    // docs:start csharp-enqueue-ef-core
    public async Task CreateAccountAsync(
        AccountsDbContext db, string id, string email, CancellationToken cancellationToken)
    {
        await using var transaction = await db.Database.BeginTransactionAsync(cancellationToken);
        db.Accounts.Add(new Account { Id = id, Email = email });
        await db.SaveChangesAsync(cancellationToken);
        await queue.Using(db.Database.GetWorkhorseConnection())
            .EnqueueAsync("account.created", new { accountId = id }, cancellationToken);
        await transaction.CommitAsync(cancellationToken);
    }
    // docs:end
}
