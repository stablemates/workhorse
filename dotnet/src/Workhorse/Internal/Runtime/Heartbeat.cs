using System.Globalization;
using System.Runtime.CompilerServices;
using System.Text.Json;
using Npgsql;
using Workhorse.Internal.Database;
using Workhorse.Internal.Telemetry;

namespace Workhorse.Internal.Runtime;

/// <summary>
/// Renews the leases of running attempts on a dedicated thread (ADR 0071, ADR 0105, ADR 0107). The
/// counterpart of the JVM's <c>Heartbeat</c>.
/// </summary>
/// <remarks>
/// <para>
/// Every worker on one <see cref="NpgsqlDataSource"/> shares one dedicated heartbeat. The pool
/// identity is the exact data source reference, in a <see cref="ConditionalWeakTable{TKey,TValue}"/>
/// that does not keep the data source alive. That heartbeat holds one connection while a worker
/// holds a <see cref="Reservation"/> or an attempt is registered. A worker with
/// <c>SharedHeartbeats</c> has its own heartbeat, which opens a connection for each round instead.
/// </para>
/// <para>
/// The heartbeat thread schedules the rounds and never does I/O. It hands each round to the thread
/// of the held connection (<see cref="HeldConnection"/>) and waits only until the round bound B.
/// When B ends first, the connection is lost: the heartbeat marks it lost at once, which closes the
/// claim gate of every worker on the data source, and starts a replacement. A checkout task opens
/// each connection with <c>OpenConnectionAsync</c> and a token that B, or the startup budget of a
/// waiting worker, cancels. So the pool's <c>Timeout</c> is never the bound.
/// </para>
/// </remarks>
internal sealed class Heartbeat
{
    /// <summary>The most leases one <c>heartbeat_many_v2</c> call renews.</summary>
    private const int RoundLimit = 100;

    /// <summary>The shortest deadline of a round, when the interval allows it.</summary>
    private const long MinRoundTimeoutMs = 50;

    /// <summary>The longest base delay before a busy retry (ADR 0105).</summary>
    private const long BusyRetryBaseMs = 100;

    /// <summary>The driver's command timeout of a round under shared heartbeats, which has no bound.</summary>
    private const int BorrowedTimeoutSeconds = 30;

    /// <summary>The first wait before a failed checkout runs again. It doubles up to the shortest interval.</summary>
    private static readonly long RetryNanos = Monotonic.Millis(100);

    /// <summary>The longest wait between two checkouts when nothing states an interval.</summary>
    private static readonly long DefaultRetryCapNanos = Monotonic.Millis(1000);

    /// <summary>The longest wait before a waiter checks whether it stops.</summary>
    private static readonly long AwaitSliceNanos = Monotonic.Millis(50);

    /// <summary>
    /// A bounded busy retry with less time than this before its deadline does not run: the time that
    /// a round needs at its settings statement, plus 12 ms (ADR 0105 amendment of 2026-10-20).
    /// </summary>
    internal static readonly long BusyRetryMinNanos = HeldConnection.MinRemainingNanos + Monotonic.Millis(12);

    private static readonly ConditionalWeakTable<NpgsqlDataSource, Heartbeat> Dedicated = [];

    private readonly NpgsqlDataSource _dataSource;
    private readonly bool _dedicated;
    private readonly Func<string, string, IReadOnlyList<Row>>? _fixedRound;

    // Monitor.Wait needs a monitor lock, so this is an object and not a System.Threading.Lock.
    private readonly object _lock = new();
    private readonly OrderedDictionary<(string WorkerId, Guid TaskId), IMember> _members = [];
    private readonly List<Reservation> _reservations = [];
    private Thread? _thread;

    /// <summary>The held connection, or <c>null</c>. It changes under <see cref="_lock"/>.</summary>
    private HeldConnection? _held;

    /// <summary>Mirrors <c>_held != null</c>, so a worker reads it without the lock.</summary>
    private volatile bool _connected;

    /// <summary>Whether the checkout task runs. It changes under <see cref="_lock"/>.</summary>
    private bool _checkingOut;

