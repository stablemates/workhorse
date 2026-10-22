using System.Runtime.CompilerServices;
using Npgsql;
using Workhorse.Internal.Database;

namespace Workhorse.Internal.Runtime;

/// <summary>
/// The one <c>LISTEN</c> connection that every worker on one <see cref="NpgsqlDataSource"/> shares
/// (ADR 0071 amendment of 2026-10-21, ADR 0107). It runs on a dedicated thread with the synchronous
/// Npgsql API. Polling stays the correctness mechanism, so the listener is best effort.
/// </summary>
/// <remarks>
/// <para>
/// Npgsql reads a notification only during a query or a wait, and its <c>Keepalive</c> setting
/// belongs to the caller's connection string. So the listener sends its own keepalive (ADR 0107,
/// "The listener sends its own keepalive"):
/// </para>
/// <list type="number">
/// <item>It waits with <see cref="NpgsqlConnection.Wait(TimeSpan)"/> in short slices, so a stop ends
/// the wait soon.</item>
/// <item>After one quiet poll interval, it runs <c>SELECT 1</c>, bounded by the poll interval.</item>
/// <item>If a wait or a query fails, or the keepalive passes its bound, the listener gives up the
/// connection, reports one error, and connects again with backoff. The workers poll meanwhile.</item>
/// <item>After it connects again, it runs <c>LISTEN</c> again and wakes every worker once, because
/// a notification can be lost during the gap.</item>
/// </list>
/// <para>
/// A keepalive that passes its bound does not hold the next connection: a new thread serves it. A
/// cleanup task calls <see cref="NpgsqlCommand.Cancel"/>, and the old thread disposes of its
/// connection when the statement ends. Nothing waits for either.
/// </para>
/// </remarks>
[System.Diagnostics.CodeAnalysis.SuppressMessage("Design", "CA1001", Justification = "The listener lives as long as its data source, and a running pass can still read a replaced source. The sources hold no timer.")]
internal sealed class Listener
{
    private static readonly TimeSpan WaitSlice = TimeSpan.FromMilliseconds(100);
    private static readonly long InitialReconnectNanos = Monotonic.Millis(100);
    private static readonly long MaxReconnectNanos = Monotonic.Millis(5000);
    private static readonly ConditionalWeakTable<NpgsqlDataSource, Listener> SharedListeners = [];

    private readonly NpgsqlDataSource _dataSource;
    private readonly object _lock = new();
    private readonly List<Subscription> _subscribers = [];
    private Thread? _thread;

    /// <summary>Completes when the pass of the current generation has ended and given back its connection.</summary>
    private TaskCompletionSource _passEnded = new(TaskCreationOptions.RunContinuationsAsynchronously);
    private CancellationTokenSource _stop = new();

    /// <summary>
    /// Moves on when a keepalive passes its bound. A thread of an older generation ends without a
    /// change to the listener's state.
    /// </summary>
    private int _generation;

    private volatile bool _listening;
    private volatile bool _holding;

    private Listener(NpgsqlDataSource dataSource) => _dataSource = dataSource;

    /// <summary>The keepalives that passed their bound. A test reads it.</summary>
    internal int KeepalivesLost { get; private set; }

    /// <summary>The listener that every worker on <paramref name="dataSource"/> shares.</summary>
    internal static Listener Shared(NpgsqlDataSource dataSource) => SharedListeners.GetValue(dataSource, source => new Listener(source));

    /// <summary>
    /// Subscribes a worker. <paramref name="onWake"/> runs for a notification of one of
    /// <paramref name="queues"/>, and for every worker after each <c>LISTEN</c>.
    /// <paramref name="pollIntervalNanos"/> bounds the keepalive; the listener uses the shortest.
    /// </summary>
    internal Subscription Subscribe(IReadOnlyList<string> queues, Action onWake, Action<Exception> onError, long pollIntervalNanos)
    {
        var subscription = new Subscription(this, queues, onWake, onError, pollIntervalNanos);
        lock (_lock)
        {
            _subscribers.Add(subscription);
            // A pass that the last subscriber stopped can still run, so a new subscriber gets a new
            // stop signal, which that pass reads on its next loop.
            if (_stop.IsCancellationRequested)
            {
                _stop = new CancellationTokenSource();
            }

            if (_thread is not { IsAlive: true })
            {
                StartThreadLocked();
            }
        }

        return subscription;
    }

