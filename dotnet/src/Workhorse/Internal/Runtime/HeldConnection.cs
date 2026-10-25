using System.Runtime.ExceptionServices;
using Npgsql;
using Workhorse.Internal.Database;

namespace Workhorse.Internal.Runtime;

/// <summary>
/// The heartbeat connection of one pool identity, and the dedicated thread that sends its rounds
/// with the synchronous Npgsql API (ADR 0107, "Concurrency").
/// </summary>
/// <remarks>
/// <para>
/// The heartbeat thread hands one round to this thread and waits for it only until the round's
/// deadline. When the deadline passes first, the connection is lost: the heartbeat thread does not
/// wait for the statement, and a replacement gets a new thread. A cleanup task then owns the lost
/// connection. It calls <see cref="NpgsqlCommand.Cancel"/> and disposes of the connection after the
/// statement ends. <c>Cancel()</c> can block for the connection timeout, or without limit with
/// <c>Cancellation Timeout=0</c>, so no part of the worker waits for the cleanup task.
/// </para>
/// <para>
/// Each round runs in its own transaction with the SM-1442 server timeouts, so PostgreSQL also ends
/// a round that waits. Both settings end with the transaction, so the connection keeps no session
/// state.
/// </para>
/// </remarks>
internal sealed class HeldConnection
{
    /// <summary>
    /// A round with less time than this left fails before it sends its heartbeat. At this size every
    /// server budget is at least 1 ms, and the budgets still fit in the time left.
    /// </summary>
    internal static readonly long MinRemainingNanos = Monotonic.Millis(8);

    private static int _cleanupsPending;
    private readonly TaskCompletionSource _cleanupStarted = new(TaskCreationOptions.RunContinuationsAsynchronously);
    private readonly TaskCompletionSource _cleanupEnded = new(TaskCreationOptions.RunContinuationsAsynchronously);

    private readonly NpgsqlConnection _connection;
    // Monitor.Wait needs a monitor lock, so this is an object and not a System.Threading.Lock.
    private readonly object _lock = new();
    private readonly TaskCompletionSource _exited = new(TaskCreationOptions.RunContinuationsAsynchronously);
    private Request? _request;
    private bool _letGo;
    private bool _lost;
    private volatile bool _broken;

    /// <summary>Cancels the statement in flight, or <c>null</c> between statements.</summary>
    private volatile Action? _cancel;

    internal HeldConnection(NpgsqlConnection connection)
    {
        _connection = connection;
        var thread = new Thread(Serve) { IsBackground = true, Name = "workhorse-heartbeat-connection" };
        thread.Start();
    }

    /// <summary>Completes when the cleanup task of this lost connection starts. A test reads it.</summary>
    internal Task CleanupStarted => _cleanupStarted.Task;

    /// <summary>Whether the cleanup task of this lost connection has disposed of it. A test reads it.</summary>
    internal bool CleanupEnded => _cleanupEnded.Task.IsCompleted;

    /// <summary>The cleanup tasks that have not disposed of their lost connection yet. A test reads it.</summary>
    internal static int CleanupsPending => Volatile.Read(ref _cleanupsPending);

    /// <summary>
    /// Completes when the heartbeat no longer holds the connection: after this thread gave a
    /// connection that was let go back to the pool, or at once for a lost connection, whose cleanup
    /// task then owns it.
    /// </summary>
    internal TaskCompletionSource Released { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);

    /// <summary>
    /// Whether the connection can send the next round. A failed round that rolled back keeps the
    /// connection usable, because its rollback ended the round's transaction.
    /// </summary>
    internal bool Usable
    {
        get
        {
            lock (_lock)
            {
                return !_broken && !_lost && !_letGo && _connection.FullState == System.Data.ConnectionState.Open;
            }
        }
    }

    /// <summary>
    /// Sends one round, a heartbeat statement in its own transaction, and waits for it until
    /// <paramref name="deadline"/>, a <see cref="Monotonic"/> value.
    /// </summary>
    /// <exception cref="RoundExpiredException">The round ended before its heartbeat statement, and
    /// the connection stays clean.</exception>
    /// <exception cref="RoundLostException">The deadline passed while the round ran. The connection
    /// is lost.</exception>
    internal IReadOnlyList<Row> Round(long deadline, SqlCatalogue.Statement statement, NpgsqlParameter[] parameters)
    {
        var request = new Request(deadline, statement, parameters);
        var lost = false;
        lock (_lock)
        {
            if (_lost || _letGo)
            {
                throw new InvalidOperationException("The heartbeat connection is no longer held");
            }

            _request = request;
            Monitor.PulseAll(_lock);
            while (!request.Done)
            {
                var remaining = deadline - Monotonic.Now();
                if (remaining <= 0)
                {
                    // The decision is taken under the lock. Once _lost is set, the connection thread
                    // ends without a disposal, so this round always hands the connection to cleanup.
                    _lost = true;
                    lost = true;
                    Monitor.PulseAll(_lock);
                    break;
                }

                Monitor.Wait(_lock, Monotonic.Span(remaining));
            }
        }

        if (lost)
        {
            // The statement still runs, so the connection cannot serve the next round. The worker
            // does not wait for it: the cleanup task cancels it and disposes of the connection.
            Released.TrySetResult();
            _ = Task.Run(CleanupAsync);
            throw new RoundLostException();
        }

        if (request.Error is not null)
        {
            ExceptionDispatchInfo.Throw(request.Error);
        }

        return request.Rows!;
    }

