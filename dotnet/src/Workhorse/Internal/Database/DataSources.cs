using System.Transactions;
using Npgsql;

namespace Workhorse.Internal.Database;

/// <summary>The checks and the connection open of the source form (ADR 0107, "Connection model").</summary>
internal static class DataSources
{
    /// <summary>The Npgsql switch that changes the timestamp mappings for the whole process.</summary>
    internal const string LegacyTimestampSwitch = "Npgsql.EnableLegacyTimestampBehavior";

    /// <summary>
    /// Refuses a data source that the SDK cannot use: a legacy timestamp process, or a connection
    /// string with <c>Multiplexing=true</c>.
    /// </summary>
    /// <exception cref="InvalidOperationException">The legacy timestamp switch is on.</exception>
    /// <exception cref="ArgumentException">The data source uses multiplexing.</exception>
    internal static NpgsqlDataSource Require(NpgsqlDataSource dataSource, string parameterName)
    {
        ArgumentNullException.ThrowIfNull(dataSource, parameterName);
        RequireModernTimestamps();
        if (new NpgsqlConnectionStringBuilder(dataSource.ConnectionString).Multiplexing)
        {
            throw new ArgumentException(
                "Workhorse refuses an NpgsqlDataSource with Multiplexing=true; turn Multiplexing off",
                parameterName);
        }

        return dataSource;
    }

    /// <summary>Throws <see cref="InvalidOperationException"/> when the legacy timestamp switch is on.</summary>
    internal static void RequireModernTimestamps()
    {
        if (AppContext.TryGetSwitch(LegacyTimestampSwitch, out var enabled) && enabled)
        {
            throw new InvalidOperationException(
                $"Workhorse refuses the {LegacyTimestampSwitch} switch, because it changes the timestamptz mappings for the whole process");
        }
    }

    /// <summary>
    /// Opens a connection from <paramref name="dataSource"/> inside a suppressed
    /// <see cref="TransactionScope"/>, so an ambient scope never enlists it. Statements on it then
    /// run in autocommit.
    /// </summary>
    internal static async Task<NpgsqlConnection> OpenAsync(NpgsqlDataSource dataSource, CancellationToken cancellationToken)
    {
        using var scope = new TransactionScope(TransactionScopeOption.Suppress, TransactionScopeAsyncFlowOption.Enabled);
        try
        {
            return await dataSource.OpenConnectionAsync(cancellationToken).ConfigureAwait(false);
        }
        catch (NpgsqlException error) when (!cancellationToken.IsCancellationRequested)
        {
            throw SqlStates.Translate(error);
        }
    }

    /// <summary>
    /// The synchronous form of <see cref="OpenAsync"/>, with the same suppressed scope, for the
    /// dedicated threads of the worker (ADR 0107, "Concurrency").
    /// </summary>
    internal static NpgsqlConnection Open(NpgsqlDataSource dataSource)
    {
        using var scope = new TransactionScope(TransactionScopeOption.Suppress);
        try
        {
            return dataSource.OpenConnection();
        }
        catch (NpgsqlException error)
        {
            throw SqlStates.Translate(error);
        }
    }

    /// <summary>
    /// Runs <paramref name="body"/> on <paramref name="caller"/>, or on a connection that the call
    /// opens from <paramref name="dataSource"/> and then disposes. The SDK never opens, closes,
    /// begins, commits, or rolls back on a caller connection.
    /// </summary>
    internal static async Task<T> RunAsync<T>(
        NpgsqlDataSource dataSource,
        NpgsqlConnection? caller,
        Func<NpgsqlConnection, bool, Task<T>> body,
        CancellationToken cancellationToken)
    {
        if (caller is not null)
        {
            if (caller.State != System.Data.ConnectionState.Open)
            {
                throw new InvalidOperationException("The caller connection must be open");
            }

            return await body(caller, true).ConfigureAwait(false);
        }

        var connection = await OpenAsync(dataSource, cancellationToken).ConfigureAwait(false);
        await using (connection.ConfigureAwait(false))
        {
            return await body(connection, false).ConfigureAwait(false);
        }
    }
}
