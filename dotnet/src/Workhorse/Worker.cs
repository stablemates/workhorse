using System.Collections.Concurrent;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using Npgsql;
using Workhorse.Internal;
using Workhorse.Internal.Database;
using Workhorse.Internal.Json;
using Workhorse.Internal.Runtime;

namespace Workhorse;

/// <summary>
/// Claims tasks from PostgreSQL and runs their handlers under renewed leases. The counterpart of
/// Ruby's <c>Worker</c> and the JVM's <c>Worker</c> (ADR 0107, "Worker surface").
/// </summary>
/// <remarks>
/// <para>
/// Each handler runs as a task on the .NET thread pool, started with <see cref="Task.Run(Func{Task})"/>.
/// The slot accounting bounds the claimed tasks at <see cref="Concurrency"/>, and the worker keeps
/// overlapping batched claims in flight (ADR 0076). Every write of an attempt carries its fence
/// token, so an attempt that lost its lease cannot change the task.
/// </para>
/// <para>
/// Every worker on one <see cref="NpgsqlDataSource"/> shares one heartbeat connection and one
/// listener connection (ADR 0071). The heartbeat and the listener each run on a dedicated thread, so
/// handlers that block thread-pool threads cannot delay a lease renewal.
/// </para>
/// <para>
/// <see cref="RunAsync"/> runs until its token is cancelled, and then drains: running handlers can
/// finish within <see cref="WorkerOptions.ShutdownGrace"/>. At that deadline the worker sets
/// <see cref="CancelReason.Shutdown"/>, cancels the remaining tokens, and gives the handlers one
/// unwind window of 250 ms. It then stops renewing their leases, and <see cref="RunAsync"/> throws
/// <see cref="ShutdownIncompleteException"/>. The worker installs no signal handler.
/// </para>
/// </remarks>
public sealed partial class Worker : IAsyncDisposable
{
    private const int MaxConcurrency = 100;
    private const long DefaultPollMs = 250;
    private const long NotificationPollMs = 5_000;
    private const int MinPoolMaxSize = 3;

    private readonly NpgsqlDataSource _dataSource;
    private readonly JsonCodec _codec;
    private readonly ILogger _logger;
    private readonly ReporterFailures _registrationReporter = new();
    private readonly ReporterFailures _notificationReporter = new();
    private readonly string[] _queues;
    private readonly string _queueText;
    private readonly int _refillBatch;
    private readonly int _leaseMs;
    private readonly long _heartbeatMs;
    private readonly long _pollMs;
    private readonly long _notificationPollMs;
    private readonly bool _pollingOnly;
    private readonly long _maintenanceMs;
    private readonly long _routineMs;
    private readonly long _registryMs;
    private readonly string[] _scheduleNamespaces;
    private readonly int _scheduleCatchupLimit;
    private readonly long _shutdownGraceNanos;
    private readonly RetryDelay? _retryDelay;
    private readonly bool _sharedHeartbeats;
    private readonly int? _poolMaxSize;
    private readonly Heartbeat _heartbeat;
    private readonly string _hostname = Environment.MachineName;
    private readonly Dictionary<string, Registration> _handlers = new(StringComparer.Ordinal);
    private readonly SemaphoreSlim _runGate = new(1, 1);
    private readonly ConcurrentDictionary<Active, byte> _active = new();
    private readonly Wake _wake = new();
    private volatile bool _frozen;
    private volatile bool _locallyPaused;
    private volatile bool _remotelyPaused;
    private int _runs;
    private long _stopVersion;
    private long _stopDeadline = Never;