    /// <summary>The failure of a checkout since the latest installed connection.</summary>
    private Exception? _checkoutFailure;

    // The fields below belong to the heartbeat thread.
    private HeldConnection? _sent;
    private bool _freshConnection;
    private bool _runNow;
    private long _previous;
    private int _rotation;
    private List<IMember>? _busyRetry;
    private long _busyRetryAt;
    private int _connectionsLost;
    private long _busyLeases;
    private bool _roundExpired;

    private Heartbeat(NpgsqlDataSource dataSource, bool dedicated)
    {
        _dataSource = dataSource;
        _dedicated = dedicated;
    }

    /// <summary>
    /// A heartbeat whose statements go to <paramref name="fixedRound"/>, with the worker ID and the
    /// lease payload, instead of PostgreSQL. A test uses it to control what each batch sees. With
    /// <paramref name="dedicated"/>, the rounds follow the rules of the dedicated connection, but the
    /// heartbeat opens no connection.
    /// </summary>
    internal Heartbeat(NpgsqlDataSource dataSource, Func<string, string, IReadOnlyList<Row>> fixedRound, bool dedicated = false)
        : this(dataSource, dedicated) => _fixedRound = fixedRound;

    /// <summary>One running attempt.</summary>
    internal interface IMember
    {
        /// <summary>The worker that owns the attempt.</summary>
        string WorkerId { get; }

        /// <summary>The task.</summary>
        Guid TaskId { get; }

        /// <summary>The fence token of the attempt.</summary>
        long FenceToken { get; }

        /// <summary>The lease that each renewal grants, in milliseconds.</summary>
        int LeaseMs { get; }

        /// <summary>The interval between renewals, in nanoseconds.</summary>
        long IntervalNanos { get; }

        /// <summary>
        /// The end of the attempt's local lease window, a <see cref="Monotonic"/> value. No round
        /// sends a lease whose window has ended (SM-1445).
        /// </summary>
        long LeaseEndsAt { get; }

        /// <summary>Records an accepted round that left at <paramref name="sentAt"/>.</summary>
        void Renew(long sentAt);

        /// <summary>
        /// Acts on a status other than <c>accepted</c>. It must not block. <c>busy</c> renewed
        /// nothing and gave no ownership verdict (ADR 0105).
        /// </summary>
        void Settle(string status);

        /// <summary>Records an error that <see cref="Settle"/> threw.</summary>
        void Fail(Exception error);
    }

    /// <summary>The number of rounds that started. A test reads it to tell one round from the next.</summary>
    internal long RoundsStarted { get; private set; }

    /// <summary>The connection that the latest lost round lost. A test reads it.</summary>
    internal HeldConnection? LastLost { get; private set; }

    /// <summary>The leases that a round reported busy (ADR 0105). A test reads it.</summary>
    internal long BusyLeases => Interlocked.Read(ref _busyLeases);

    /// <summary>The connections that a round lost at its bound. A test reads it.</summary>
    internal int ConnectionsLost { get => Volatile.Read(ref _connectionsLost); private set => Volatile.Write(ref _connectionsLost, value); }

    /// <summary>
    /// The time after the deadline of a lost round at which the heartbeat closed the claim gate,
    /// in nanoseconds, for the latest lost round. A test reads it.
    /// </summary>
    internal long LastLossLateness { get; private set; }

    /// <summary>Whether the heartbeat holds a usable connection: the claim gate of the data source. A test reads it.</summary>
    internal bool Connected => !_dedicated || _connected;

    /// <summary>The heartbeat that every worker on <paramref name="dataSource"/> shares.</summary>
    internal static Heartbeat Shared(NpgsqlDataSource dataSource) =>
        Dedicated.GetValue(dataSource, source => new Heartbeat(source, dedicated: true));

    /// <summary>A heartbeat of one worker that opens a connection for each round.</summary>
    internal static Heartbeat Borrowing(NpgsqlDataSource dataSource) => new(dataSource, dedicated: false);

