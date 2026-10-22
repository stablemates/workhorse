using System.Data;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Infrastructure;
using Npgsql;

namespace Workhorse.EntityFrameworkCore;

/// <summary>
/// Lets an enqueue join a <c>DbContext</c> transaction (ADR 0107, "EF Core"), as ADR 0070's
/// accessor does for SQLAlchemy.
/// </summary>
public static class WorkhorseDatabaseFacadeExtensions
{
    /// <summary>
    /// The open <see cref="NpgsqlConnection"/> of <paramref name="database"/>. Pass it to
    /// <see cref="Queue.Using"/>, so that the enqueue commits and rolls back with the transaction
    /// that EF Core opened.
    /// </summary>
    /// <example>
    /// <code>
    /// await using var transaction = await db.Database.BeginTransactionAsync(cancellationToken);
    /// db.Orders.Add(order);
    /// await db.SaveChangesAsync(cancellationToken);
    /// await queue.Using(db.Database.GetWorkhorseConnection())
    ///     .EnqueueAsync("send-receipt", new { order.Id }, cancellationToken);
    /// await transaction.CommitAsync(cancellationToken);
    /// </code>
    /// </example>
    /// <exception cref="InvalidOperationException">
    /// The provider is not Npgsql, or the connection is not open. A <c>DbContext</c> with a current
    /// transaction always has an open connection.
    /// </exception>
    public static NpgsqlConnection GetWorkhorseConnection(this DatabaseFacade database)
    {
        ArgumentNullException.ThrowIfNull(database);
        var connection = database.GetDbConnection();
        if (connection is not NpgsqlConnection npgsql)
        {
            throw new InvalidOperationException(
                $"Workhorse needs the Npgsql EF Core provider, but the DbContext uses {connection.GetType().FullName}");
        }

        if (npgsql.State != ConnectionState.Open)
        {
            throw new InvalidOperationException(
                "The DbContext connection is not open; begin a transaction with Database.BeginTransactionAsync first");
        }

        return npgsql;
    }
}