    private void StartThreadLocked()
    {
        var generation = _generation;
        var ended = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        _passEnded = ended;
        _thread = new Thread(() =>
        {
            try
            {
                Run(generation);
            }
            finally
            {
                ended.TrySetResult();
            }
        })
        { IsBackground = true, Name = "workhorse-listener" };
        _thread.Start();
    }

    private bool CurrentLocked(int generation) => generation == _generation && _subscribers.Count > 0;

    private bool Current(int generation)
    {
        lock (_lock)
        {
            return CurrentLocked(generation);
        }
    }

    private void Run(int generation)
    {
        var backoff = InitialReconnectNanos;
        while (true)
        {
            CancellationToken stop;
            lock (_lock)
            {
                stop = _stop.Token;
                if (!CurrentLocked(generation))
                {
                    if (generation == _generation && ReferenceEquals(_thread, Thread.CurrentThread))
                    {
                        _thread = null;
                    }

                    return;
                }
            }

            NpgsqlConnection? connection = null;
            try
            {
                connection = DataSources.OpenAsync(_dataSource, stop).GetAwaiter().GetResult();
                if (!Current(generation))
                {
                    // A late connection: nothing needs it now, so this thread, its one owner, gives it back.
                    connection.Dispose();
                    connection = null;
                    continue;
                }

                if (!Publish(generation, holding: true, listening: false))
                {
                    continue;
                }
                if (Listen(connection, generation))
                {
                    backoff = InitialReconnectNanos;
                }
            }
            catch (Exception error)
            {
                if (Current(generation))
                {
                    Report(error);
                    WakeAll();
                }
            }
            finally
            {
                // A connection whose keepalive passed its bound had its statement cancelled by the
                // cleanup. This thread, its one owner, disposes of it now that the statement ended.
                connection?.Dispose();
                lock (_lock)
                {
                    if (generation == _generation)
                    {
                        _listening = false;
                        _holding = false;
                    }
                }
            }

            if (!Current(generation))
            {
                continue;
            }

            var jittered = (long)(backoff * (0.9 + (0.2 * Random.Shared.NextDouble())));
            stop.WaitHandle.WaitOne(Monotonic.Span(jittered));
            backoff = Math.Min(backoff * 2, MaxReconnectNanos);
        }
    }

    /// <summary>
    /// Listens on <paramref name="connection"/> until this generation ends. Returns whether
    /// <c>LISTEN</c> succeeded.
    /// </summary>
    private bool Listen(NpgsqlConnection connection, int generation)
    {
        connection.Notification += (_, notification) => WakeMatching(notification.Payload);
        if (!Bounded(connection, SessionCommands.Listen, generation))
        {
            return false;
        }

        // A pass that the last subscriber retired meanwhile publishes nothing and wakes nobody.
        if (!Publish(generation, holding: true, listening: true))
        {
            return true;
        }

        WakeAll();
        var quietSince = Monotonic.Now();
        while (Current(generation))
        {
            if (connection.Wait(WaitSlice))
            {
                quietSince = Monotonic.Now();
                continue;
            }

            if (Monotonic.Now() - quietSince >= PollIntervalNanos())
            {
                if (!Bounded(connection, SessionCommands.Keepalive, generation))
                {
                    return true;
                }

                quietSince = Monotonic.Now();
            }
        }

        // A retired pass still ends its own subscription before its connection goes back.
        if (generation == Volatile.Read(ref _generation))
        {
            _listening = false;
        }

        Bounded(connection, SessionCommands.Unlisten, generation, unlisten: true);
        return true;
    }

    /// <summary>
    /// Sets the published state of the listener, but only for the current generation, in one locked
    /// step with the check. Returns whether <paramref name="generation"/> is still current.
    /// </summary>
    private bool Publish(int generation, bool holding, bool listening)
    {
        lock (_lock)
        {
            if (!CurrentLocked(generation))
            {
                return false;
            }

            _holding = holding;
            _listening = listening;
            return true;
        }
    }

    /// <summary>
    /// Runs <paramref name="text"/> with the poll interval as its bound. If the bound ends first, a
    /// new generation takes over and the workers poll until it listens. Returns whether the statement
    /// ended in time.
    /// </summary>
    private bool Bounded(NpgsqlConnection connection, string text, int generation, bool unlisten = false)
    {
        using var command = new NpgsqlCommand(text, connection)
        {
            CommandTimeout = (int)Math.Clamp((PollIntervalNanos() / 1_000_000_000) + 2, 1, int.MaxValue),
        };
        var done = 0;
        using var bound = new Timer(
            _ =>
            {
                if (Interlocked.CompareExchange(ref done, 1, 0) == 0)
                {
                    Abandon(generation, command, unlisten);
                }
            },
            null,
            Monotonic.Span(PollIntervalNanos()),
            Timeout.InfiniteTimeSpan);
        try
        {
            command.ExecuteNonQuery();
        }
        catch (OperationCanceledException) when (Volatile.Read(ref done) == 1)
        {
            // The cleanup cancelled the statement after its bound.
            return false;
        }

        return Interlocked.CompareExchange(ref done, 1, 0) == 0;
    }

