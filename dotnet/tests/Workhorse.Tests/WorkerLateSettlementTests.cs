using Npgsql;
using Workhorse.Tests.Testing;
using static Workhorse.Tests.Testing.WorkerHarness;

namespace Workhorse.Tests;

/// <summary>
/// A settlement that outlives the unwind window (SM-1685, ADR 0107 amendment of 2026-10-22). The
/// stop does not wait for it and does not cancel it, so it finishes after <see cref="Worker.RunAsync"/>
/// returns, as in Java. The run's statement token ends it at the latest lease end. A second
/// connection locks the task row, so the statement waits past the window on any host load.
/// </summary>
public sealed class WorkerLateSettlementTests(ScratchDatabase database)
{
    /// <summary>The lease of the bound test. The last renewal comes before the run returns.</summary>
    private static readonly TimeSpan BoundLease = TimeSpan.FromSeconds(3);

    /// <summary>The scheduling time on a busy machine that the bound test accepts after the lease end.</summary>
    private static readonly TimeSpan BoundSlack = TimeSpan.FromSeconds(5);

    /// <summary>The pool size of the bound test.</summary>
    private const int PoolSize = 6;

    private sealed record Order(int OrderId);

    [Fact]
    public async Task AReleaseThatOutlivesTheUnwindWindowStillReturnsTheTask()
    {
        var queue = UniqueQueue("late-release");
        await using var rowLock = await RowLock.OpenAsync(database.DataSource);
        var started = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var taskId = await EnqueueAsync(database.DataSource, queue, "release", new { orderId = 1 });
        await using var worker = new Worker(database.DataSource, Options(queue, options => options.ShutdownGrace = TimeSpan.FromMilliseconds(200)));
        worker.Handle<Order>("release", (context, _) => StopForTheShutdownBehindTheLockAsync(context, started, rowLock, taskId));

        var running = new RunningWorker(worker);
        await started.Task.WaitAsync(Patience, TestContext.Current.CancellationToken);
        var error = await Assert.ThrowsAsync<ShutdownIncompleteException>(running.StopAsync);
        Assert.Equal(1, error.Abandoned);

        // The run has returned, and the release still waits for the lock.
        await EventuallyAsync(async () => await BlockedByAsync(rowLock.ProcessId) == 1, "the release waits for the row lock");
        Assert.Equal("active", (await TaskAsync(database.DataSource, taskId)).Text("state"));
        await rowLock.UnlockAsync();

        // A charged attempt increments current_attempt. A release and a claim do not.
        var back = await TaskInStateAsync(database.DataSource, taskId, "ready");
        Assert.Equal(1, back.RequiredInteger("current_attempt"));
        await using var next = new Worker(database.DataSource, Options(queue));
        next.Handle<Order>("release", (_, _) => Task.CompletedTask);
        await using var finishing = new RunningWorker(next);
        var done = await TaskInStateAsync(database.DataSource, taskId, "succeeded");
        Assert.Equal(1, done.RequiredInteger("current_attempt"));
        await finishing.StopAsync();
    }

    [Fact]
    public async Task ACompletionThatOutlivesTheUnwindWindowStillCommits()
    {
        var queue = UniqueQueue("late-complete");
        await using var rowLock = await RowLock.OpenAsync(database.DataSource);
        var locked = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var calls = 0;
        var taskId = await EnqueueAsync(database.DataSource, queue, "complete", new { orderId = 1 });
        await using var worker = new Worker(database.DataSource, Options(queue, options => options.ShutdownGrace = TimeSpan.FromMilliseconds(200)));
        worker.Handle<Order, string>("complete", async (_, _) =>
        {
            Interlocked.Increment(ref calls);
            // The handler finishes its work, and its completion then waits for the lock.
            await rowLock.LockAsync(taskId);
            locked.SetResult();
            return "done";
        });

        var running = new RunningWorker(worker);
        await locked.Task.WaitAsync(Patience, TestContext.Current.CancellationToken);
        var error = await Assert.ThrowsAsync<ShutdownIncompleteException>(running.StopAsync);
        Assert.Equal(1, error.Abandoned);

        await EventuallyAsync(async () => await BlockedByAsync(rowLock.ProcessId) == 1, "the completion waits for the row lock");
        await rowLock.UnlockAsync();

        var row = await TaskInStateAsync(database.DataSource, taskId, "succeeded");
        Assert.Equal("done", row.Json("result")!.Value.GetString());
        Assert.Equal(1, row.RequiredInteger("current_attempt"));
        Assert.Equal(1, Volatile.Read(ref calls));
    }

