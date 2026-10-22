using System.Transactions;
using Npgsql;
using NpgsqlTypes;

namespace Workhorse.AspNetCore.Internal;

/// <summary>
/// Runs the statements of <see cref="DashboardSqlCatalogue"/> and <see cref="V1"/>. Each call uses
/// its own connection from the data source and opens no transaction.
/// </summary>
/// <remarks>
/// Each parameter is an <see cref="NpgsqlParameter"/> with no name, so Npgsql sends the native
/// <c>$n</c> placeholders of the statement. Its <see cref="NpgsqlDbType"/> follows the cast in the
/// contract (ADR 0107, "SQL comes from the generated catalogue").
/// </remarks>
internal sealed class Statements(NpgsqlDataSource dataSource)
{
    /// <summary>A <c>text</c> parameter, which also carries a <c>jsonb</c> document to its <c>::jsonb</c> cast.</summary>
    internal static NpgsqlParameter Text(string? value) => new() { NpgsqlDbType = NpgsqlDbType.Text, Value = (object?)value ?? DBNull.Value };

    /// <summary>An <c>integer</c> parameter.</summary>
    internal static NpgsqlParameter Integer(int? value) => new() { NpgsqlDbType = NpgsqlDbType.Integer, Value = (object?)value ?? DBNull.Value };

    /// <summary>A <c>time</c> parameter.</summary>
    internal static NpgsqlParameter Time(TimeOnly? value) => new() { NpgsqlDbType = NpgsqlDbType.Time, Value = (object?)value ?? DBNull.Value };

    /// <summary>A <c>uuid</c> parameter.</summary>
    internal static NpgsqlParameter Uuid(Guid value) => new() { NpgsqlDbType = NpgsqlDbType.Uuid, Value = value };

    /// <summary>A <c>text[]</c> parameter.</summary>
    internal static NpgsqlParameter TextArray(string[] value) => new() { NpgsqlDbType = NpgsqlDbType.Array | NpgsqlDbType.Text, Value = value };

    /// <summary>
    /// The <c>result</c> column of the one row of a dashboard statement, as the JSON text that
    /// PostgreSQL wrote, or <c>null</c> for SQL <c>NULL</c>. The backend writes the text into the
    /// response without a parse, so a stored integer of any length costs no number parse.
    /// </summary>
    internal async Task<string?> ResultAsync(string name, string sql, NpgsqlParameter[] parameters, CancellationToken cancellationToken)
    {
        var rows = await RowsAsync(sql, parameters, cancellationToken).ConfigureAwait(false);
        if (rows.Count != 1)
        {
            throw new InvalidOperationException($"{name} returned {rows.Count} rows; expected one");
        }

        return rows[0].TryGetValue("result", out var result) ? result as string : throw new InvalidOperationException($"{name} returned no result column");
    }

    /// <summary>
    /// Opens a connection outside any ambient <see cref="TransactionScope"/>, as the core does, so a
    /// host rollback never undoes a dashboard control. Each statement then runs in autocommit.
    /// </summary>
    private async Task<NpgsqlConnection> OpenAsync(CancellationToken cancellationToken)
    {
        using var scope = new TransactionScope(TransactionScopeOption.Suppress, TransactionScopeAsyncFlowOption.Enabled);
        return await dataSource.OpenConnectionAsync(cancellationToken).ConfigureAwait(false);
    }

    /// <summary>Each row of a statement as column name to value. A SQL <c>NULL</c> is <c>null</c>.</summary>
    internal async Task<List<Dictionary<string, object?>>> RowsAsync(
        string sql, NpgsqlParameter[] parameters, CancellationToken cancellationToken)
    {
        var connection = await OpenAsync(cancellationToken).ConfigureAwait(false);
        await using (connection.ConfigureAwait(false))
        {
            var command = new NpgsqlCommand(sql, connection);
            await using (command.ConfigureAwait(false))
            {
                command.Parameters.AddRange(parameters);
                var reader = await command.ExecuteReaderAsync(cancellationToken).ConfigureAwait(false);
                await using (reader.ConfigureAwait(false))
                {
                    var rows = new List<Dictionary<string, object?>>();
                    while (await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
                    {
                        var row = new Dictionary<string, object?>(StringComparer.Ordinal);
                        for (var column = 0; column < reader.FieldCount; column++)
                        {
                            row[reader.GetName(column)] = await reader.IsDBNullAsync(column, cancellationToken).ConfigureAwait(false)
                                ? null
                                : reader.GetDataTypeName(column) is "jsonb" or "json"
                                    ? reader.GetFieldValue<string>(column)
                                    : reader.GetValue(column);
                        }

                        rows.Add(row);
                    }

                    return rows;
                }
            }
        }
    }
}