    /// <summary>
    /// Lets the connection go. The connection thread gives it back to the pool and ends. A lost
    /// connection is not changed, because its cleanup task owns it.
    /// </summary>
    internal void LetGo()
    {
        lock (_lock)
        {
            _letGo = true;
            Monitor.PulseAll(_lock);
        }
    }

    private async Task CleanupAsync()
    {
        Interlocked.Increment(ref _cleanupsPending);
        _cleanupStarted.TrySetResult();
        try
        {
            await CancelAndDisposeAsync().ConfigureAwait(false);
        }
        finally
        {
            Interlocked.Decrement(ref _cleanupsPending);
            _cleanupEnded.TrySetResult();
        }
    }

    private async Task CancelAndDisposeAsync()
    {
        try
        {
            _cancel?.Invoke();
        }
        catch (Exception error) when (error is NpgsqlException or InvalidOperationException or IOException
            or ObjectDisposedException or OperationCanceledException)
        {
            // The connection is disposed below, and the pool replaces a broken one.
        }

        await _exited.Task.ConfigureAwait(false);
        await _connection.DisposeAsync().ConfigureAwait(false);
    }

    private void Serve()
    {
        try
        {
            while (true)
            {
                Request request;
                lock (_lock)
                {
                    while (_request is null && !_letGo && !_lost)
                    {
                        Monitor.Wait(_lock);
                    }

                    if (_lost)
                    {
                        return;
                    }

                    if (_request is null)
                    {
                        break;
                    }

                    request = _request;
                    _request = null;
                }

                try
                {
                    request.Rows = Send(request);
                }
                catch (Exception error)
                {
                    request.Error = error;
                }

                lock (_lock)
                {
                    request.Done = true;
                    Monitor.PulseAll(_lock);
                    if (_lost)
                    {
                        return;
                    }
                }
            }

            _connection.Dispose();
            Released.TrySetResult();
        }
        finally
        {
            _exited.TrySetResult();
        }
    }

    /// <summary>
    /// Sends one round. A round that fails rolls back; a connection that cannot roll back in time is
    /// broken, because its state is not known. A round that expires before its heartbeat statement
    /// throws <see cref="RoundExpiredException"/> when the connection stays clean.
    /// </summary>
    private IReadOnlyList<Row> Send(Request request)
    {
        var deadline = request.Deadline;
        var setAt = Monotonic.Now();
        var remaining = deadline - setAt;
        if (remaining < MinRemainingNanos)
        {
            throw new RoundExpiredException("Heartbeat round reached its deadline before BEGIN");
        }

        var begun = false;
        try
        {
            var (statement, idle) = RoundTimeouts(remaining);
            using (var begin = new NpgsqlBatch(_connection))
            {
                begin.BatchCommands.Add(new NpgsqlBatchCommand(SessionCommands.Begin));
                var timeouts = new NpgsqlBatchCommand(SessionCommands.RoundTimeouts);
                timeouts.Parameters.Add(Parameters.Text(statement));
                timeouts.Parameters.Add(Parameters.Text(idle));
                begin.BatchCommands.Add(timeouts);
                begin.Timeout = TimeoutSeconds(deadline);
                begun = true;
                _cancel = begin.Cancel;
                begin.ExecuteNonQuery();
            }

            // The budgets fit only if the settings statement used at most the quarter kept for COMMIT.
            if (Monotonic.Now() - setAt > remaining / 4)
            {
                throw new RoundExpiredException("Heartbeat round settings took too long");
            }

            if (deadline - Monotonic.Now() <= 0)
            {
                throw new RoundExpiredException("Heartbeat round reached its deadline");
            }

            var rows = Sql.Rows(_connection, request.Statement, request.Parameters, TimeoutSeconds(deadline), command => _cancel = command.Cancel);
            Execute(SessionCommands.Commit, deadline);

            // A COMMIT that ends after the deadline does not count as a renewal.
            if (Monotonic.Now() - deadline >= 0)
            {
                throw new RoundDeadlineException("Heartbeat round reached its deadline");
            }

            return rows;
        }
        catch (RoundExpiredException) when (begun)
        {
            if (!RolledBack(deadline) || Monotonic.Now() - deadline >= 0)
            {
                // A rollback that fails or ends after the deadline did not end in the round's bound,
                // so the connection is discarded, as in every SDK.
                _broken = true;
                throw new RoundDeadlineException("Heartbeat round reached its deadline");
            }

            throw;
        }
        catch (Exception error) when (error is not RoundExpiredException)
        {
            // The translation wraps the driver's error, so the check reads the cause too.
            // A Cancel() from another thread ends the statement with an OperationCanceledException,
            // which leaves the transaction aborted, so the round treats it as a broken connection.
            var driver = error as NpgsqlException ?? error.InnerException as NpgsqlException;
            if (driver is { IsTransient: true } || error is IOException or TimeoutException or OperationCanceledException
                || driver?.SqlState?.StartsWith("08", StringComparison.Ordinal) == true
                || _connection.FullState != System.Data.ConnectionState.Open
                || !RolledBack(deadline))
            {
                _broken = true;
            }

            throw;
        }
        finally
        {
            _cancel = null;
        }
    }

