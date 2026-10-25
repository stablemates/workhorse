using System.Diagnostics;
using System.Net.Sockets;
using System.Runtime.CompilerServices;
using System.Text.Json;
using Npgsql;
using Workhorse.Internal.Database;
using Workhorse.Internal.Runtime;
using static Workhorse.Internal.Telemetry.Instrumentation;

namespace Workhorse.Internal.Telemetry;

/// <summary>
/// The worker's spans and metrics, with the names, attributes, and outcome values of the JVM worker
/// (<c>run.workhorse.internal.telemetry.WorkerTelemetry</c>). Each method wraps one worker step, so
/// the worker calls it in one statement.
/// </summary>
internal static class WorkerTelemetry
{
    /// <summary>The error type of a task that redacts its error details, as the JVM names it.</summary>
    internal const string RedactedErrorType = "RedactedTaskError";

    // The telemetry of each attempt, so that a lease expiration that a heartbeat settlement records
    // on another thread parents its retry span on the handler span. A settlement can run after the
    // handler finishes, so an entry lives as long as its claimed task, which each settlement holds.
    // The table holds its keys weakly and compares them by reference.
    private static readonly ConditionalWeakTable<ClaimedTask, Attempt> Attempts = [];

    /// <summary>
    /// The bounded <c>workhorse.handler.outcome</c> of a worker outcome, as the handler metrics name
    /// it.
    /// </summary>
    internal static string MetricOutcome(Outcome? outcome) => outcome switch
    {
        Outcome.Completed => "succeeded",
        Outcome.Failed => "failed",
        Outcome.Retry => "retry",
        Outcome.LeaseExpired => "lease_lost",
        Outcome.Released => "released",
        Outcome.DeadlineExceeded => "deadline_exceeded",
        Outcome.AttemptTimeout => "timeout",
        Outcome.Cancelled => "canceled",
        Outcome.SuspendedForWait or Outcome.SuspendedForChild => "suspended",
        _ => "unknown",
    };

    /// <summary>The span outcome of a worker outcome. Two differ from the metric outcome.</summary>
    private static string SpanOutcome(Outcome? outcome) => outcome switch
    {
        Outcome.LeaseExpired => "stale",
        Outcome.AttemptTimeout => "timeout_exceeded",
        _ => MetricOutcome(outcome),
    };

    /// <summary>Starts the <c>workhorse.claim</c> span of one claim from <paramref name="queue"/>.</summary>
    internal static Activity? StartClaim(string queue)
    {
        var span = StartSpan(Names.SpanClaim);
        span?.SetTag(Names.QueueName, queue);
        return span;
    }

    /// <summary>
    /// Records one claim from <paramref name="queue"/> that PostgreSQL answered: its duration from
    /// <paramref name="startedAt"/>, each claimed task, and on the claim span the first task and, for
    /// a full-tier claim, the tier. The claim's tasks are the entries of <paramref name="claimed"/>
    /// from <paramref name="first"/> on.
    /// </summary>
    internal static void Claimed<T>(Activity? span, string queue, long startedAt, IReadOnlyList<T> claimed, int first, Func<T, ClaimedTask> task, bool fullTier)
    {
        var count = claimed.Count - first;
        if (ClaimDuration.Enabled)
        {
            ClaimDuration.Record(
                MillisSince(startedAt),
                new KeyValuePair<string, object?>(Names.QueueName, queue),
                new KeyValuePair<string, object?>(Names.ClaimResult, count == 0 ? "empty" : "claimed"));
        }

        if (TasksClaimed.Enabled)
        {
            for (var index = first; index < claimed.Count; index++)
            {
                var claimedTask = task(claimed[index]);
                TasksClaimed.Add(1, Metric(claimedTask.Queue, claimedTask.Type));
            }
        }

        if (span is not { IsAllDataRequested: true })
        {
            return;
        }

        if (fullTier)
        {
            span.SetTag(Names.QueueTier, "full");
        }

        if (count > 0)
        {
            SetTask(span, task(claimed[first]));
        }
    }

