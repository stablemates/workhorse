using Npgsql;

namespace Workhorse.Internal.Database;

/// <summary>
/// Runs catalogue statements on a connection. It changes no session state, and it never begins,
/// commits, or rolls back a transaction.
/// </summary>
internal static class Sql
{
    private const int FencedWriteDeadlockAttempts = 3;

    /// <summary>The rows that <paramref name="statement"/> returns.</summary>
    /// <exception cref="WorkhorseException">PostgreSQL refused the statement.</exception>
    internal static async Task<IReadOnlyList<Row>> RowsAsync(
        NpgsqlConnection connection,
        SqlCatalogue.Statement statement,
        NpgsqlParameter[] parameters,
        CancellationToken cancellationToken)
    {
        RequireArity(statement, parameters);
        await using var command = new NpgsqlCommand(statement.Sql, connection);
        command.Parameters.AddRange(parameters);
        try
        {
            await using var reader = await command.ExecuteReaderAsync(cancellationToken).ConfigureAwait(false);
            var rows = new List<Row>();
            do
            {
                while (await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
                {
                    var values = new Dictionary<string, object?>(reader.FieldCount, StringComparer.Ordinal);
                    for (var column = 0; column < reader.FieldCount; column++)
                    {
                        values[reader.GetName(column)] = await ValueAsync(reader, column, cancellationToken).ConfigureAwait(false);
                    }

                    rows.Add(new Row(values));
                }
            }
            while (await reader.NextResultAsync(cancellationToken).ConfigureAwait(false));

            return rows;
        }
        catch (NpgsqlException error) when (!cancellationToken.IsCancellationRequested)
        {
            throw SqlStates.Translate(error);
        }
    }

    /// <summary>
    /// The rows that <paramref name="statement"/> returns, read with the synchronous Npgsql API.
    /// The heartbeat and the listener use it on their dedicated threads (ADR 0107, "Concurrency").
    /// </summary>
    /// <param name="connection">The open connection.</param>
    /// <param name="statement">The catalogue statement.</param>
    /// <param name="parameters">One parameter for each placeholder.</param>
    /// <param name="commandTimeoutSeconds">The command timeout in whole seconds; 0 waits without limit.</param>
    /// <param name="onCommand">
    /// Receives the command before it executes, so that an owner can call
    /// <see cref="NpgsqlCommand.Cancel"/> from another thread.
    /// </param>
    /// <exception cref="WorkhorseException">PostgreSQL refused the statement, or the command timed out.</exception>
    /// <exception cref="OperationCanceledException">
    /// Another thread called <see cref="NpgsqlCommand.Cancel"/>. Npgsql reports it as a
    /// cancellation, with the <c>57014</c> <see cref="PostgresException"/> as the inner exception.
    /// </exception>
    internal static IReadOnlyList<Row> Rows(
        NpgsqlConnection connection,
        SqlCatalogue.Statement statement,
        NpgsqlParameter[] parameters,
        int commandTimeoutSeconds,
        Action<NpgsqlCommand>? onCommand = null)
    {
        RequireArity(statement, parameters);
        ArgumentOutOfRangeException.ThrowIfNegative(commandTimeoutSeconds);
        using var command = new NpgsqlCommand(statement.Sql, connection) { CommandTimeout = commandTimeoutSeconds };
        command.Parameters.AddRange(parameters);
        onCommand?.Invoke(command);
        try
        {
            using var reader = command.ExecuteReader();
            var rows = new List<Row>();
            do
            {
                while (reader.Read())
                {
                    var values = new Dictionary<string, object?>(reader.FieldCount, StringComparer.Ordinal);
                    for (var column = 0; column < reader.FieldCount; column++)
                    {
                        values[reader.GetName(column)] = reader.IsDBNull(column) ? null : Value(reader, column);
                    }

                    rows.Add(new Row(values));
                }
            }
            while (reader.NextResult());

            return rows;
        }
        catch (NpgsqlException error)
        {
            throw SqlStates.Translate(error);
        }
    }

    /// <summary>
    /// Sends a fenced write, and sends it again when PostgreSQL chose it as a deadlock victim.
    /// </summary>
    /// <remarks>
    /// PostgreSQL rolls back the whole statement, and a resend writes the same complete desired
    /// set. A deadlock aborts a caller-owned transaction, so a resend there fails with
    /// <c>25P02</c>, and the caller gets the original deadlock instead.
    /// </remarks>
    internal static async Task<IReadOnlyList<Row>> FencedRowsAsync(
        NpgsqlConnection connection,
        SqlCatalogue.Statement statement,
        Func<NpgsqlParameter[]> parameters,
        CancellationToken cancellationToken)
    {
        DatabaseException? deadlock = null;
        for (var count = 1; ; count++)
        {
            try
            {
                return await RowsAsync(connection, statement, parameters(), cancellationToken).ConfigureAwait(false);
            }
            catch (DatabaseException error)
            {
                if (deadlock is not null && error.SqlState == SqlStates.InFailedTransaction)
                {
                    throw deadlock;
                }

                if (count >= FencedWriteDeadlockAttempts || error.SqlState != SqlStates.DeadlockDetected)
                {
                    throw;
                }

                deadlock = error;
            }
        }
    }

    /// <summary>A column value. A <c>timestamptz</c> column reads as a <see cref="DateTimeOffset"/> in UTC.</summary>
    private static async ValueTask<object?> ValueAsync(NpgsqlDataReader reader, int column, CancellationToken cancellationToken)
    {
        if (await reader.IsDBNullAsync(column, cancellationToken).ConfigureAwait(false))
        {
            return null;
        }

        return Value(reader, column);
    }

    private static object Value(NpgsqlDataReader reader, int column) =>
        reader.GetDataTypeName(column) switch
        {
            "timestamp with time zone" => reader.GetFieldValue<DateTimeOffset>(column),
            "json" or "jsonb" => reader.GetFieldValue<string>(column),
            _ => reader.GetValue(column),
        };

    private static void RequireArity(SqlCatalogue.Statement statement, NpgsqlParameter[] parameters)
    {
        if (parameters.Length != statement.Arity)
        {
            throw new InvalidOperationException($"{statement.Name} takes {statement.Arity} parameters");
        }
    }
}