    [Fact]
    public async Task TheLeaseEndCancelsAStatementThatStillWaits()
    {
        var queue = UniqueQueue("late-bound");
        var application = $"late-bound-{Guid.NewGuid():N}"[..30];
        // The pool leaves room for the startup maintenance, the registration, and a claim on a slow
        // server. A statement that kept a connection after the bound would keep the test from opening
        // all of them. With no command timeout, only the lease bound can end the release.
        await using var dataSource = database.CreateDataSource(builder =>
        {
            builder.MaxPoolSize = PoolSize;
            builder.ApplicationName = application;
            builder.Timeout = 10;
            builder.CommandTimeout = 0;
        });
        await using var rowLock = await RowLock.OpenAsync(database.DataSource);
        var started = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var taskId = await EnqueueAsync(database.DataSource, queue, "release", new { orderId = 1 });
        await using var worker = new Worker(dataSource, Options(queue, options =>
        {
            options.ShutdownGrace = TimeSpan.FromMilliseconds(200);
            options.Lease = BoundLease;
        }));
        worker.Handle<Order>("release", (context, _) => StopForTheShutdownBehindTheLockAsync(context, started, rowLock, taskId));

        var running = new RunningWorker(worker);
        await started.Task.WaitAsync(Patience, TestContext.Current.CancellationToken);
        var error = await Assert.ThrowsAsync<ShutdownIncompleteException>(running.StopAsync);
        Assert.Equal(1, error.Abandoned);

        // The lock stays held, so the release cannot commit, and no command timeout ends it. The
        // attempt ends only when the token cancels the release. The last renewal came before the run
        // returned, so that happens by one lease after now, plus scheduling time.
        await EventuallyAsync(() => worker.ActiveAttempts == 0, "the lease end cancels the release", BoundLease + BoundSlack);
        Assert.Equal(0, await BlockedByAsync(rowLock.ProcessId, application));
        var connections = new List<NpgsqlConnection>();
        try
        {
            for (var index = 0; index < PoolSize; index++)
            {
                connections.Add(await dataSource.OpenConnectionAsync(TestContext.Current.CancellationToken));
            }
        }
        finally
        {
            foreach (var connection in connections)
            {
                await connection.DisposeAsync();
            }
        }

        Assert.Equal("active", (await TaskAsync(database.DataSource, taskId)).Text("state"));
        await rowLock.UnlockAsync();
    }

    /// <summary>
    /// A handler that waits for its token. When the shutdown cancels it, it locks the task row and
    /// then stops, so the worker's release waits for the lock.
    /// </summary>
    private static async Task StopForTheShutdownBehindTheLockAsync(HandlerContext context, TaskCompletionSource started, RowLock rowLock, Guid taskId)
    {
        started.TrySetResult();
        try
        {
            await Task.Delay(Timeout.Infinite, context.CancellationToken);
        }
        catch (OperationCanceledException)
        {
            await rowLock.LockAsync(taskId);
            throw;
        }
    }

    /// <summary>The backends that wait for a lock of <paramref name="pid"/>, of one application name or of all.</summary>
    private async Task<long> BlockedByAsync(int pid, string? application = null) =>
        (long)(await ScalarAsync(
            database.DataSource,
            "SELECT count(*) FROM pg_stat_activity WHERE $1 = ANY (pg_blocking_pids(pid)) AND application_name LIKE $2",
            pid,
            application ?? "%"))!;

    /// <summary>A transaction on its own connection that locks the row of one task in both tiers.</summary>
    private sealed class RowLock : IAsyncDisposable
    {
        private readonly NpgsqlConnection _connection;
        private NpgsqlTransaction? _transaction;

        private RowLock(NpgsqlConnection connection) => _connection = connection;

        internal int ProcessId => _connection.ProcessID;

        internal static async Task<RowLock> OpenAsync(NpgsqlDataSource dataSource) => new(await dataSource.OpenConnectionAsync());

        internal async Task LockAsync(Guid taskId)
        {
            _transaction = await _connection.BeginTransactionAsync();
            foreach (var table in new[] { "workhorse.task_runtime", "workhorse.fast_task_runtime" })
            {
                await using var command = new NpgsqlCommand($"SELECT 1 FROM {table} WHERE task_id = $1 FOR UPDATE", _connection, _transaction);
                command.Parameters.Add(new NpgsqlParameter { Value = taskId });
                await command.ExecuteNonQueryAsync();
            }
        }

        internal async Task UnlockAsync()
        {
            if (_transaction is not null)
            {
                await _transaction.RollbackAsync();
                await _transaction.DisposeAsync();
                _transaction = null;
            }
        }

        public async ValueTask DisposeAsync()
        {
            await UnlockAsync();
            await _connection.DisposeAsync();
        }
    }
}