    /// <summary>
    /// Records one batch handler invocation as it starts: its size and how long its first member
    /// waited. Each member keeps its own handler span.
    /// </summary>
    internal static void Batch(string taskType, IReadOnlyList<ClaimedTask> tasks, bool full, long lingerMs)
    {
        if (!HandlerBatchSize.Enabled && !HandlerBatchLinger.Enabled)
        {
            return;
        }

        var tags = Metric(tasks[0].Queue, taskType);
        tags.Add(Names.HandlerBatchFull, full);
        HandlerBatchSize.Record(tasks.Count, tags);
        HandlerBatchLinger.Record(lingerMs, tags);
    }

    /// <summary>
    /// Starts the consumer <c>workhorse.handler</c> span of one attempt, or returns <c>null</c> when
    /// nothing listens. Its parent is the trace context that the enqueue stored. A task without one
    /// starts a new trace, because an activity that is current where the worker runs is unrelated to
    /// the task. The span is current until <see cref="Attempt.Finish"/>.
    /// </summary>
    internal static Attempt? StartAttempt(ClaimedTask task)
    {
        if (!Source.HasListeners() && !HandlerDuration.Enabled && !HandlerRuntime.Enabled && !HandlerExecutions.Enabled)
        {
            return null;
        }

        var parent = ExtractTraceContext(task.TraceContext);
        if (parent == default)
        {
            Activity.Current = null;
        }

        var span = Source.StartActivity(Names.SpanHandler, ActivityKind.Consumer, parent);
        if (span is { IsAllDataRequested: true })
        {
            SetTask(span, task);
            span.SetTag(Names.QueueName, task.Queue);
        }

        var attempt = new Attempt(task, span);
        Attempts.AddOrUpdate(task, attempt);
        return attempt;
    }

    /// <summary>
    /// Marks the handler span of <paramref name="task"/> as failed with <paramref name="errorType"/>.
    /// Only the first error counts.
    /// </summary>
    internal static void HandlerError(ClaimedTask task, string errorType)
    {
        if (Attempts.TryGetValue(task, out var attempt))
        {
            attempt.Error(errorType);
        }
    }

    /// <summary>
    /// Sets the span outcome of the attempt of <paramref name="task"/> to a PostgreSQL status, such as
    /// the release of a task with no handler.
    /// </summary>
    internal static void HandlerSpanOutcome(ClaimedTask task, string? status)
    {
        if (Attempts.TryGetValue(task, out var attempt))
        {
            attempt.Status(status);
        }
    }

    /// <summary>Starts the <c>workhorse.complete</c> span of one fenced completion.</summary>
    internal static Activity? StartComplete(ClaimedTask task) => StartTaskSpan(Names.SpanComplete, task);

    /// <summary>Records the answer of one fenced completion. The caller ends the span.</summary>
    internal static void Completed(Activity? span, ClaimedTask task, bool accepted)
    {
        span?.SetTag(Names.CompleteAccepted, accepted);

        if (accepted && TasksCompleted.Enabled)
        {
            TasksCompleted.Add(1, Metric(task.Queue, task.Type));
        }
    }

    /// <summary>
    /// Starts the <c>workhorse.retry</c> span of one fenced failure. The handler span records the
    /// type of <paramref name="error"/>, or <see cref="RedactedErrorType"/> for a task that redacts
    /// its error details.
    /// </summary>
    internal static Activity? StartFailure(ClaimedTask task, Exception error)
    {
        HandlerError(task, task.RedactErrorDetails ? RedactedErrorType : error.GetType().FullName ?? error.GetType().Name);
        return StartTaskSpan(Names.SpanRetry, task);
    }

    /// <summary>
    /// Records the state that PostgreSQL chose for one fenced failure. The handler span names that
    /// state, and the metrics name <c>retry</c>. The caller ends the span.
    /// </summary>
    internal static void Failed(Activity? span, ClaimedTask task, string? state)
    {
        span?.SetTag(Names.RetryOutcome, state);

        HandlerSpanOutcome(task, state);
        if (TasksFailed.Enabled)
        {
            var failed = Metric(task.Queue, task.Type);
            failed.Add(Names.AttemptOutcome, state);
            TasksFailed.Add(1, failed);
        }

        if (state is "ready" or "scheduled" && TasksRetried.Enabled)
        {
            TasksRetried.Add(1, Metric(task.Queue, task.Type));
        }
    }