    /// <summary>
    /// Creates a worker that claims through <paramref name="dataSource"/>. The worker copies and
    /// validates <paramref name="options"/>.
    /// </summary>
    /// <exception cref="ArgumentException">An option is out of its range, the data source multiplexes,
    /// or its pool is smaller than 3 without <see cref="WorkerOptions.SharedHeartbeats"/>.</exception>
    /// <exception cref="InvalidOperationException">The process turned on the Npgsql legacy timestamp
    /// switch.</exception>
    public Worker(NpgsqlDataSource dataSource, WorkerOptions options)
    {
        ArgumentNullException.ThrowIfNull(options);
        _dataSource = DataSources.Require(dataSource, nameof(dataSource));
        _queues = UniqueNames(options.Queues, nameof(options.Queues), allowEmpty: false);
        _queueText = string.Join(',', _queues);
        WorkerId = options.WorkerId ?? $"{Environment.MachineName}-{Environment.ProcessId}-{Convert.ToHexStringLower(Guid.NewGuid().ToByteArray()[..4])}";
        if (WorkerId.Length == 0)
        {
            throw new ArgumentException("WorkerId must be a non-empty string", nameof(options));
        }

        if (options.Concurrency is < 1 or > MaxConcurrency)
        {
            throw new ArgumentOutOfRangeException(nameof(options), "Concurrency must be between 1 and 100");
        }

        Concurrency = options.Concurrency;
        // A claim waits for a quarter of the slots, so at most four claims are in flight.
        _refillBatch = (Concurrency + 3) / 4;
        if (options.Cohorts != 0 && (options.Cohorts < 1 || options.Cohorts > Concurrency))
        {
            throw new ArgumentOutOfRangeException(nameof(options), "Cohorts must be between 1 and Concurrency");
        }

        _leaseMs = (int)Values.Milliseconds(options.Lease, nameof(options.Lease), 100, 86_400_000);
        _heartbeatMs = options.Heartbeat is { } heartbeat
            ? Values.Milliseconds(heartbeat, nameof(options.Heartbeat), 1, int.MaxValue)
            : Math.Max(100, _leaseMs / 3);
        if (_heartbeatMs >= _leaseMs)
        {
            throw new ArgumentOutOfRangeException(nameof(options), "Heartbeat must be positive and less than Lease");
        }

        var poll = options.PollInterval is { } interval ? Values.Milliseconds(interval, nameof(options.PollInterval), 1, int.MaxValue) : (long?)null;
        _pollMs = poll ?? DefaultPollMs;
        _notificationPollMs = poll ?? NotificationPollMs;
        _pollingOnly = options.PollingOnly;
        _maintenanceMs = Values.Milliseconds(options.MaintenanceInterval, nameof(options.MaintenanceInterval), 100, int.MaxValue);
        _routineMs = Values.Milliseconds(options.MaintenanceRoutineInterval, nameof(options.MaintenanceRoutineInterval), 100, int.MaxValue);
        var registry = Values.Milliseconds(options.RegistryInterval, nameof(options.RegistryInterval), 100, int.MaxValue);
        _registryMs = options.DisableRegistry ? 0 : registry;
        _scheduleNamespaces = UniqueNames(options.ScheduleNamespaces, nameof(options.ScheduleNamespaces), allowEmpty: true);
        if (options.ScheduleCatchupLimit is < 1 or > 10_000)
        {
            throw new ArgumentOutOfRangeException(nameof(options), "ScheduleCatchupLimit must be between 1 and 10000");
        }

        _scheduleCatchupLimit = options.ScheduleCatchupLimit;
        _shutdownGraceNanos = Monotonic.Millis(Values.Milliseconds(options.ShutdownGrace, nameof(options.ShutdownGrace), 0, 86_400_000));
        _retryDelay = options.RetryDelay;
        _sharedHeartbeats = options.SharedHeartbeats;
        _codec = new JsonCodec(options.Json);
        _logger = (options.LoggerFactory ?? NullLoggerFactory.Instance).CreateLogger<Worker>();

        // The data source reports its pool size, so rule 4 of the ADR 0071 amendment applies at
        // construction. Without pooling the size is unknown, and the readiness check is the check.
        var connection = new NpgsqlConnectionStringBuilder(_dataSource.ConnectionString);
        _poolMaxSize = connection.Pooling ? connection.MaxPoolSize : null;
        if (!_sharedHeartbeats && _poolMaxSize < MinPoolMaxSize)
        {
            throw new ArgumentException(
                $"The worker's pool must hold at least {MinPoolMaxSize} connections (found Max Pool Size={_poolMaxSize}): "
                + "the listener, the heartbeat, and one for each statement. Set SharedHeartbeats to opt out.",
                nameof(dataSource));
        }

        // The default cohorts need the pool size, so the worker chooses them after it reads the size.
        Cohorts = options.Cohorts == 0 ? DefaultCohorts(Concurrency, SpareConnections()) : options.Cohorts;
        _heartbeat = _sharedHeartbeats ? Heartbeat.Borrowing(_dataSource) : Heartbeat.Shared(_dataSource);
    }

    /// <summary>
    /// Reports a failed worker registry write. The worker keeps running, and the next write tries
    /// again. A handler that throws does not stop the worker.
    /// </summary>
    public event EventHandler<Exception>? RegistrationError;

    /// <summary>
    /// Reports a failure of the notification listener. The worker polls until the listener listens
    /// again. A handler that throws does not stop the worker.
    /// </summary>
    public event EventHandler<Exception>? NotificationError;

    /// <summary>The worker's ID in the fleet registry.</summary>
    public string WorkerId { get; }

    /// <summary>The queues that the worker claims from, in claim order.</summary>
    public IReadOnlyList<string> Queues => _queues;

