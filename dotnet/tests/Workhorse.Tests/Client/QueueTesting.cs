using Npgsql;
using Workhorse.Internal;
using Workhorse.Internal.Database;
using Workhorse.Tests.Testing;

namespace Workhorse.Tests.Client;

/// <summary>Reads the rows that a queue call wrote. The tests name a unique queue each, because they share one database.</summary>
internal static class QueueTesting
{
    private const string TaskSql =
        """
        SELECT j.queue_name, j.task_type, j.payload, j.priority, j.tags, j.max_attempts, j.retry_policy,
               j.deadline_at, j.execution_timeout_ms, j.concurrency_key, j.budget_name, j.contract_version,
               j.payload_max_bytes, r.state, r.run_at
          FROM workhorse.task j LEFT JOIN workhorse.task_runtime r ON r.task_id = j.id
         WHERE j.id = $1::uuid
        """;

    internal static string UniqueName(string prefix) => $"{prefix}-{Guid.NewGuid():N}";

    internal static CancellationToken Token => TestContext.Current.CancellationToken;

    /// <summary>The stored task, or <c>null</c>.</summary>
    internal static async Task<Row?> TaskAsync(ScratchDatabase database, Guid taskId)
    {
        await using var connection = await database.DataSource.OpenConnectionAsync(Token);
        var rows = await Sql.RowsAsync(connection, new SqlCatalogue.Statement("task", TaskSql, 1), [Parameters.Uuid(taskId)], Token);
        return rows.Count == 0 ? null : rows[0];
    }

    /// <summary>The number of tasks on <paramref name="queue"/>.</summary>
    internal static async Task<long> CountAsync(ScratchDatabase database, string queue)
    {
        await using var command = database.DataSource.CreateCommand("SELECT count(*) FROM workhorse.task WHERE queue_name = $1");
        command.Parameters.Add(Parameters.Text(queue));
        return (long)(await command.ExecuteScalarAsync(Token))!;
    }

    internal static async Task<T?> ScalarAsync<T>(ScratchDatabase database, string sql, params NpgsqlParameter[] parameters)
    {
        await using var command = database.DataSource.CreateCommand(sql);
        command.Parameters.AddRange(parameters);
        var value = await command.ExecuteScalarAsync(Token);
        return value is DBNull or null ? default : (T)value;
    }
}