    /// <summary>
    /// The deadline of one round for the shortest interval: three quarters of it, at least
    /// <c>min(50 ms, interval)</c> and 1 ms, in whole milliseconds. Every SDK uses this formula.
    /// </summary>
    internal static long RoundBoundNanos(long intervalNanos)
    {
        var intervalMs = intervalNanos / 1_000_000;
        return Monotonic.Millis(Math.Max(1, Math.Max(intervalMs * 3 / 4, Math.Min(MinRoundTimeoutMs, intervalMs))));
    }

    /// <summary>The delay before a busy retry: <c>base × (1 + random)</c>, <c>base = min(100 ms, interval / 8)</c>.</summary>
    internal static long BusyRetryDelayNanos(long intervalNanos)
    {
        var @base = Math.Min(Monotonic.Millis(BusyRetryBaseMs), intervalNanos / 8);
        return @base + (long)(@base * Random.Shared.NextDouble());
    }

    /// <summary>
    /// The deadline of a busy retry: the round bound, the next regular slot, and the earliest lease
    /// window end of its members, whichever comes first.
    /// </summary>
    internal static long RetryDeadline(long start, long intervalNanos, long slot, IReadOnlyList<IMember> selection)
    {
        var deadline = start + RoundBoundNanos(intervalNanos);
        if (slot - deadline < 0)
        {
            deadline = slot;
        }

        foreach (var member in selection)
        {
            if (member.LeaseEndsAt - deadline < 0)
            {
                deadline = member.LeaseEndsAt;
            }
        }

        return deadline;
    }

    /// <summary>
    /// Reserves the held connection for a worker. While a reservation is open, a dedicated heartbeat
    /// keeps its connection, and replaces a lost one at once, also when no attempt is registered.
    /// <paramref name="onConnected"/> runs each time a new connection is installed.
    /// </summary>
    internal Reservation Reserve(long intervalNanos, Action onConnected)
    {
        var reservation = new Reservation(this, intervalNanos, onConnected);
        if (!_dedicated)
        {
            return reservation;
        }

        lock (_lock)
        {
            _reservations.Add(reservation);
            StartCheckoutLocked();
            StartThreadLocked();
            Monitor.PulseAll(_lock);
        }

        return reservation;
    }

    /// <summary>Adds <paramref name="member"/>, and returns a handle that removes it. Removing twice is harmless.</summary>
    internal Action Register(IMember member)
    {
        var key = (member.WorkerId, member.TaskId);
        lock (_lock)
        {
            _members[key] = member;
            Monitor.PulseAll(_lock);
            StartThreadLocked();
        }

        return () =>
        {
            lock (_lock)
            {
                if (_members.TryGetValue(key, out var current) && ReferenceEquals(current, member))
                {
                    _members.Remove(key);
                    Monitor.PulseAll(_lock);
                }
            }
        };
    }

    private void StartThreadLocked()
    {
        if (_thread is { IsAlive: true })
        {
            return;
        }

        _thread = new Thread(Run) { IsBackground = true, Name = "workhorse-heartbeats" };
        _thread.Start();
    }

    private bool WantedLocked() => _members.Count > 0 || _reservations.Count > 0;

    /// <summary>The shortest interval of the reservations and the members, or <c>null</c>.</summary>
    private long? ShortestIntervalLocked()
    {
        long? shortest = null;
        foreach (var reservation in _reservations)
        {
            shortest = Math.Min(shortest ?? long.MaxValue, reservation.IntervalNanos);
        }

        foreach (var member in _members.Values)
        {
            shortest = Math.Min(shortest ?? long.MaxValue, member.IntervalNanos);
        }

        return shortest;
    }

    /// <summary>The longest wait between two checkouts: the shortest interval I, also below 100 ms (ADR 0071, rule 6).</summary>
    private long RetryCapLocked() => ShortestIntervalLocked() is { } interval ? Math.Max(Monotonic.Millis(1), interval) : DefaultRetryCapNanos;