    /// <summary>The most tasks that the worker runs at once.</summary>
    public int Concurrency { get; }

    /// <summary>The number of slot cohorts for the fast task tier.</summary>
    public int Cohorts { get; }

    /// <summary>Whether this worker or an operator paused it.</summary>
    public bool IsPaused => _locallyPaused || _remotelyPaused;

    /// <summary>
    /// Whether a run is in progress: from the start of <see cref="RunAsync"/> or
    /// <see cref="RunOnceAsync"/> until it returns or throws, including the drain.
    /// </summary>
    public bool IsRunning => Volatile.Read(ref _runs) > 0;

    /// <summary>
    /// Registers the handler of <paramref name="taskType"/>. Registering a task type again replaces
    /// its handler.
    /// </summary>
    /// <exception cref="InvalidOperationException">The worker has already run.</exception>
    public void Handle<TPayload, TResult>(string taskType, Func<HandlerContext, TPayload, Task<TResult>> handler)
    {
        ArgumentNullException.ThrowIfNull(handler);
        Register(taskType, async (context, payload) => await handler(context, Decode<TPayload>(payload)).ConfigureAwait(false));
    }

    /// <summary>Registers a handler of <paramref name="taskType"/> whose result is the JSON value <c>null</c>.</summary>
    /// <exception cref="InvalidOperationException">The worker has already run.</exception>
    public void Handle<TPayload>(string taskType, Func<HandlerContext, TPayload, Task> handler)
    {
        ArgumentNullException.ThrowIfNull(handler);
        Register(taskType, async (context, payload) =>
        {
            await handler(context, Decode<TPayload>(payload)).ConfigureAwait(false);
            return null;
        });
    }

    /// <summary>Registers <paramref name="handler"/> for its <see cref="ITaskHandler{TPayload}.TaskType"/>.</summary>
    /// <exception cref="InvalidOperationException">The worker has already run.</exception>
    public void Handle<TPayload>(ITaskHandler<TPayload> handler)
    {
        ArgumentNullException.ThrowIfNull(handler);
        Register(handler.TaskType, (context, payload) => handler.HandleAsync(context, Decode<TPayload>(payload)));
    }

    /// <summary>
    /// Claims and runs tasks until <paramref name="stoppingToken"/> is cancelled, then drains. A
    /// <c>BackgroundService</c> can hold this call. No handler exception leaves it.
    /// </summary>
    /// <exception cref="ShutdownIncompleteException">Handlers still ran after the drain.</exception>
    /// <exception cref="WorkerStartupException">The worker got no heartbeat connection, or no ordinary
    /// connection for its readiness check, within its startup budget (ADR 0071).</exception>
    /// <exception cref="WorkhorseException">A maintenance pass failed (ADR 0078), the schema is not
    /// compatible, or a claim or a settlement failed in PostgreSQL. The run drains first.</exception>
    /// <exception cref="InvalidOperationException">The worker already runs.</exception>
    public async Task RunAsync(CancellationToken stoppingToken)
    {
        var version = Interlocked.Read(ref _stopVersion);
        await EnterRunAsync().ConfigureAwait(false);
        try
        {
            await using var stop = stoppingToken.Register(Stop).ConfigureAwait(false);
            await RunLoopAsync(continuous: true, version).ConfigureAwait(false);
        }
        finally
        {
            ExitRun();
        }
    }

    /// <summary>
    /// Claims and runs tasks until a claim finds no handled task, then drains. It opens no listener
    /// and runs maintenance before it claims.
    /// </summary>
    /// <returns>Whether a handled task ran.</returns>
    /// <exception cref="InvalidOperationException">The worker already runs.</exception>
    public async Task<bool> RunOnceAsync(CancellationToken cancellationToken = default)
    {
        var version = Interlocked.Read(ref _stopVersion);
        await EnterRunAsync().ConfigureAwait(false);
        try
        {
            await using var stop = cancellationToken.Register(Stop).ConfigureAwait(false);
            return await RunLoopAsync(continuous: false, version).ConfigureAwait(false);
        }
        finally
        {
            ExitRun();
        }
    }

    /// <summary>Starts no claim until <see cref="Resume"/>. Running handlers continue.</summary>
    public void Pause()
    {
        _locallyPaused = true;
        WorkerLog.Paused(_logger, "locally", _queueText);
        _wake.Bump();
    }

    /// <summary>Ends a local pause. An operator's remote pause stays.</summary>
    public void Resume()
    {
        _locallyPaused = false;
        WorkerLog.Resumed(_logger, "locally", _queueText);
        _wake.Bump();
    }

    /// <summary>Stops the worker, and waits for a run in progress to drain. It never throws the run's error.</summary>
    public async ValueTask DisposeAsync()
    {
        Stop();
        await _runGate.WaitAsync().ConfigureAwait(false);
        _runGate.Release();
    }