    /// <summary>
    /// Records a lease expiration that PostgreSQL settled from an <c>expire_owned_telemetry_v1</c>
    /// row. A retried task gets a <c>workhorse.retry</c> span under its handler span.
    /// </summary>
    internal static void Expired(ClaimedTask task, Row row)
    {
        if (row.Text("retry_state") is not { } retryState)
        {
            return;
        }

        if (Source.HasListeners())
        {
            var parent = Attempts.TryGetValue(task, out var attempt) && attempt.Context is { } context ? context : default;
            using var span = parent == default ? StartSpan(Names.SpanRetry) : Source.StartActivity(Names.SpanRetry, ActivityKind.Internal, parent);
            if (span is { IsAllDataRequested: true })
            {
                SetTask(span, task);
                span.SetTag(Names.RetryOutcome, retryState);
            }
        }

        if (TasksRetried.Enabled)
        {
            TasksRetried.Add(1, Metric(task.Queue, task.Type));
        }
    }

    /// <summary>Records one heartbeat that PostgreSQL rejected with <paramref name="status"/>.</summary>
    internal static void HeartbeatRejected(string? status)
    {
        if (HeartbeatFailure.Enabled)
        {
            HeartbeatFailure.Add(1, new KeyValuePair<string, object?>(Names.HeartbeatStatus, status));
        }
    }

    /// <summary>
    /// Records one heartbeat round that failed with <paramref name="error"/> before PostgreSQL gave
    /// a status for its leases. The round gives no ownership verdict, so
    /// <c>workhorse.worker.heartbeat.failure</c> does not count it. The heartbeat records one value
    /// for each failed round, so the rate stays bounded by the heartbeat interval and its busy
    /// retries.
    /// </summary>
    /// <remarks>
    /// <paramref name="deadlineReached"/> is <c>true</c> when the round failed at or after its own
    /// deadline. Only then is a driver <see cref="TimeoutException"/> the round deadline.
    /// </remarks>
    internal static void HeartbeatRoundFailed(Exception error, bool deadlineReached)
    {
        if (HeartbeatRoundFailure.Enabled)
        {
            RecordHeartbeatRoundFailure(HeartbeatRoundFailureReason(error, deadlineReached));
        }
    }

    /// <summary>
    /// Records one heartbeat round that reached its deadline before a batch went out, as a
    /// <c>timeout</c>. No statement failed, so no exception gives the reason.
    /// </summary>
    internal static void HeartbeatRoundReachedDeadline()
    {
        if (HeartbeatRoundFailure.Enabled)
        {
            RecordHeartbeatRoundFailure("timeout");
        }
    }

    private static void RecordHeartbeatRoundFailure(string reason) =>
        HeartbeatRoundFailure.Add(1, new KeyValuePair<string, object?>(Names.HeartbeatFailureReason, reason));