    /// <summary>
    /// The bound of one checkout (ADR 0071, rules 3 and 5). While an attempt is registered, a lease
    /// is at stake, so the bound is the round bound B. Without one, a worker that waits in its
    /// startup can give the checkout the rest of its startup budget.
    /// </summary>
    private long AcquisitionBoundLocked()
    {
        var now = Monotonic.Now();
        var bound = RoundBoundNanos(ShortestIntervalLocked() ?? DefaultRetryCapNanos);
        if (_members.Count > 0)
        {
            return Math.Max(bound, Monotonic.Millis(1));
        }

        foreach (var reservation in _reservations)
        {
            if (reservation.StartupDeadline is { } deadline)
            {
                bound = Math.Max(bound, deadline - now);
            }
        }

        return Math.Max(bound, Monotonic.Millis(1));
    }

    /// <summary>Starts the checkout task, unless one runs, a connection is held, or nothing needs one.</summary>
    private void StartCheckoutLocked()
    {
        if (!_dedicated || _fixedRound is not null || _held is not null || _checkingOut || !WantedLocked())
        {
            return;
        }

        _checkingOut = true;
        _ = Task.Run(CheckOutAsync);
    }

    /// <summary>
    /// Opens the held connection, and each replacement. The task is the one owner of each connection
    /// that it gets until the heartbeat installs it. A connection that nothing needs when it arrives,
    /// a late connection, goes back to the pool at once (ADR 0071, rule 7). After an installed
    /// connection goes back, or is lost, the task opens the next one if something still needs it.
    /// </summary>
    private async Task CheckOutAsync()
    {
        var backoff = RetryNanos;
        while (true)
        {
            long bound;
            lock (_lock)
            {
                bound = AcquisitionBoundLocked();
            }

            NpgsqlConnection? connection = null;
            Exception? failure = null;
            using (var timeout = new CancellationTokenSource(Monotonic.Span(bound)))
            {
                try
                {
                    connection = await DataSources.OpenAsync(_dataSource, timeout.Token).ConfigureAwait(false);
                }
                catch (Exception error)
                {
                    failure = error is OperationCanceledException
                        ? new TimeoutException("The heartbeat got no connection within its bound", error)
                        : error;
                }
            }

            HeldConnection? installed = null;
            var wake = new List<Action>();
            lock (_lock)
            {
                if (connection is not null && WantedLocked())
                {
                    installed = new HeldConnection(connection);
                    _held = installed;
                    _connected = true;
                    _checkoutFailure = null;
                    wake.AddRange(_reservations.Select(reservation => reservation.OnConnected));
                }
                else if (connection is null)
                {
                    _checkoutFailure = failure;
                }

                Monitor.PulseAll(_lock);
            }

            if (connection is not null && installed is null)
            {
                await connection.DisposeAsync().ConfigureAwait(false);
            }

            foreach (var callback in wake)
            {
                try
                {
                    callback();
                }
                catch (Exception)
                {
                    // One worker's callback must not keep the others from their wake.
                }
            }

            if (installed is not null)
            {
                await installed.Released.Task.ConfigureAwait(false);
                backoff = RetryNanos;
            }
            else if (connection is null)
            {
                long until;
                lock (_lock)
                {
                    until = Monotonic.Now() + Math.Min(backoff, RetryCapLocked());
                    backoff = Math.Min(backoff * 2, RetryCapLocked());
                }

                while (until - Monotonic.Now() > 0)
                {
                    lock (_lock)
                    {
                        if (!WantedLocked())
                        {
                            break;
                        }
                    }

                    await Task.Delay(Monotonic.Span(Math.Min(AwaitSliceNanos, until - Monotonic.Now()))).ConfigureAwait(false);
                }
            }

            lock (_lock)
            {
                if (!WantedLocked() || _held is not null)
                {
                    _checkingOut = false;
                    return;
                }
            }
        }
    }