    /// <summary>Gives up the generation whose statement passed its bound, and starts the next one.</summary>
    private void Abandon(int generation, NpgsqlCommand command, bool unlisten)
    {
        lock (_lock)
        {
            if (!unlisten && generation != _generation)
            {
                return;
            }

            if (!unlisten)
            {
                KeepalivesLost++;
                _generation++;
                _listening = false;
                _holding = false;
                if (_subscribers.Count > 0)
                {
                    StartThreadLocked();
                }
            }
        }

        if (!unlisten)
        {
            Report(new TimeoutException("The listener's keepalive did not end within its poll interval"));
            WakeAll();
        }

        _ = Task.Run(() =>
        {
            try
            {
                command.Cancel();
            }
            catch (Exception)
            {
                // The statement ends with its command timeout, and the thread disposes of the connection.
            }
        });
    }

    private long PollIntervalNanos()
    {
        lock (_lock)
        {
            return _subscribers.Count == 0 ? MaxReconnectNanos : _subscribers.Min(subscriber => subscriber.PollIntervalNanos);
        }
    }

    private Subscription[] Subscribers()
    {
        lock (_lock)
        {
            return [.. _subscribers];
        }
    }

    private void WakeMatching(string payload)
    {
        foreach (var subscriber in Subscribers())
        {
            if (payload == "*" || subscriber.Queues.Contains(payload))
            {
                Run(subscriber.OnWake);
            }
        }
    }

    private void WakeAll()
    {
        foreach (var subscriber in Subscribers())
        {
            Run(subscriber.OnWake);
        }
    }

    private void Report(Exception error)
    {
        foreach (var subscriber in Subscribers())
        {
            try
            {
                subscriber.OnError(error);
            }
            catch (Exception)
            {
                // A callback that throws must not end the listener, or keep another subscriber's report.
            }
        }
    }

    private static void Run(Action callback)
    {
        try
        {
            callback();
        }
        catch (Exception)
        {
            // A callback that throws must not end the listener, or keep another subscriber's wake.
        }
    }

    /// <summary>One worker's use of the listener. Closing it twice is harmless.</summary>
    internal sealed class Subscription
    {
        private readonly Listener _owner;

        internal Subscription(Listener owner, IReadOnlyList<string> queues, Action onWake, Action<Exception> onError, long pollIntervalNanos)
        {
            _owner = owner;
            Queues = queues;
            OnWake = onWake;
            OnError = onError;
            PollIntervalNanos = pollIntervalNanos;
        }

        internal IReadOnlyList<string> Queues { get; }

        internal Action OnWake { get; }

        internal Action<Exception> OnError { get; }

        internal long PollIntervalNanos { get; }

        /// <summary>Whether the listener runs <c>LISTEN</c> on a live connection now.</summary>
        internal bool IsListening => _owner._listening;

        /// <summary>Whether the listener holds its connection, from the checkout until it goes back.</summary>
        internal bool HoldsConnection => _owner._holding;

        /// <summary>
        /// Ends the subscription. When it was the last one, the listener gives its connection back,
        /// and this call waits for that until <paramref name="deadline"/>.
        /// </summary>
        internal async Task CloseAsync(long deadline)
        {
            Task? ended = null;
            lock (_owner._lock)
            {
                if (_owner._subscribers.Remove(this) && _owner._subscribers.Count == 0)
                {
                    // The last subscriber retires the generation at once, so a new subscriber starts
                    // a new pass even while this one still waits for its UNLISTEN.
                    _owner._stop.Cancel();
                    ended = _owner._passEnded.Task;
                    _owner._generation++;
                    _owner._thread = null;
                    _owner._listening = false;
                    _owner._holding = false;
                }
            }

            var remaining = deadline - Monotonic.Now();
            if (ended is not null && remaining > 0)
            {
                await ended.WaitAsync(Monotonic.Span(remaining)).ConfigureAwait(ConfigureAwaitOptions.SuppressThrowing);
            }
        }
    }
}