    /// <summary>
    /// The bounded <c>workhorse.heartbeat.failure_reason</c> of a failed heartbeat round, with the
    /// rule of every SDK. The check reads <paramref name="error"/>, its
    /// <see cref="Exception.InnerException"/> chain, and each member of an
    /// <see cref="AggregateException"/>, at most 16 exceptions and each one once.
    /// </summary>
    /// <remarks>
    /// <list type="number">
    /// <item><c>timeout</c>: the round deadline only. That is a <see cref="RoundLostException"/>, a
    /// <see cref="RoundExpiredException"/>, a <see cref="RoundDeadlineException"/>, or any other
    /// <see cref="TimeoutException"/> when <paramref name="deadlineReached"/> is <c>true</c>. A
    /// command timeout that a dedicated round sets from its deadline thus stays a <c>timeout</c>.
    /// SQLSTATE <c>57014</c> (<c>statement_timeout</c>) and <c>25P03</c>
    /// (<c>idle_in_transaction_session_timeout</c>) are also <c>timeout</c>.</item>
    /// <item><c>connection</c>: the round did not reach PostgreSQL or lost its connection. That is a
    /// SQLSTATE that starts with <c>08</c>, a server shutdown (<c>57P01</c> to <c>57P03</c>), a
    /// <see cref="SocketException"/>, an <see cref="IOException"/> (also
    /// <see cref="EndOfStreamException"/>), or a transient <see cref="NpgsqlException"/> that is not a
    /// <see cref="PostgresException"/>. Npgsql marks such an exception transient when it wraps an I/O
    /// failure or a timeout. Any other <see cref="TimeoutException"/> is also <c>connection</c>: a
    /// connect timeout, or a pool wait that ends at the data source's <c>Timeout</c>. A borrowing
    /// round sets no deadline, so each driver timeout of that round is <c>connection</c>.</item>
    /// <item><c>database</c>: any other SQLSTATE, from a <see cref="NpgsqlException"/> or a
    /// <see cref="DatabaseException"/>.</item>
    /// <item><c>other</c>: everything else.</item>
    /// </list>
    /// <para>
    /// The check for <c>timeout</c> runs before the check for <c>connection</c>, and the first
    /// SQLSTATE in the chain counts. A heartbeat round takes no cancellation token, so a worker
    /// shutdown never cancels a round. An <see cref="OperationCanceledException"/> comes only from a
    /// statement cancel, and without a SQLSTATE in its chain it is <c>other</c>.
    /// </para>
    /// </remarks>
    internal static string HeartbeatRoundFailureReason(Exception error, bool deadlineReached)
    {
        var chain = ErrorChain(error);
        if (chain.Exists(entry => entry is RoundLostException or RoundExpiredException or RoundDeadlineException
            || (deadlineReached && entry is TimeoutException)))
        {
            return "timeout";
        }

        var sqlState = chain.Select(SqlStateOf).FirstOrDefault(state => state is not null);
        if (sqlState is "57014" or "25P03")
        {
            return "timeout";
        }

        if (sqlState is "57P01" or "57P02" or "57P03"
            || sqlState?.StartsWith("08", StringComparison.Ordinal) == true
            || chain.Exists(entry => entry is SocketException or IOException or TimeoutException
                || entry is NpgsqlException { IsTransient: true } and not PostgresException))
        {
            return "connection";
        }

        return sqlState is null ? "other" : "database";
    }

    /// <summary>The SQLSTATE that <paramref name="error"/> itself carries, or <c>null</c>.</summary>
    private static string? SqlStateOf(Exception error) => error switch
    {
        NpgsqlException driver => driver.SqlState,
        DatabaseException database => database.SqlState,
        _ => null,
    };

    /// <summary>
    /// <paramref name="error"/>, the members of each <see cref="AggregateException"/>, and each
    /// <see cref="Exception.InnerException"/>, outermost first. A cycle or a deep chain ends the
    /// walk after 16 exceptions.
    /// </summary>
    private static List<Exception> ErrorChain(Exception error)
    {
        const int Limit = 16;
        var chain = new List<Exception>();
        var seen = new HashSet<Exception>(ReferenceEqualityComparer.Instance);
        var pending = new Stack<Exception>();
        pending.Push(error);
        while (pending.Count > 0 && chain.Count < Limit)
        {
            var entry = pending.Pop();
            if (!seen.Add(entry))
            {
                continue;
            }

            chain.Add(entry);
            if (entry.InnerException is { } inner)
            {
                pending.Push(inner);
            }

            if (entry is AggregateException aggregate)
            {
                for (var index = aggregate.InnerExceptions.Count - 1; index >= 0; index--)
                {
                    pending.Push(aggregate.InnerExceptions[index]);
                }
            }
        }

        return chain;
    }