    /// <summary>
    /// Waits until a connection is held, or until <paramref name="deadline"/>. The caller holds
    /// <see cref="_lock"/>. Only the heartbeat thread calls it.
    /// </summary>
    private HeldConnection? AwaitHeldLocked(long deadline)
    {
        while (_held is null)
        {
            StartCheckoutLocked();
            var remaining = deadline - Monotonic.Now();
            if (remaining <= 0)
            {
                return null;
            }

            Monitor.Wait(_lock, Monotonic.Span(Math.Min(remaining, AwaitSliceNanos)));
        }

        return _held;
    }

    /// <summary>
    /// Acts on the connection of a failed round. A connection that stays usable stays, because its
    /// rollback ended the round's transaction, so a statement error does not close the claim gate. A
    /// lost or broken connection is dropped, and the checkout task starts the replacement at once.
    /// </summary>
    private void Discard()
    {
        var failed = _sent;
        _sent = null;
        if (failed is null || failed.Usable)
        {
            return;
        }

        lock (_lock)
        {
            if (!ReferenceEquals(_held, failed))
            {
                return;
            }

            _held = null;
            _connected = false;
            Monitor.PulseAll(_lock);
        }

        failed.LetGo();
        lock (_lock)
        {
            // Rule 6 of the ADR 0071 amendment: the replacement starts at once, also without tasks.
            // A checkout task that still waits for the release of the failed connection opens it.
            StartCheckoutLocked();
        }
    }

    /// <summary>
    /// Runs rounds while members are registered. Without members, a dedicated heartbeat keeps its
    /// connection while a reservation is open. The thread ends, and lets the connection go, when no
    /// member and no reservation is left.
    /// </summary>
    private void Run()
    {
        var idle = true;
        while (true)
        {
            lock (_lock)
            {
                while (_members.Count == 0)
                {
                    idle = true;
                    if (_reservations.Count == 0)
                    {
                        if (ReferenceEquals(_thread, Thread.CurrentThread))
                        {
                            _thread = null;
                        }

                        var held = _held;
                        _held = null;
                        _connected = false;
                        Monitor.PulseAll(_lock);
                        held?.LetGo();
                        return;
                    }

                    StartCheckoutLocked();
                    Monitor.Wait(_lock);
                }

                StartCheckoutLocked();
            }

            if (idle)
            {
                // The first member after an idle time starts a new schedule.
                _previous = Monotonic.Now();
                _busyRetry = null;
                idle = false;
            }

            try
            {
                idle = Rounds();
            }
            catch (Exception)
            {
                // An exception never leaves this thread, because that would end the process. The next
                // round waits for its slot, and a dedicated round runs on a replacement connection.
                if (_dedicated)
                {
                    Discard();
                }
            }
        }
    }

    /// <summary>
    /// Runs rounds until no member remains, and returns <c>true</c> then. A regular round falls due
    /// one shortest member interval after the previous regular round started. A round that ends
    /// after its next slot starts one overdue round at once, so missed slots are never replayed.
    /// Between two regular slots, a busy retry sends only the members that the latest round reported
    /// busy (ADR 0105).
    /// </summary>
    private bool Rounds()
    {
        while (true)
        {
            List<IMember> due;
            bool retry;
            long interval = long.MaxValue;
            lock (_lock)
            {
                foreach (var member in _members.Values)
                {
                    interval = Math.Min(interval, member.IntervalNanos);
                }

                if (_members.Count == 0)
                {
                    _busyRetry = null;
                    _runNow = false;
                    return true;
                }

                var now = Monotonic.Now();
                var slot = _previous + interval;
                List<IMember>? selection = null;
                if (!_runNow && _busyRetry is not null && slot - now > 0)
                {
                    if (_busyRetryAt - now > 0)
                    {
                        Monitor.Wait(_lock, Monotonic.Span(Math.Min(_busyRetryAt - now, slot - now)));
                        continue;
                    }

                    selection = TakeBusyRetryLocked(now);
                }

                _busyRetry = null;
                if (selection is { Count: > 0 })
                {
                    due = selection;
                    retry = true;
                }
                else
                {
                    if (!_runNow && slot - now > 0)
                    {
                        Monitor.Wait(_lock, Monotonic.Span(slot - now));
                        continue;
                    }

                    _runNow = false;
                    // A lease whose local window has ended is not renewed (SM-1445). Its watchdog
                    // ends the attempt.
                    due = _members.Values.Where(member => member.LeaseEndsAt - now > 0).ToList();
                    retry = false;
                }
            }

            var start = Monotonic.Now();
            long deadline;
            int first;
            List<Batch> batches;
            if (retry)
            {
                deadline = RetryDeadline(start, interval, _previous + interval, due);
                if (_dedicated && deadline - start < BusyRetryMinNanos)
                {
                    continue;
                }

                batches = Batches(due);
                first = 0;
            }
            else
            {
                _previous = start;
                deadline = start + RoundBoundNanos(interval);
                batches = Batches(due);
                first = NextFirstBatch(batches.Count);
            }

            RoundsStarted++;
            var busy = SendBatches(batches, first, deadline);
            if (_freshConnection)
            {
                // The round waited for a new connection and sent nothing on it. A regular round runs
                // at once on the replacement, with a full bound.
                _freshConnection = false;
                _runNow = true;
                continue;
            }

            if (busy.Count > 0 && !(retry && _roundExpired))
            {
                _busyRetry = busy;
                _busyRetryAt = Monotonic.Now() + BusyRetryDelayNanos(interval);
            }
        }
    }

