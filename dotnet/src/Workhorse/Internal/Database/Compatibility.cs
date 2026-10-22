using System.Runtime.CompilerServices;
using Npgsql;

namespace Workhorse.Internal.Database;

/// <summary>The startup check that every SDK runs before its first mutation.</summary>
internal static class Compatibility
{
    /// <summary>The refusal code for the observed state, or <c>null</c> when the client can continue.</summary>
    internal static CompatibilityCode? Check(int? installedSchemaVersion, int clientProtocolVersion, IReadOnlyCollection<int> servedProtocolVersions)
    {
        if (installedSchemaVersion is null)
        {
            return CompatibilityCode.SchemaNotInstalled;
        }

        if (installedSchemaVersion < SqlCatalogue.MinimumSchemaVersion)
        {
            return CompatibilityCode.SchemaTooOld;
        }

        if (clientProtocolVersion < SqlCatalogue.MinimumProtocolVersion)
        {
            return CompatibilityCode.ClientProtocolTooOld;
        }

        if (clientProtocolVersion > SqlCatalogue.MaximumProtocolVersion)
        {
            return CompatibilityCode.ClientProtocolTooNew;
        }

        if (servedProtocolVersions.Count == 0 || servedProtocolVersions.Contains(clientProtocolVersion))
        {
            return null;
        }

        return clientProtocolVersion < servedProtocolVersions.Min()
            ? CompatibilityCode.SchemaTooNew
            : CompatibilityCode.SchemaTooOld;
    }

    /// <summary>The refusal code for the database that <paramref name="connection"/> reaches, or <c>null</c>.</summary>
    internal static async Task<CompatibilityCode?> EvaluateAsync(NpgsqlConnection connection, CancellationToken cancellationToken)
    {
        IReadOnlyList<Row> rows;
        try
        {
            rows = await Sql.RowsAsync(connection, SqlCatalogue.CompatibilityState, [], cancellationToken).ConfigureAwait(false);
        }
        catch (DatabaseException error) when (error.SqlState is SqlStates.UndefinedTable or SqlStates.InvalidSchemaName)
        {
            return CompatibilityCode.SchemaNotInstalled;
        }

        var schemas = new List<int>();
        var served = new List<int>();
        foreach (var row in rows)
        {
            var version = row.RequiredInteger("version");
            switch (row.RequiredText("kind"))
            {
                case "schema":
                    schemas.Add(version);
                    break;
                case "protocol":
                    served.Add(version);
                    break;
                default:
                    break;
            }
        }

        return Check(schemas.Count == 1 ? schemas[0] : null, SqlCatalogue.ClientProtocolVersion, served);
    }
}

/// <summary>
/// The compatibility results of one <c>Queue</c> or <c>Admin</c> (ADR 0107, "Connection model").
/// </summary>
/// <remarks>
/// The cache holds one result for the data source, and one result for each caller connection. A
/// <see cref="ConditionalWeakTable{TKey, TValue}"/> compares caller connections by reference and
/// does not keep them alive. A refusal is cached; a driver error is not. Two calls can check at
/// the same time, and the first result to arrive stays.
/// </remarks>
internal sealed class CompatibilityCache
{
    private readonly ConditionalWeakTable<NpgsqlConnection, Result> _callers = [];
    private Result? _source;

    /// <summary>
    /// Throws <see cref="CompatibilityException"/> when PostgreSQL and this client cannot work together.
    /// </summary>
    /// <param name="connection">The connection of the call.</param>
    /// <param name="caller">Whether the caller owns <paramref name="connection"/>.</param>
    /// <param name="cancellationToken">Cancels the check.</param>
    internal async Task AssertAsync(NpgsqlConnection connection, bool caller, CancellationToken cancellationToken)
    {
        var code = await CheckAsync(connection, caller, cancellationToken).ConfigureAwait(false);
        if (code is { } refusal)
        {
            throw new CompatibilityException(refusal);
        }
    }

    /// <summary>The refusal code for <paramref name="connection"/>, or <c>null</c> when the client can continue.</summary>
    internal async Task<CompatibilityCode?> CheckAsync(NpgsqlConnection connection, bool caller, CancellationToken cancellationToken)
    {
        if (!caller)
        {
            var cached = Volatile.Read(ref _source);
            if (cached is null)
            {
                var evaluated = new Result(await Compatibility.EvaluateAsync(connection, cancellationToken).ConfigureAwait(false));
                cached = Interlocked.CompareExchange(ref _source, evaluated, null) ?? evaluated;
            }

            return cached.Code;
        }

        if (_callers.TryGetValue(connection, out var known))
        {
            return known.Code;
        }

        var result = new Result(await Compatibility.EvaluateAsync(connection, cancellationToken).ConfigureAwait(false));
        return _callers.GetValue(connection, _ => result).Code;
    }

    private sealed class Result(CompatibilityCode? code)
    {
        internal CompatibilityCode? Code { get; } = code;
    }
}