    /// <summary>
    /// Records how much later than <paramref name="cadenceMs"/> a maintenance <paramref name="loop"/>
    /// runs, from the <paramref name="elapsedNanos"/> since its last run.
    /// </summary>
    internal static void MaintenanceDriftOf(long elapsedNanos, long cadenceMs, string loop)
    {
        if (MaintenanceDrift.Enabled)
        {
            MaintenanceDrift.Record(Math.Max(0, (elapsedNanos / 1e6) - cadenceMs), new KeyValuePair<string, object?>(Names.MaintenanceLoop, loop));
        }
    }

    /// <summary>
    /// Starts one maintenance pass: a <c>workhorse.maintenance</c> span with a
    /// <c>workhorse.recovery</c> span inside it.
    /// </summary>
    internal static MaintenancePass StartMaintenance()
    {
        var span = StartSpan(Names.SpanMaintenance);
        span?.SetTag(Names.MaintenanceOperation, "tick");
        return new MaintenancePass(span, StartSpan(Names.SpanRecovery));
    }

    /// <summary>Records one fired schedule occurrence from a <c>fire_due_schedules_v2</c> row.</summary>
    internal static void ScheduleFiredOf(Row row, DateTimeOffset now)
    {
        if (row.Text("task_id") is null || (!ScheduleFired.Enabled && !ScheduleLag.Enabled))
        {
            return;
        }

        var tags = new TagList
        {
            { Names.ScheduleNamespace, row.Text("namespace") },
            { Names.ScheduleName, row.Text("schedule_name") },
        };
        ScheduleFired.Add(1, tags);
        if (row.Instant("occurrence_at") is { } occurrence)
        {
            ScheduleLag.Record(Math.Max(0, (now - occurrence).TotalSeconds), tags);
        }
    }

    private static Activity? StartTaskSpan(string name, ClaimedTask task)
    {
        var span = StartSpan(name);
        if (span is { IsAllDataRequested: true })
        {
            SetTask(span, task);
        }

        return span;
    }

    private static void SetTask(Activity span, ClaimedTask task)
    {
        span.SetTag(Names.TaskId, task.Id.ToString());
        span.SetTag(Names.TaskType, task.Type);
        span.SetTag(Names.TaskAttempt, (long)task.Attempt);
    }

    private static TagList Metric(string queue, string? taskType) => new()
    {
        { Names.QueueName, queue },
        { Names.TaskType, taskType },
    };

    private static double MillisSince(long startedAt) => (Monotonic.Now() - startedAt) / 1e6;

    /// <summary>One attempt's handler span, its start time, and the facts that its end records.</summary>
    internal sealed class Attempt
    {
        private readonly ClaimedTask _task;
        private readonly Activity? _span;
        private readonly long _startedAt = Monotonic.Now();
        private string? _errorType;
        private string? _status;

        internal Attempt(ClaimedTask task, Activity? span)
        {
            _task = task;
            _span = span;
        }

        /// <summary>The context of the handler span, or <c>null</c> when no listener sampled it.</summary>
        internal ActivityContext? Context => _span?.Context;

        internal void Error(string errorType) => Interlocked.CompareExchange(ref _errorType, errorType, null);

        internal void Status(string? status) => Volatile.Write(ref _status, status);

        /// <summary>
        /// Ends the handler span with the attempt's <paramref name="outcome"/>, or <c>null</c> when
        /// the attempt reported none. Records the handler duration, runtime, and execution.
        /// </summary>
        internal void Finish(Outcome? outcome)
        {
            try
            {
                var metricOutcome = MetricOutcome(outcome);
                if (_span is not null)
                {
                    _span.SetTag(Names.HandlerOutcome, Volatile.Read(ref _status) ?? SpanOutcome(outcome));
                    if (Volatile.Read(ref _errorType) is { } errorType)
                    {
                        RecordError(_span, errorType);
                    }
                }

                // The handler span is still current, so an exemplar of these metrics names its trace.
                var duration = MillisSince(_startedAt);
                if (HandlerRuntime.Enabled)
                {
                    HandlerRuntime.Add(duration, Metric(_task.Queue, _task.Type));
                }

                if (HandlerDuration.Enabled || HandlerExecutions.Enabled)
                {
                    var tags = Metric(_task.Queue, _task.Type);
                    tags.Add(Names.HandlerOutcome, metricOutcome);
                    HandlerDuration.Record(duration, tags);
                    HandlerExecutions.Add(1, tags);
                }
            }
            finally
            {
                _span?.Dispose();
            }
        }
    }