    private List<IMember> TakeBusyRetryLocked(long now)
    {
        var selection = new List<IMember>();
        foreach (var member in _busyRetry ?? [])
        {
            if (_members.TryGetValue((member.WorkerId, member.TaskId), out var current)
                && ReferenceEquals(current, member)
                && member.LeaseEndsAt - now > 0)
            {
                selection.Add(member);
            }
        }

        return selection;
    }

    private sealed record Batch(string WorkerId, List<IMember> Members);

    /// <summary>The statements of one round: one for each worker and each 100 leases.</summary>
    private static List<Batch> Batches(List<IMember> due)
    {
        var batches = new List<Batch>();
        foreach (var group in due.GroupBy(member => member.WorkerId, StringComparer.Ordinal))
        {
            batches.AddRange(group.Chunk(RoundLimit).Select(chunk => new Batch(group.Key, [.. chunk])));
        }

        return batches;
    }

    /// <summary>The batch that a dedicated round sends first. It moves by one each round.</summary>
    private int NextFirstBatch(int count)
    {
        if (!_dedicated || count == 0)
        {
            return 0;
        }

        var first = ((_rotation % count) + count) % count;
        _rotation = first + 1;
        return first;
    }

    /// <summary>
    /// Sends the batches in order from <paramref name="first"/>, and returns the members that came
    /// back busy. On the dedicated connection, a batch that would start after the deadline is not
    /// sent, a failed batch throws, and a batch that expires before its heartbeat statement ends the
    /// round without a throw. A borrowing round sends every batch and skips a failed one.
    /// <para>
    /// A round that fails before PostgreSQL gives the statuses of a batch adds one to
    /// <c>workhorse.worker.heartbeat.round_failure</c>, at most once for each round. A dedicated round
    /// that reaches its deadline before a batch goes out leaves that batch unrenewed, so it counts as
    /// a <c>timeout</c>, as in the Go, Ruby, and JVM workers.
    /// </para>
    /// </summary>
    private List<IMember> SendBatches(List<Batch> batches, int first, long deadline)
    {
        _roundExpired = false;
        var failed = false;
        var busy = new List<IMember>();
        for (var index = 0; index < batches.Count; index++)
        {
            var batch = batches[(first + index) % batches.Count];
            var sentAt = Monotonic.Now();
            if (_dedicated && deadline - sentAt <= 0)
            {
                // The round reached its deadline, and this batch and the batches after it stay
                // unrenewed. The round counts once, also when an earlier batch already counted.
                if (!failed)
                {
                    failed = true;
                    WorkerTelemetry.HeartbeatRoundReachedDeadline();
                }

                return busy;
            }

            // An earlier batch of this round can take long enough for a member to leave, or for its
            // local lease window to end. Such a lease is not renewed (SM-1445), so each batch reads
            // the members again just before it goes out, and an empty batch is not sent.
            var members = batch.Members.Where(member => Registered(member) && member.LeaseEndsAt - sentAt > 0).ToList();
            if (members.Count == 0)
            {
                continue;
            }

            IReadOnlyList<Row> rows;
            try
            {
                var leases = Leases(members);
                NpgsqlParameter[] parameters = [Parameters.Text(batch.WorkerId), Parameters.Json(leases)];
                rows = _fixedRound is { } fixedRound ? fixedRound(batch.WorkerId, leases)
                    : _dedicated ? SendOnHeld(deadline, parameters)
                    : SendBorrowed(parameters);
            }
            catch (RoundExpiredException error) when (_dedicated)
            {
                _roundExpired = true;
                // A round that got its new connection during its wait sent nothing, and a full round
                // runs on that connection at once. It did not fail.
                if (!_freshConnection)
                {
                    WorkerTelemetry.HeartbeatRoundFailed(error, deadlineReached: true);
                }

                return busy;
            }
            catch (Exception error) when (_dedicated)
            {
                // Only the dedicated round has a deadline that a driver timeout can follow.
                WorkerTelemetry.HeartbeatRoundFailed(error, deadlineReached: Monotonic.Now() - deadline >= 0);
                throw;
            }
            catch (Exception error) when (!_dedicated)
            {
                // A borrowing round sends its other batches, and counts once with its first failure.
                // It has no round deadline, so a driver timeout there is a connection failure.
                if (!failed)
                {
                    failed = true;
                    WorkerTelemetry.HeartbeatRoundFailed(error, deadlineReached: false);
                }

                continue;
            }

            var statuses = new Dictionary<string, string>(StringComparer.Ordinal);
            foreach (var row in rows)
            {
                statuses[row.RequiredText("task_id")] = row.RequiredText("status");
            }

            Settle(members, statuses, sentAt, busy);
        }

        return busy;
    }