    /// <summary>Ends claiming. A run in progress drains its handlers and returns.</summary>
    internal void Stop()
    {
        Interlocked.CompareExchange(ref _stopDeadline, Monotonic.Now() + _shutdownGraceNanos, Never);
        Interlocked.Increment(ref _stopVersion);
        WorkerLog.StopRequested(_logger, _queueText);
        _wake.Bump();
    }

    /// <summary>
    /// The cohorts of a worker without the option (ADR 0076): one below concurrency 8, and otherwise
    /// one for each 8 slots, from 2 to 8. With a known pool size, the count is then capped at the
    /// spare connections, and never below 1. Without one, the count is not capped.
    /// </summary>
    internal static int DefaultCohorts(int concurrency, int? spareConnections)
    {
        var cohorts = concurrency < 8 ? 1 : Math.Clamp((concurrency + 7) / 8, 2, 8);
        return spareConnections is { } spare ? Math.Clamp(spare, 1, cohorts) : cohorts;
    }

    /// <summary>
    /// The pooled connections that stay for cohorts after the listener and the heartbeat connection
    /// take theirs. Without pooling, the size is unknown, so the result is <c>null</c> (SM-1758).
    /// </summary>
    private int? SpareConnections()
    {
        var listens = !_pollingOnly && PoolLendsListener();
        return _poolMaxSize - (listens ? 1 : 0) - (_sharedHeartbeats ? 0 : 1);
    }

    private async Task EnterRunAsync()
    {
        if (!await _runGate.WaitAsync(0).ConfigureAwait(false))
        {
            throw new InvalidOperationException("The worker already runs");
        }

        _frozen = true;
        Interlocked.Increment(ref _runs);
    }

    private void ExitRun()
    {
        Interlocked.Decrement(ref _runs);
        _runGate.Release();
    }

    private void Register(string taskType, Func<HandlerContext, string, Task<object?>> invoke, BatchCoordinator? batch = null)
    {
        if (string.IsNullOrEmpty(taskType))
        {
            throw new ArgumentException("The task type must be a non-empty string", nameof(taskType));
        }

        lock (_handlers)
        {
            if (_frozen)
            {
                throw new InvalidOperationException("A handler registers before the worker's first run");
            }

            _handlers[taskType] = new Registration(invoke, batch);
        }
    }

    private TPayload Decode<TPayload>(string payload) => _codec.Deserialize<TPayload>(payload)!;

    private static string[] UniqueNames(IList<string>? names, string label, bool allowEmpty)
    {
        if (names is null || (!allowEmpty && names.Count == 0) || names.Any(string.IsNullOrEmpty))
        {
            throw new ArgumentException($"{label} must contain only non-empty names", label);
        }

        return [.. names.Distinct(StringComparer.Ordinal)];
    }

    /// <summary>A handler, and the coordinator of a batch handler.</summary>
    private sealed record Registration(Func<HandlerContext, string, Task<object?>> Invoke, BatchCoordinator? Batch);

    private void OnRegistrationError(Exception error) =>
        CallReporter(RegistrationError, "registration_error", _registrationReporter, error);

    private void OnNotificationError(Exception error)
    {
        WorkerLog.NotificationFailed(_logger, error);
        CallReporter(NotificationError, "notification_error", _notificationReporter, error);
    }

    /// <summary>
    /// Raises a reporter event so that a handler that throws never stops the worker. A reporter
    /// observes the worker. It is not part of the dispatch contract. The log is the diagnostic path,
    /// so the worker never raises the event again for the failure of its handler.
    /// </summary>
    private void CallReporter(EventHandler<Exception>? reporter, string value, ReporterFailures failures, Exception error)
    {
        try
        {
            reporter?.Invoke(this, error);
        }
        catch (Exception failure)
        {
            var suppressed = failures.Admit(Monotonic.Now());
            if (suppressed < 0)
            {
                return;
            }

            try
            {
                // The record names the error type only, because the message can hold application data.
                WorkerLog.ReporterFailed(_logger, WorkerId, value, failure.GetType().FullName ?? failure.GetType().Name, suppressed);
            }
            catch (Exception)
            {
                // A logger can throw. The diagnostic path must not become a second failure.
            }
        }
    }

    // The members below exist for tests.

    /// <summary>The shared heartbeat of this worker.</summary>
    internal Heartbeat HeartbeatForTests => _heartbeat;

    /// <summary>The SDK language and version that the registry receives.</summary>
    internal static (string Language, string? Version) RegistrySdk => (SdkVersion.Language, SdkVersion.Current);
}