    /// <summary>
    /// The server budgets for the rest of a round that has <paramref name="remainingNanos"/> left, in
    /// whole milliseconds: <c>statement_timeout</c> and <c>idle_in_transaction_session_timeout</c>.
    /// </summary>
    /// <remarks>
    /// PostgreSQL measures <c>statement_timeout</c> for each statement and the idle timeout for each
    /// idle gap, and restarts both every time. While the round can hold a row lock, it has one idle
    /// gap before the heartbeat, the heartbeat, and one idle gap before <c>COMMIT</c>. So the heartbeat
    /// gets one quarter and each gap one quarter. The worker keeps the last quarter for <c>COMMIT</c>
    /// and the settings statement, as in every SDK (SM-1633). Each budget is at least 1 ms.
    /// </remarks>
    internal static (string Statement, string Idle) RoundTimeouts(long remainingNanos)
    {
        var quarter = Math.Max(1, remainingNanos / 1_000_000 / 4).ToString(System.Globalization.CultureInfo.InvariantCulture);
        return (quarter, quarter);
    }

    /// <summary>Rolls back the round's transaction. Returns whether the connection is clean again.</summary>
    private bool RolledBack(long deadline)
    {
        if (_connection.FullState != System.Data.ConnectionState.Open)
        {
            return false;
        }

        try
        {
            Execute(SessionCommands.Rollback, deadline);
            return true;
        }
        catch (Exception error) when (error is WorkhorseException or NpgsqlException or IOException or TimeoutException
            or InvalidOperationException or OperationCanceledException)
        {
            return false;
        }
    }

    private void Execute(string text, long deadline)
    {
        using var command = new NpgsqlCommand(text, _connection) { CommandTimeout = TimeoutSeconds(deadline) };
        _cancel = command.Cancel;
        command.ExecuteNonQuery();
    }

    /// <summary>
    /// The driver's command timeout, in whole seconds, one second past the round's deadline. The
    /// heartbeat thread never waits for it: the deadline already ended the wait, and the timeout only
    /// lets an abandoned statement end.
    /// </summary>
    private static int TimeoutSeconds(long deadline) =>
        (int)Math.Min(int.MaxValue, Math.Max(1, (deadline - Monotonic.Now() + 999_999_999) / 1_000_000_000) + 1);

    private sealed class Request(long deadline, SqlCatalogue.Statement statement, NpgsqlParameter[] parameters)
    {
        internal long Deadline { get; } = deadline;

        internal SqlCatalogue.Statement Statement { get; } = statement;

        internal NpgsqlParameter[] Parameters { get; } = parameters;

        internal IReadOnlyList<Row>? Rows { get; set; }

        internal Exception? Error { get; set; }

        internal bool Done { get; set; }
    }
}

/// <summary>
/// A round that reached its deadline before its heartbeat statement, and left the connection clean:
/// it sent nothing, or its <c>ROLLBACK</c> finished before the deadline.
/// </summary>
internal sealed class RoundExpiredException : Exception
{
    public RoundExpiredException() { }

    public RoundExpiredException(string message) : base(message) { }

    public RoundExpiredException(string message, Exception innerException) : base(message, innerException) { }
}

/// <summary>
/// A round that ended at or after its deadline without a lost connection: its <c>COMMIT</c> or its
/// <c>ROLLBACK</c> ended too late, or it got no connection in time. It is a
/// <see cref="TimeoutException"/>, so each existing <c>catch</c> still matches it. The worker's
/// telemetry reads the type to report the round as a <c>timeout</c>.
/// </summary>
internal sealed class RoundDeadlineException : TimeoutException
{
    public RoundDeadlineException() { }

    public RoundDeadlineException(string message) : base(message) { }

    public RoundDeadlineException(string message, Exception innerException) : base(message, innerException) { }
}

/// <summary>The round bound ended while the round's statement still ran, so the connection is lost.</summary>
internal sealed class RoundLostException : Exception
{
    public RoundLostException() : base("The heartbeat round reached its bound while its statement still ran") { }

    public RoundLostException(string message) : base(message) { }

    public RoundLostException(string message, Exception innerException) : base(message, innerException) { }
}