    /// <summary>
    /// Sends one statement on the held connection. The wait for a checkout counts against the
    /// round's bound. A round that got its connection only during that wait sends nothing, so the
    /// next round starts on it at once with a full bound.
    /// </summary>
    private IReadOnlyList<Row> SendOnHeld(long deadline, NpgsqlParameter[] parameters)
    {
        HeldConnection? connection;
        bool waited;
        lock (_lock)
        {
            waited = _held is null;
            connection = AwaitHeldLocked(deadline);
        }

        _sent = connection;
        if (connection is null)
        {
            throw new RoundDeadlineException("The heartbeat got no connection before the round's deadline");
        }

        if (waited)
        {
            _freshConnection = true;
            throw new RoundExpiredException("The heartbeat got its new connection during the round");
        }

        try
        {
            return connection.Round(deadline, SqlCatalogue.HeartbeatManyV2, parameters);
        }
        catch (RoundLostException)
        {
            // The claim gate closes now, at the round bound, and does not wait for the statement.
            Discard();
            LastLost = connection;
            LastLossLateness = Monotonic.Now() - deadline;
            ConnectionsLost++;
            throw;
        }
    }

    private IReadOnlyList<Row> SendBorrowed(NpgsqlParameter[] parameters)
    {
        using var connection = DataSources.Open(_dataSource);
        return Sql.Rows(connection, SqlCatalogue.HeartbeatManyV2, parameters, BorrowedTimeoutSeconds);
    }

    private static string Leases(List<IMember> members)
    {
        using var buffer = new MemoryStream();
        using (var writer = new Utf8JsonWriter(buffer))
        {
            writer.WriteStartArray();
            foreach (var member in members)
            {
                writer.WriteStartObject();
                writer.WriteString("taskId", member.TaskId);
                writer.WriteString("fenceToken", member.FenceToken.ToString(CultureInfo.InvariantCulture));
                writer.WriteNumber("leaseMs", member.LeaseMs);
                writer.WriteEndObject();
            }

            writer.WriteEndArray();
        }

        return System.Text.Encoding.UTF8.GetString(buffer.ToArray());
    }