    /// <summary>The spans of one maintenance pass, and the rows that its phases affected.</summary>
    internal sealed class MaintenancePass(Activity? span, Activity? recovery) : IDisposable
    {
        private long _rows;

        /// <summary>
        /// Records one <c>tick_v1</c> or <c>run_maintenance_v1</c> phase row. The <c>recover</c>
        /// phase also sets the recovery attributes and counts its expired leases and retried tasks.
        /// </summary>
        internal void Phase(Row row)
        {
            var phase = row.Text("phase");
            var rows = row.Long("rows_affected") ?? 0;
            var skipped = row.Boolean("skipped_lock") == true;
            var error = row.Text("error") is not null;
            _rows += rows;
            if (MaintenanceRuns.Enabled || MaintenanceRows.Enabled || MaintenanceDuration.Enabled || MaintenanceErrors.Enabled)
            {
                var tags = new TagList
                {
                    { Names.MaintenanceLoop, "tick" },
                    { Names.MaintenancePhase, phase },
                    { Names.MaintenanceSkippedLock, skipped },
                };
                MaintenanceRuns.Add(1, tags);
                MaintenanceRows.Add(rows, tags);
                MaintenanceDuration.Record(row.Long("duration_ms") ?? 0, tags);
                if (error)
                {
                    MaintenanceErrors.Add(1, tags);
                }
            }

            if (phase == "recover")
            {
                Recovery(row, rows, skipped, error);
            }
        }

        /// <summary>Ends the recovery span, then the pass span with the rows of every phase.</summary>
        public void Dispose()
        {
            recovery?.Dispose();
            if (span is not null)
            {
                span.SetTag(Names.MaintenanceRowsAffected, _rows);
                span.Dispose();
            }
        }

        private void Recovery(Row row, long rows, bool skipped, bool error)
        {
            var expired = row.Has("expired_leases") ? row.Long("expired_leases") ?? 0 : 0;
            var retried = row.Has("retried") ? row.Long("retried") ?? 0 : 0;
            if (recovery is { IsAllDataRequested: true })
            {
                recovery.SetTag(Names.RecoverySkipped, skipped);
                if (!skipped && !error)
                {
                    recovery.SetTag(Names.RecoveryRowsAffected, rows);
                    recovery.SetTag(Names.RecoveryExpiredLeases, expired);
                    recovery.SetTag(Names.RecoveryRetried, retried);
                }
            }

            if (skipped || error)
            {
                return;
            }

            if (expired > 0 && LeasesExpired.Enabled)
            {
                LeasesExpired.Add(expired);
            }

            if (TasksRetried.Enabled)
            {
                Retries(retried, row.Has("retry_dimensions") ? row.Json("retry_dimensions") : null);
            }
        }

        /// <summary>Counts each retried task by queue and type. Retries without both count as unknown.</summary>
        private static void Retries(long retried, JsonElement? dimensions)
        {
            var counts = new Dictionary<(string Queue, string Type), long>();
            if (dimensions is { ValueKind: JsonValueKind.Array } list)
            {
                foreach (var item in list.EnumerateArray())
                {
                    if (item.ValueKind == JsonValueKind.Object
                        && item.TryGetProperty("queue", out var queue) && queue.ValueKind == JsonValueKind.String
                        && item.TryGetProperty("type", out var type) && type.ValueKind == JsonValueKind.String)
                    {
                        var key = (queue.GetString()!, type.GetString()!);
                        counts[key] = counts.GetValueOrDefault(key) + 1;
                    }
                }
            }

            var attributed = 0L;
            foreach (var ((queue, type), count) in counts)
            {
                attributed += count;
                TasksRetried.Add(count, Metric(queue, type));
            }

            if (retried > attributed)
            {
                TasksRetried.Add(retried - attributed, Metric("unknown", "unknown"));
            }
        }
    }
}