    /// <summary>
    /// Hands each status to its member. A result counts only for the member that the round sent, so
    /// a member that left or was replaced while the round ran gets nothing. Only <c>accepted</c>
    /// renews.
    /// </summary>
    private void Settle(List<IMember> members, Dictionary<string, string> statuses, long sentAt, List<IMember> busy)
    {
        foreach (var member in members)
        {
            if (!Registered(member))
            {
                continue;
            }

            var status = statuses.GetValueOrDefault(member.TaskId.ToString(), "stale");
            if (status == "busy")
            {
                busy.Add(member);
                Interlocked.Increment(ref _busyLeases);
            }

            try
            {
                if (status == "accepted")
                {
                    member.Renew(sentAt);
                }
                else
                {
                    member.Settle(status);
                }
            }
            catch (Exception error)
            {
                member.Fail(error);
            }
        }
    }

    private bool Registered(IMember member)
    {
        lock (_lock)
        {
            return _members.TryGetValue((member.WorkerId, member.TaskId), out var current) && ReferenceEquals(current, member);
        }
    }

    /// <summary>
    /// A worker's hold on the connection of a dedicated heartbeat. Disposing gives it up, and twice
    /// is harmless. When the last hold closes and no attempt is registered, the heartbeat gives the
    /// connection back to the pool.
    /// </summary>
    internal sealed class Reservation : IDisposable
    {
        private readonly Heartbeat _owner;
        private volatile bool _closed;
        private long _startupDeadline = long.MinValue;

        internal Reservation(Heartbeat owner, long intervalNanos, Action onConnected)
        {
            _owner = owner;
            IntervalNanos = intervalNanos;
            OnConnected = onConnected;
        }

        internal long IntervalNanos { get; }

        internal Action OnConnected { get; }

        /// <summary>The end of the startup budget while the worker waits for its first connection.</summary>
        internal long? StartupDeadline
        {
            get
            {
                var deadline = Interlocked.Read(ref _startupDeadline);
                return deadline == long.MinValue ? null : deadline;
            }
        }

        /// <summary>
        /// Whether the heartbeat holds a usable connection now for this open reservation: the claim
        /// gate of ADR 0071, rule 6. A failed renewal on a connection that stays open, and a busy
        /// round, keep it. A lost connection clears it until the replacement arrives.
        /// </summary>
        internal bool Connected => !_closed && (!_owner._dedicated || _owner._connected);

        /// <summary>The failure of a checkout since the heartbeat last installed a connection.</summary>
        internal Exception? LastFailure
        {
            get
            {
                lock (_owner._lock)
                {
                    return _owner._checkoutFailure;
                }
            }
        }

        /// <summary>
        /// Waits until the heartbeat holds its connection, until <paramref name="deadline"/>, or until
        /// <paramref name="stopped"/> is true. A checkout that fails runs again after its backoff.
        /// </summary>
        internal async Task<bool> AwaitAsync(long deadline, Func<bool> stopped)
        {
            if (!_owner._dedicated)
            {
                return true;
            }

            Interlocked.Exchange(ref _startupDeadline, deadline);
            try
            {
                while (true)
                {
                    lock (_owner._lock)
                    {
                        if (_owner._held is not null)
                        {
                            return true;
                        }

                        _owner.StartCheckoutLocked();
                    }

                    var remaining = deadline - Monotonic.Now();
                    if (remaining <= 0 || stopped())
                    {
                        return false;
                    }

                    await Task.Delay(Monotonic.Span(Math.Min(remaining, AwaitSliceNanos))).ConfigureAwait(false);
                }
            }
            finally
            {
                Interlocked.Exchange(ref _startupDeadline, long.MinValue);
            }
        }

        public void Dispose()
        {
            _closed = true;
            lock (_owner._lock)
            {
                if (_owner._reservations.Remove(this))
                {
                    Monitor.PulseAll(_owner._lock);
                }
            }
        }
    }
}
