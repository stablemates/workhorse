using System.Collections.Concurrent;
using System.Diagnostics;
using System.Globalization;
using System.Text;
using System.Text.Json;
using Npgsql;
using Workhorse.Internal;
using Workhorse.Internal.Database;
using Workhorse.Internal.Runtime;
using Workhorse.Internal.Telemetry;
using Workhorse.Tests.Testing;

namespace Workhorse.Tests.Conformance;

/// <summary>
/// Drives the failures and runtime fixtures through <see cref="Worker"/> against a scratch
/// database. The counterpart of the JVM <c>RuntimeFixtures</c>. The runner injects faults around
/// the worker's statements through <see cref="Intercept"/>, or into installed functions, never into
/// the worker itself.
/// </summary>
internal sealed class RuntimeFixtures : IAsyncDisposable
{
    /// <summary>The .NET slices that are still open. A listed fixture names one of them.</summary>
    internal static readonly IReadOnlySet<string> OpenSlices = new HashSet<string>(StringComparer.Ordinal);

    /// <summary>The C# key of the language maps in <c>protocol/v1</c>.</summary>
    private const string Language = "csharp";

    /// <summary>
    /// Runtime fixtures that need a surface an open .NET slice owns, by fixture ID. Each one is also
    /// on the expected-unsupported list with the same slice.
    /// </summary>
    private static readonly Dictionary<string, string> Gaps = new(StringComparer.Ordinal);

    private static readonly Dictionary<CancelReason, string> CancelNames = new()
    {
        [CancelReason.Requested] = "CancellationRequestedError",
        [CancelReason.DeadlineExceeded] = "DeadlineExceededError",
        [CancelReason.ExecutionTimeout] = "ExecutionTimeoutError",
    };

    private static readonly TimeSpan Patience = TimeSpan.FromSeconds(10);

    private readonly ConformanceDatabase _database;
    private readonly OrderedDictionary<string, object?> _envelope;
    private readonly Queue _queue;
    private readonly List<Func<Task>> _cleanups = [];

    internal RuntimeFixtures(ConformanceDatabase database, string protocol)
    {
        _database = database;
        _envelope = Runner.Object(Runner.Object(Json.Parse(File.ReadAllText(Path.Combine(protocol, "failures.json"))), "failures")["envelope"], "envelope");
        _queue = new Queue(database.DataSource);
    }

    /// <summary>Why no C# adapter can run <paramref name="fixture"/> yet, or <c>null</c> when one can.</summary>
    internal static string? Gap(OrderedDictionary<string, object?> fixture) => Gaps.GetValueOrDefault(Runner.Text(fixture.GetValueOrDefault("id")));

    internal async Task RunAsync(OrderedDictionary<string, object?> fixture)
    {
        try
        {
            await DispatchAsync(fixture);
        }
        catch (Exception error) when (error is not Failure)
        {
            throw new Failure($"{error.GetType().Name}: {error.Message}");
        }
        finally
        {
            await CleanUpAsync();
        }
    }

    public async ValueTask DisposeAsync() => await CleanUpAsync();

    private Task DispatchAsync(OrderedDictionary<string, object?> fixture) =>
        fixture.GetValueOrDefault("kind") switch
        {
            "trace-propagation" => TraceAsync(fixture),
            "cooperative-cancellation" => CancellationAsync(fixture),
            "expiration" => ExpirationAsync(fixture),
            "heartbeat-cadence" => HeartbeatCadenceAsync(fixture),
            "poll-cadence" => PollCadenceAsync(fixture),
            "graceful-drain" => GracefulDrainAsync(fixture),
            "budget-admission-race" => BudgetRaceAsync(fixture),
            "missing-handler" => MissingHandlerAsync(fixture),
            "release-wait" => ReleaseWaitAsync(fixture),
            "subscription-recovery" => SubscriptionRecoveryAsync(fixture),
            "json-round-trip" => JsonRoundTripAsync(fixture),
            "oversized-result" => OversizedResultAsync(fixture),
            "shutdown-cancellation" => ShutdownCancellationAsync(fixture),
            "heartbeat-failure" => HeartbeatFailureAsync(fixture),
            "heartbeat-busy" => HeartbeatBusyAsync(fixture),
            "maintenance-phase-error" => MaintenancePhaseErrorAsync(fixture),
            "slot-refill" => SlotRefillAsync(fixture),
            "batch" => BatchAsync(fixture),
            "suspension-replay" => SuspensionReplayAsync(fixture),
            "lease-loss" => LeaseLossAsync(fixture),
            "replay-conflict" => ReplayConflictAsync(fixture),
            var kind => throw new Failure($"unknown runtime fixture kind {Matcher.Render(kind)}"),
        };

    // ----- failures ------------------------------------------------------------------------------

    /// <summary>The error that a failures fixture declares by name. Its type name is the envelope name.</summary>
    private sealed class PaymentDeclined(string message) : Exception(message);

    /// <summary>
    /// The message a failures fixture describes: text, or an array of text parts and unpaired
    /// surrogates. A C# string holds an unpaired surrogate as one <see cref="char"/>.
    /// </summary>
    private static string FixtureMessage(object? message)
    {
        if (message is string text)
        {
            return text;
        }

        var built = new StringBuilder();
        foreach (var part in (List<object?>)message!)
        {
            if (part is string piece)
            {
                built.Append(piece);
                continue;
            }

            var unit = Runner.Text(Runner.Object(part, "message part")["unpairedSurrogate"]);
            built.Append((char)int.Parse(unit, NumberStyles.HexNumber, CultureInfo.InvariantCulture));
        }

        return built.ToString();
    }

    internal async Task FailureAsync(OrderedDictionary<string, object?> fixture)
    {
        var name = $"failures-{Runner.Text(fixture["id"])}";
        var taskId = await EnqueueAsync("protocol.failure", Json.Members(), Options(name) with { MaxAttempts = 1 });
        var redacted = fixture.GetValueOrDefault("redactErrorDetails") is true;
        if (redacted)
        {
            await UpdateAsync($"UPDATE workhorse.task SET payload_redact_keys = ARRAY['secret'] WHERE id = '{taskId}'");
        }

        var declared = Runner.Object(fixture.GetValueOrDefault("error"), "error");
        var message = FixtureMessage(declared["message"]);
        var declaresStack = declared.GetValueOrDefault("declaresStack") is true;
        bool? handedStack = null;
        var sent = new ConcurrentQueue<object?>();

        // PostgreSQL also redacts, so the runner reads the envelope before it leaves the worker.
        var hook = new Intercept.Callbacks(before: call =>
        {
            if (call.Is(SqlCatalogue.FailV1))
            {
                sent.Enqueue(Json.Parse((string)call.Parameter(4)!));
            }
        });
        await using (var pool = Intercept.Create(_database, hook))
        {
            await using var subject = new Worker(pool.DataSource, BaseOptions(name, $"dotnet-{name}"));
            subject.Handle<JsonElement>("protocol.failure", (_, _) =>
            {
                // An error that names nothing is a System.Exception in C#, whose name is the generic name.
#pragma warning disable CA2201
                var error = declared.GetValueOrDefault("declaresName") is true ? new PaymentDeclined(message) : new Exception(message);
#pragma warning restore CA2201
                // An exception that was never thrown has no stack trace.
                if (declaresStack)
                {
                    try
                    {
                        throw error;
                    }
                    catch (Exception thrown)
                    {
                        error = thrown;
                    }
                }

                handedStack = error.StackTrace is not null;
                return Task.FromException(error);
            });
            Failure.Check(await subject.RunOnceAsync(), "the worker did not run the failing task");
        }

        Failure.Check(handedStack == declaresStack, $"the handler raised an error with a stack {handedStack}, want declaresStack {declaresStack}");
        Failure.Check(sent.Count == 1, $"the worker sent {sent.Count} fail_v1 calls, want 1");
        var stored = Json.Parse((await ValueAsync($"SELECT error::text FROM workhorse.task_outcome WHERE task_id = '{taskId}'"))!);
        FailureEnvelope(fixture, "sent", Runner.Object(sent.Single(), "sent envelope"));
        FailureEnvelope(fixture, "stored", Runner.Object(stored, "stored envelope"));
    }

    private void FailureEnvelope(OrderedDictionary<string, object?> fixture, string label, OrderedDictionary<string, object?> stored)
    {
        var redacted = fixture.GetValueOrDefault("redactErrorDetails") is true;
        var fields = Runner.Strings(_envelope[redacted ? "redactedFields" : "fields"]).ToHashSet(StringComparer.Ordinal);
        Failure.Check(fields.SetEquals(stored.Keys), $"{label} envelope fields [{string.Join(", ", stored.Keys)}], want [{string.Join(", ", fields)}]");
        var expected = Runner.Object(fixture.GetValueOrDefault("envelope"), "envelope");
        var want = expected.GetValueOrDefault("name");
        if (want is "$generic")
        {
            want = Runner.Object(_envelope["genericName"], "genericName").GetValueOrDefault(Language);
        }

        Failure.Check(Matcher.Same(stored.GetValueOrDefault("name"), want), $"{label} envelope name {Matcher.Render(stored.GetValueOrDefault("name"))}, want {Matcher.Render(want)}");
        Failure.Check(
            Matcher.Same(stored.GetValueOrDefault("message"), expected.GetValueOrDefault("message")),
            $"{label} envelope message {Matcher.Render(stored.GetValueOrDefault("message"))}, want {Matcher.Render(expected.GetValueOrDefault("message"))}");
        var stack = stored.GetValueOrDefault("stack");
        switch (expected.GetValueOrDefault("stack"))
        {
            case "string":
                Failure.Check(stack is string { Length: > 0 }, $"{label} envelope stack is not a string");
                break;
            case "stringOrNull":
                Failure.Check(stack is null or string, $"{label} envelope stack is neither a string nor null");
                break;
            default:
                break;
        }

        foreach (var character in Runner.Strings(_envelope["forbiddenNameCharacters"]))
        {
            Failure.Check(
                !Runner.Text(stored.GetValueOrDefault("name")).Contains(character, StringComparison.Ordinal),
                $"{label} envelope name {Runner.Text(stored.GetValueOrDefault("name"))} contains {character}");
        }
    }

    // ----- fixtures ------------------------------------------------------------------------------

    private async Task CancellationAsync(OrderedDictionary<string, object?> fixture)
    {
        var taskId = await EnqueueAsync(TaskType(fixture), Json.Members(), Options(QueueName(fixture)));
        var started = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var reasons = new ConcurrentQueue<string?>();
        await using var pool = Intercept.Create(_database, Intercept.Hook.None);
        await using var subject = NewWorker(pool, fixture, options =>
        {
            options.Lease = Millis(fixture, "leaseMs");
            options.Heartbeat = Millis(fixture, "heartbeatMs");
            options.SharedHeartbeats = true;
        });
        subject.Handle<JsonElement>(TaskType(fixture), async (context, _) =>
        {
            started.TrySetResult();
            await WaitForCancellationAsync("the cancellation never reached the handler", context.CancellationToken);
            reasons.Enqueue(CancelNames.GetValueOrDefault(context.CancelReason ?? CancelReason.Suspended));
            context.CancellationToken.ThrowIfCancellationRequested();
        });
        var result = Running(subject, () => subject.RunOnceAsync());
        await Started(started, "the handler never started");
        var cancel = await _queue.CancelAsync(taskId, new CancelOptions { RequestedBy = "runtime-fixture", Reason = (string?)fixture.GetValueOrDefault("cancelReason") });
        Failure.Check(cancel.Status == CancelStatus.CancelRequested, $"cancel returned {cancel.Status}");
        Failure.Check(await JoinAsync(result), "the worker did not report the cancelled run");
        Failure.Check(reasons.SequenceEqual([fixture.GetValueOrDefault("expectedAbortReason") as string]), $"abort reasons [{string.Join(", ", reasons)}]");
        await ExpectStateAsync(taskId, Get(fixture, "expectedState"));
        await ExpectOutcomesAsync(taskId, [fixture.GetValueOrDefault("expectedAttemptOutcome")]);
    }

    /// <summary>
    /// The local timer reads the claimed row, so a claim that returns an earlier expiration models a
    /// clock that runs ahead of PostgreSQL. The runner wraps <c>claim_many_v1</c> in PostgreSQL to
    /// shift the value, because Npgsql has no hook that changes a value the worker reads.
    /// </summary>
    private async Task ExpirationAsync(OrderedDictionary<string, object?> fixture)
    {
        var deadline = fixture.GetValueOrDefault("mode") is "deadline";
        var duration = (long)fixture["durationMs"]!;
        var lead = (long)fixture["localClockLeadMs"]!;
        var options = Options(QueueName(fixture)) with
        {
            MaxAttempts = Runner.Int(fixture.GetValueOrDefault("maxAttempts")),
            RetryPolicy = RetryPolicy.Fixed(TimeSpan.Zero),
        };

        // The deadline budget starts after the claim, inside the claim wrapper. The placeholder only
        // has to be far enough away that the claim never skips the task.
        options = deadline
            ? options with { Deadline = DateTimeOffset.UtcNow.AddHours(1) }
            : options with { ExecutionTimeout = TimeSpan.FromMilliseconds(duration) };
        var taskId = await EnqueueAsync(TaskType(fixture), Json.Members(), options);
        var column = deadline ? "deadline_at" : "attempt_timeout_at";
        await ShiftClaimsAsync(taskId, column, lead, deadline ? duration : null);
        var reasons = new ConcurrentQueue<string?>();
        // The expiry PostgreSQL holds for each attempt, and its clock when the handler saw cancellation.
        var expiries = new ConcurrentQueue<string?>();
        var cancelledAt = new ConcurrentQueue<string?>();
        var heartbeats = 0;
        Worker? holder = null;
        var hook = new Intercept.Callbacks(
            before: call =>
            {
                if (call.Is(SqlCatalogue.HeartbeatManyV2))
                {
                    Interlocked.Increment(ref heartbeats);
                }
            },
            after: call =>
            {
                if (call.Is(SqlCatalogue.HeartbeatManyV2))
                {
                    Interlocked.Decrement(ref heartbeats);
                }
            });
        await using var pool = Intercept.Create(_database, hook);
        await using var subject = NewWorker(pool, fixture, worker =>
        {
            worker.Lease = Millis(fixture, "leaseMs");
            worker.Heartbeat = Millis(fixture, "heartbeatMs");
            worker.SharedHeartbeats = true;

            // A maintenance tick during the attempt can fail it in PostgreSQL first. Then the timer's
            // settlement answers stale, and the handler sees LeaseLost (SM-1684, SM-1687). With a
            // long interval only the first pass ticks, before its claim, so the local timer is the
            // only settler, which is what the fixture pins.
            worker.MaintenanceInterval = TimeSpan.FromHours(1);
        });
        subject.Handle<JsonElement>(TaskType(fixture), async (context, _) =>
        {
            expiries.Enqueue(await ValueAsync($"SELECT {column}::text FROM workhorse.task_runtime WHERE task_id = '{taskId}'"));
            await WaitForCancellationAsync("the expiration never reached the handler", context.CancellationToken);
            cancelledAt.Enqueue(await ValueAsync("SELECT clock_timestamp()::text"));
            reasons.Enqueue(CancelNames.GetValueOrDefault(context.CancelReason ?? CancelReason.Suspended));
            holder!.Pause();
            context.CancellationToken.ThrowIfCancellationRequested();
        });
        holder = subject;
        var runs = (List<object?>)fixture["expectedAfterRuns"]!;
        for (var index = 0; index < runs.Count; index++)
        {
            // A heartbeat round that began before the last attempt settled holds the task's row
            // lock, and the claim skips a locked row.
            await EventuallyAsync("a heartbeat round outlived the previous attempt", 5, () => Volatile.Read(ref heartbeats) == 0);
            subject.Resume();
            Failure.Check(await subject.RunOnceAsync(), $"run {index + 1} did not run the task");
            await ExpectStateAsync(taskId, Runner.Object(runs[index], "expected"));
        }

        Failure.Check(Matcher.Same(reasons.Cast<object?>().ToList(), fixture.GetValueOrDefault("expectedAbortReasons")), $"abort reasons [{string.Join(", ", reasons)}]");

        // Both times come from the database clock, so the worker clock cannot move either one.
        Failure.Check(expiries.Count == cancelledAt.Count, $"{expiries.Count} attempts, {cancelledAt.Count} cancellations");
        var afterExpiry = new List<bool>();
        foreach (var (at, expiry) in cancelledAt.Zip(expiries))
        {
            afterExpiry.Add(await ValueAsync($"SELECT ('{at}'::timestamptz >= '{expiry}'::timestamptz)::text") == "true");
        }

        var expected = (bool)fixture["expectedCancelledAfterDatabaseExpiry"]!;
        Failure.Check(afterExpiry.All(after => after == expected), $"cancellation after the database expiry: [{string.Join(", ", afterExpiry)}]");
        await ExpectOutcomesAsync(taskId, (List<object?>)fixture["expectedAttemptOutcomes"]!);
    }

    private async Task HeartbeatCadenceAsync(OrderedDictionary<string, object?> fixture)
    {
        await EnqueueAsync(TaskType(fixture), Json.Members(), Options(QueueName(fixture)));
        var handlerStarted = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        using var releaseHandler = new ManualResetEventSlim();
        using var firstStarted = new ManualResetEventSlim();
        using var releaseFirst = new ManualResetEventSlim();
        var calls = 0;
        var active = 0;
        var overlap = 0;
        var heartbeat = (long)fixture["heartbeatMs"]!;
        var hook = new Intercept.Callbacks(
            before: call =>
            {
                if (!call.Is(SqlCatalogue.HeartbeatManyV2))
                {
                    return;
                }

                var number = Interlocked.Increment(ref calls);
                Maximum(ref overlap, Interlocked.Increment(ref active));
                if (number == 1)
                {
                    firstStarted.Set();
                    if (!releaseFirst.Wait(TimeSpan.FromSeconds(5)))
                    {
                        throw new InvalidOperationException("the first heartbeat was never released");
                    }
                }
            },
            after: call =>
            {
                if (call.Is(SqlCatalogue.HeartbeatManyV2))
                {
                    Interlocked.Decrement(ref active);
                }
            });
        await using var pool = Intercept.Create(_database, hook);
        await using var subject = NewWorker(pool, fixture, options =>
        {
            options.Lease = Millis(fixture, "leaseMs");
            options.Heartbeat = TimeSpan.FromMilliseconds(heartbeat);
            options.SharedHeartbeats = true;
        });
        subject.Handle<JsonElement>(TaskType(fixture), async (_, _) =>
        {
            handlerStarted.TrySetResult();
            await WaitAsync(releaseHandler, "the handler was never released");
        });
        var result = Running(subject, () => subject.RunOnceAsync());
        try
        {
            await Started(handlerStarted, "the handler never started");
            Failure.Check(await Task.Run(() => firstStarted.Wait(TimeSpan.FromSeconds(5))), "no heartbeat started");
            await Task.Delay(TimeSpan.FromMilliseconds(heartbeat * 3));
            Failure.Check(Volatile.Read(ref calls) == (long)fixture["expectedCallsWhileBlocked"]!, $"{calls} heartbeats started while one was blocked");
            releaseFirst.Set();
            var minimum = (long)fixture["expectedMinimumCallsBeforeSettlement"]!;
            await EventuallyAsync("no heartbeat followed the blocked one", 10, () => Volatile.Read(ref calls) >= minimum);
            Failure.Check(Volatile.Read(ref overlap) == (long)fixture["expectedMaximumOverlap"]!, $"{overlap} heartbeats overlapped");
            releaseHandler.Set();
            Failure.Check(await JoinAsync(result), "the worker did not run the task");
        }
        finally
        {
            releaseFirst.Set();
            releaseHandler.Set();
            await Settled(result);
        }

        // An in-flight round can end after the attempt settles; it starts no new one.
        await EventuallyAsync("a heartbeat round outlived the attempt", 5, () => Volatile.Read(ref active) == 0);
        var settled = Volatile.Read(ref calls);
        await Task.Delay(TimeSpan.FromMilliseconds(heartbeat * 3));
        Failure.Check(Volatile.Read(ref calls) == settled, "heartbeats continued after the attempt settled");
    }

    /// <summary>
    /// Holds the worker after each empty claim until the driver releases it, so an uncounted poll
    /// cannot advance the backoff step that the delay is measured against.
    /// </summary>
    /// <remarks>
    /// The delay runs from the moment that the last empty claim returns to the worker to the start of
    /// the next claim. That span is the worker's own cadence.
    /// </remarks>
    private async Task PollCadenceAsync(OrderedDictionary<string, object?> fixture)
    {
        var name = QueueName(fixture);
        var polls = (long)fixture["emptyPollsBeforeEnqueue"]!;
        var maximum = (long)fixture["expectedMaximumDelayMs"]!;
        using var reached = new SemaphoreSlim(0);
        using var released = new SemaphoreSlim(0);
        var holding = 1;

        // Each claim_many_v1 call's start, its return to the worker, and whether it found a task.
        var claims = new ConcurrentQueue<(long Start, long End, long Rows)>();
        var starts = new ConcurrentDictionary<Intercept.Call, long>();
        var handled = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var hook = new Intercept.Callbacks(
            before: call =>
            {
                if (call.Is(SqlCatalogue.ClaimManyV1))
                {
                    starts[call] = Stopwatch.GetTimestamp();
                }
            },
            after: call =>
            {
                if (!call.Is(SqlCatalogue.ClaimManyV1))
                {
                    return;
                }

                if (call.Rows == 0 && Volatile.Read(ref holding) == 1)
                {
                    reached.Release();
                    released.Wait(TimeSpan.FromSeconds(5));
                }

                starts.TryRemove(call, out var start);
                claims.Enqueue((start, Stopwatch.GetTimestamp(), call.Rows));
            });
        await using (var pool = Intercept.Create(_database, hook))
        {
            await using var subject = NewWorker(pool, fixture, options => options.PollInterval = Millis(fixture, "pollMs"));
            subject.Handle<JsonElement>(TaskType(fixture), (_, _) =>
            {
                handled.TrySetResult();
                return Task.CompletedTask;
            });
            var run = Running(subject, () => subject.RunAsync(CancellationToken.None));
            try
            {
                for (var poll = 1; poll <= polls; poll++)
                {
                    Failure.Check(await reached.WaitAsync(TimeSpan.FromMilliseconds(maximum + 1000)), $"the worker did not complete empty poll {poll}");
                    if (poll == polls)
                    {
                        // A stall longer than one backoff step changes nothing for a held worker.
                        await Task.Delay(TimeSpan.FromMilliseconds((long)fixture["enqueueStallMs"]!));
                        await EnqueueAsync(TaskType(fixture), Json.Members(), Options(name));
                        Volatile.Write(ref holding, 0);
                    }

                    released.Release();
                }

                Failure.Check(await Completes(handled.Task, TimeSpan.FromMilliseconds(maximum + 1000)), "the worker never ran the enqueued task");
            }
            finally
            {
                Volatile.Write(ref holding, 0);
                released.Release();
                subject.Stop();
                await Settled(run);
            }
        }

        var seen = claims.ToList();
        var found = seen.FindIndex(claim => claim.Rows > 0);
        Failure.Check(found > 0, "no claim_many_v1 call after an empty poll returned the enqueued task");
        var empty = seen.Take(found).Count(claim => claim.Rows == 0);
        Failure.Check(empty == polls, $"the worker claimed the task after {empty} empty polls, want {polls}");
        var delay = (long)Stopwatch.GetElapsedTime(seen[found - 1].End, seen[found].Start).TotalMilliseconds;
        var minimum = (long)fixture["expectedMinimumDelayMs"]!;
        Failure.Check(delay >= minimum && delay <= maximum, $"the claim after {polls} empty polls waited {delay} ms, want {minimum} to {maximum} ms");
    }

    private async Task GracefulDrainAsync(OrderedDictionary<string, object?> fixture)
    {
        var name = QueueName(fixture);
        var taskIds = new List<Guid>();
        for (long sequence = 0; sequence < (long)fixture["taskCount"]!; sequence++)
        {
            taskIds.Add(await EnqueueAsync(TaskType(fixture), Json.Members(("sequence", sequence)), Options(name)));
        }

        using var release = new ManualResetEventSlim();
        var active = 0;
        var expectedActive = (long)fixture["expectedActiveAtStop"]!;
        await using (var pool = Intercept.Create(_database, Intercept.Hook.None))
        {
            await using var subject = NewWorker(pool, fixture, options =>
            {
                options.Concurrency = checked((int)(long)fixture["concurrency"]!);
                options.PollInterval = TimeSpan.FromSeconds(5);
            });
            subject.Handle<JsonElement>(TaskType(fixture), async (_, _) =>
            {
                Interlocked.Increment(ref active);
                try
                {
                    await WaitAsync(release, "the handler was never released");
                }
                finally
                {
                    Interlocked.Decrement(ref active);
                }
            });
            var run = Running(subject, () => subject.RunAsync(CancellationToken.None));
            try
            {
                await EventuallyAsync("the worker did not fill its slots", 10, () => Volatile.Read(ref active) == expectedActive);
                subject.Stop();
                Failure.Check(Volatile.Read(ref active) == expectedActive, "stop abandoned an active slot");
                await Task.Delay(TimeSpan.FromMilliseconds((long)fixture["settleCheckMs"]!));
                Failure.Check(!run.IsCompleted, "run returned before its handlers finished");
            }
            finally
            {
                release.Set();
                subject.Stop();
            }

            await JoinAsync(run);
            Failure.Check(Volatile.Read(ref active) == 0, "slots remain active after the drain");
        }

        var states = new List<string?>();
        foreach (var taskId in taskIds)
        {
            states.Add((await StateAsync(taskId))["state"] as string);
        }

        Failure.Check(states.Count(state => state == "succeeded") == (long)fixture["expectedSucceeded"]!, $"states after the drain: [{string.Join(", ", states)}]");
        Failure.Check(states.Count(state => state == "ready") == (long)fixture["expectedReady"]!, $"states after the drain: [{string.Join(", ", states)}]");
    }

    /// <summary>
    /// A busy worker refills free slots with overlapping batched claims. Holding a claim keeps it in
    /// flight, so the next claim is observed while the first is open.
    /// </summary>
    private async Task SlotRefillAsync(OrderedDictionary<string, object?> fixture)
    {
        var name = QueueName(fixture);
        var concurrency = checked((int)(long)fixture["concurrency"]!);
        var taskCount = (long)fixture["taskCount"]!;
        var taskIds = new List<Guid>();
        for (long sequence = 0; sequence < taskCount; sequence++)
        {
            taskIds.Add(await EnqueueAsync(TaskType(fixture), Json.Members(("sequence", sequence)), Options(name)));
        }

        var gate = new Lock();
        var limits = new List<long>();
        var held = new List<ManualResetEventSlim>();
        var holding = false;
        var inFlight = 0;
        var overlapping = 0;
        var withTasks = 0;

        // `running` and `peak` count handler bodies, so the whole run shows that the concurrency holds.
        var started = new List<ManualResetEventSlim>();
        var open = false;
        var running = 0;
        var peak = 0;
        void ReleaseHeld()
        {
            List<ManualResetEventSlim> waiting;
            lock (gate)
            {
                holding = false;
                waiting = [.. held];
                held.Clear();
            }

            waiting.ForEach(latch => latch.Set());
        }

        void OpenAll()
        {
            List<ManualResetEventSlim> waiting;
            lock (gate)
            {
                open = true;
                waiting = [.. started];
                started.Clear();
            }

            waiting.ForEach(latch => latch.Set());
        }

        int Size<T>(List<T> list)
        {
            lock (gate)
            {
                return list.Count;
            }
        }

        var hook = new Intercept.Callbacks(
            before: call =>
            {
                if (!call.Is(SqlCatalogue.ClaimManyV1))
                {
                    return;
                }

                var release = new ManualResetEventSlim();
                lock (gate)
                {
                    limits.Add(Convert.ToInt64(call.Parameter(3), CultureInfo.InvariantCulture));
                    Maximum(ref overlapping, Interlocked.Increment(ref inFlight));
                    if (holding)
                    {
                        held.Add(release);
                    }
                    else
                    {
                        release.Set();
                    }
                }

                if (!release.Wait(TimeSpan.FromSeconds(10)))
                {
                    Interlocked.Decrement(ref inFlight);
                    throw new InvalidOperationException("a held claim was never released");
                }
            },
            after: call =>
            {
                if (call.Is(SqlCatalogue.ClaimManyV1))
                {
                    if (call.Rows > 0)
                    {
                        Interlocked.Increment(ref withTasks);
                    }

                    Interlocked.Decrement(ref inFlight);
                }
            });
        await using var pool = Intercept.Create(_database, hook);
        await using var subject = NewWorker(pool, fixture, options =>
        {
            options.Concurrency = concurrency;
            options.SharedHeartbeats = true;
        });
        subject.Handle<JsonElement>(TaskType(fixture), async (_, _) =>
        {
            var finished = new ManualResetEventSlim();
            bool blocked;
            lock (gate)
            {
                peak = Math.Max(peak, ++running);
                blocked = !open;
                if (blocked)
                {
                    started.Add(finished);
                }
            }

            try
            {
                if (blocked)
                {
                    await WaitAsync(finished, "the handler was never finished");
                }
            }
            finally
            {
                lock (gate)
                {
                    running--;
                }
            }
        });
        var run = Running(subject, () => subject.RunAsync(CancellationToken.None));
        try
        {
            await EventuallyAsync("the worker did not fill its slots", 10, () => Size(started) == concurrency);
            lock (gate)
            {
                holding = true;
            }

            for (var finished = 1; finished <= 3; finished++)
            {
                ManualResetEventSlim first;
                lock (gate)
                {
                    first = started[0];
                    started.RemoveAt(0);
                }

                first.Set();
                if (finished == 2)
                {
                    // One more free slot is below the refill batch while the first refill is held.
                    await Task.Delay(TimeSpan.FromMilliseconds((long)fixture["settleCheckMs"]!));
                    Failure.Check(Size(limits) == 2, $"a single free slot started claim {Size(limits)}");
                }
                else
                {
                    var expected = finished == 1 ? 2 : 3;
                    await EventuallyAsync($"the worker did not start claim {expected}", 10, () => Size(limits) >= expected);
                }
            }

            List<object?> seen;
            lock (gate)
            {
                seen = [.. limits.Cast<object?>()];
            }

            Failure.Check(Matcher.Same(seen, fixture.GetValueOrDefault("expectedClaimLimits")), $"claim limits [{string.Join(", ", seen)}]");
            Failure.Check(Volatile.Read(ref overlapping) == (long)fixture["expectedOverlappingClaims"]!, $"{overlapping} claims overlapped");
            ReleaseHeld();
            OpenAll();
            await EventuallyAsync("the worker did not run every task", 20, async () =>
            {
                foreach (var taskId in taskIds)
                {
                    if ((await StateAsync(taskId))["state"] is not "succeeded")
                    {
                        return false;
                    }
                }

                return true;
            });
            var ratio = Volatile.Read(ref withTasks) / (double)taskCount;
            Failure.Check(ratio <= Convert.ToDouble(fixture["expectedMaximumClaimsPerTask"], CultureInfo.InvariantCulture), $"{ratio} claims per task");
            Failure.Check(peak == concurrency, $"{peak} handlers ran at once with concurrency {concurrency}");
        }
        finally
        {
            ReleaseHeld();
            OpenAll();
            subject.Stop();
            await Settled(run);
        }
    }

    /// <summary>
    /// The handler checkpoints, pauses the worker on its first run, and sleeps durably. The sleep
    /// suspends the attempt and frees the slot for the following task. The runner then rewinds the
    /// wait and promotes it, so the replay runs at once and reuses the checkpoint.
    /// </summary>
    private async Task SuspensionReplayAsync(OrderedDictionary<string, object?> fixture)
    {
        var name = QueueName(fixture);
        var taskIds = new Dictionary<string, Guid>(StringComparer.Ordinal)
        {
            ["suspension"] = await EnqueueAsync(TaskType(fixture), Json.Members(), Options(name)),
            ["following"] = await EnqueueAsync((string)fixture["followingTaskType"]!, Json.Members(), Options(name)),
        };
        var seen = new ConcurrentQueue<object?>();
        var runs = 0;
        var operations = 0;
        Worker? holder = null;
        await using (var pool = Intercept.Create(_database, Intercept.Hook.None))
        {
            await using var subject = NewWorker(pool, fixture, options => options.MaintenanceInterval = TimeSpan.FromMilliseconds(100));
            subject.Handle<JsonElement, object?>(TaskType(fixture), async (context, _) =>
            {
                var run = Interlocked.Increment(ref runs);
                seen.Enqueue($"suspension:{context.Task.Attempt}");
                var prepared = await context.CheckpointAsync(
                    (string)fixture["checkpointName"]!,
                    _ => Task.FromResult(Json.Element(Json.Members(("operation", (long)Interlocked.Increment(ref operations))))));
                if (run == 1)
                {
                    holder!.Pause();
                }

                await context.SleepAsync((string)fixture["waitName"]!, Millis(fixture, "waitMs"));
                return Json.Members(("prepared", prepared), ("handlerRuns", (long)run));
            });
            subject.Handle<JsonElement, object?>((string)fixture["followingTaskType"]!, (context, _) =>
            {
                seen.Enqueue($"following:{context.Task.Attempt}");
                return Task.FromResult<object?>(Json.Members(("handled", true)));
            });
            holder = subject;
            Failure.Check(await subject.RunOnceAsync(), "the worker did not run the suspending task");
            await ExpectStatesAsync(taskIds, Get(fixture, "expectedAfterSuspension"));
            var suspended = await AttemptsAsync(taskIds["suspension"]);
            Failure.Check(suspended == (long)fixture["expectedAttemptsAfterSuspension"]!, $"the suspended task recorded {suspended} attempts");
            subject.Resume();
            Failure.Check(await subject.RunOnceAsync(), "the released slot did not run the following task");
            await ExpectStatesAsync(taskIds, Get(fixture, "expectedAfterSlotRelease"));

            // The wait is long enough that it cannot elapse on a slow runner, so the runner rewinds it
            // and promotes it instead of sleeping through it.
            await UpdateAsync($"UPDATE workhorse.task_runtime SET run_at = clock_timestamp() - interval '1 millisecond' WHERE task_id = '{taskIds["suspension"]}'");
            await UpdateAsync("SELECT * FROM workhorse.tick_v1(100, 100)");
            Failure.Check(await subject.RunOnceAsync(), "the worker did not replay the woken task");
            await ExpectStatesAsync(taskIds, Get(fixture, "expectedAfterReplay"));
        }

        var replayed = await AttemptsAsync(taskIds["suspension"]);
        Failure.Check(replayed == (long)fixture["expectedAttemptsAfterReplay"]!, $"the replayed task recorded {replayed} attempts");
        Failure.Check(Matcher.Same(seen.ToList(), fixture.GetValueOrDefault("expectedHandlerOrder")), $"handler order [{string.Join(", ", seen)}]");
        Failure.Check(runs == (long)fixture["expectedHandlerRuns"]!, $"the handler ran {runs} times");
        Failure.Check(operations == (long)fixture["expectedCheckpointOperations"]!, $"the checkpoint operation ran {operations} times");
    }

    /// <summary>
    /// A heartbeat locks the task's runtime row, and recovery skips a locked row. So the runner holds
    /// every heartbeat until the recovery ends, as the other lanes do. The first heartbeat after that
    /// finds the recovered task and reports the lease as stale.
    /// </summary>
    private async Task LeaseLossAsync(OrderedDictionary<string, object?> fixture)
    {
        var taskId = await EnqueueAsync(
            TaskType(fixture),
            Json.Members(),
            Options(QueueName(fixture)) with { MaxAttempts = Runner.Int(fixture.GetValueOrDefault("maxAttempts")), RetryPolicy = RetryPolicy.Fixed(TimeSpan.Zero) });
        var started = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        using var recoveryEnded = new ManualResetEventSlim();
        var reasons = new ConcurrentQueue<CancelReason?>();
        var rejected = new ConcurrentQueue<object?>();
        Worker? holder = null;
        var hook = new Intercept.Callbacks(before: call =>
        {
            if (call.Is(SqlCatalogue.HeartbeatManyV2) && !recoveryEnded.Wait(TimeSpan.FromSeconds(5)))
            {
                throw new InvalidOperationException("a held heartbeat was never released");
            }
        });
        await using (var pool = Intercept.Create(_database, hook))
        {
            await using var subject = NewWorker(pool, fixture, options =>
            {
                options.Lease = Millis(fixture, "leaseMs");
                options.Heartbeat = Millis(fixture, "heartbeatMs");
            });
            subject.Handle<JsonElement, object?>(TaskType(fixture), async (context, _) =>
            {
                started.TrySetResult();
                await WaitForCancellationAsync("the lease loss never reached the handler", context.CancellationToken);
                reasons.Enqueue(context.CancelReason);
                foreach (var (name, write) in LateWrites(context))
                {
                    try
                    {
                        await write();
                    }
                    catch (LeaseLostException)
                    {
                        rejected.Enqueue(name);
                    }
                }

                // The worker survives the loss and would claim the retried attempt next, so claims
                // pause to keep the ready state observable.
                holder!.Pause();
                return Json.Members(("late", true));
            });
            holder = subject;
            var result = Running(subject, () => subject.RunOnceAsync());
            try
            {
                await Started(started, "the handler never started");
                await UpdateAsync($"UPDATE workhorse.task_runtime SET expires_at = clock_timestamp() - interval '1 millisecond' WHERE task_id = '{taskId}'");
                var recovered = await ValueAsync("SELECT rows_affected FROM workhorse.recover_expired_telemetry_v1(100, 0)");
                recoveryEnded.Set();
                Failure.Check(recovered == "1", $"recovery expired {recovered} leases, want 1");
                Failure.Check(await JoinAsync(result), "the worker did not report the lost run");
            }
            finally
            {
                recoveryEnded.Set();
            }
        }

        Failure.Check(fixture.GetValueOrDefault("expectedRunOutcome") is "processed", "unexpected run outcome");
        Failure.Check(reasons.SequenceEqual([CancelReason.LeaseLost]), $"abort reasons [{string.Join(", ", reasons)}]");
        Failure.Check(Matcher.Same(rejected.ToList(), fixture.GetValueOrDefault("portableRejectedWrites")), $"rejected writes [{string.Join(", ", rejected)}]");
        await ExpectStateAsync(taskId, Get(fixture, "expectedState"));
        await ExpectOutcomesAsync(taskId, [fixture.GetValueOrDefault("expectedAttemptOutcome")]);
    }

    /// <summary>Each durable write that a handler can try after its lease is gone, by its portable name.</summary>
    private static List<(string Name, Func<Task> Write)> LateWrites(HandlerContext context) =>
    [
        ("checkpoint", () => context.CheckpointAsync("too-late", _ => Task.FromResult(Json.Element(Json.Members(("late", true)))))),
        ("sleep", () => context.SleepAsync("too-late", TimeSpan.FromMilliseconds(1))),
        ("sleepUntil", () => context.SleepUntilAsync("too-late-until", DateTimeOffset.UtcNow)),
        ("waitForSignal", () => context.WaitForSignalAsync<JsonElement>("too-late", null)),
        ("waitForHuman", () => context.WaitForHumanAsync<JsonElement, JsonElement>("too-late", Json.Element(Json.Members(("late", true))), null)),
        ("runChild", () => context.RunChildAsync<JsonElement, JsonElement>("too-late", "protocol.child", Json.Element(Json.Members()), new EnqueueOptions())),
        ("runChildren", () => context.RunChildrenAsync([new ChildRequest { Name = "too-late", TaskType = "protocol.child", Payload = Json.Element(Json.Members()) }])),
    ];

    /// <summary>
    /// Each case throws the error that a durable replay raises. A conflict is terminal, so the retry
    /// callback never runs; a limit, an occupied wait, and a plain error retry once.
    /// </summary>
    private async Task ReplayConflictAsync(OrderedDictionary<string, object?> fixture)
    {
        foreach (var item in (List<object?>)fixture["cases"]!)
        {
            var entry = Runner.Object(item, "case");
            var kind = Runner.Text(entry.GetValueOrDefault("errorKind"));
            var name = $"{QueueName(fixture)}-{kind}";
            var taskId = await EnqueueAsync(TaskType(fixture), Json.Members(), Options(name) with { MaxAttempts = Runner.Int(fixture.GetValueOrDefault("maxAttempts")) });
            if (entry.GetValueOrDefault("redactErrorDetails") is true)
            {
                await UpdateAsync($"UPDATE workhorse.task SET payload_redact_keys = ARRAY['secret'] WHERE id = '{taskId}'");
            }

            var delayCalls = 0;
            await using (var pool = Intercept.Create(_database, Intercept.Hook.None))
            {
                var options = BaseOptions(name, $"dotnet-{name}");
                options.RetryDelay = (_, _) =>
                {
                    Interlocked.Increment(ref delayCalls);
                    return TimeSpan.FromSeconds(60);
                };
                await using var subject = new Worker(pool.DataSource, options);
                subject.Handle<JsonElement>(TaskType(fixture), (_, _) => Task.FromException(kind switch
                {
                    "checkpoint" => new ConflictException("checkpoint", "saved"),

                    // A conflict inside a plain wrapper is still terminal (SM-1512).
                    "wrapped-checkpoint" => new InvalidOperationException("wrapped", new ConflictException("checkpoint", "saved")),
                    "wait" => new ConflictException("sleep", "saved"),
                    "child" or "redacted-child" => new ConflictException("runChild", "saved"),
                    "child-set" => new ConflictException("runChildren", "saved"),
                    "human" => new ConflictException("waitForHuman", "saved"),
                    "child-limit" => new LimitExceededException("runChild", "saved"),
                    "signal-wait" => new AlreadyWaitingException("waitForSignal", "saved"),

                    // The C# counterpart of the Ruby lane's StandardError, as the JVM lane throws Exception.
#pragma warning disable CA2201
                    "transient" => new Exception("transient"),
#pragma warning restore CA2201
                    _ => new InvalidOperationException($"unknown error kind {kind}"),
                }));
                Failure.Check(await subject.RunOnceAsync(), $"{kind}: the conflict handler did not run");
            }

            var names = Runner.Object(entry.GetValueOrDefault("expectedErrorNames"), "names");
            Failure.Check(names.ContainsKey(Language), $"{kind}: expectedErrorNames has no {Language} entry");
            var expected = Json.Members(("state", entry.GetValueOrDefault("expectedState")), ("attempt", entry.GetValueOrDefault("expectedAttempt")), ("errorName", names[Language]));
            var actual = await StateAsync(taskId);
            Failure.Check(Matcher.Same(expected, actual), $"{kind}: task state {Matcher.Render(actual)}, want {Matcher.Render(expected)}");
            var terminal = entry.GetValueOrDefault("expectedState") is "failed";
            Failure.Check(delayCalls == (terminal ? 0 : 1), $"{kind}: the retry callback ran {delayCalls} times");
            await ExpectOutcomesAsync(taskId, [terminal ? "failed" : "retry"]);
        }
    }

    /// <summary>
    /// Commits a budgeted task on one queue while the claim of that queue is already past its first
    /// read. A test session parks the late claim on the admission shards of its queue. The
    /// counterpart of <c>typescript/core/test/support/budget-race.ts</c>.
    /// </summary>
    private async Task BudgetRaceAsync(OrderedDictionary<string, object?> fixture)
    {
        var name = QueueName(fixture);
        var lateQueue = $"{name}-late";
        var holderQueue = $"{name}-holder";
        var rate = Get(fixture, "queueRate");
        var lease = checked((int)(long)fixture["leaseMs"]!);
        await _queue.SyncBudgetsAsync(name, [new BudgetDefinition { Name = name, MaxActive = Runner.Int(fixture.GetValueOrDefault("maxActive")) }]);
        await _queue.SyncRateLimitPoliciesAsync(name, [new RateLimitPolicyDefinition
        {
            Queue = lateQueue,
            Rate = new RateLimit { Limit = checked((int)(long)rate["limit"]!), Interval = TimeSpan.FromMilliseconds((long)rate["intervalMs"]!), Burst = checked((int)(long)rate["burst"]!) },
        }]);

        // One unbudgeted start proves that the late queue admits before the blocker parks its claim.
        await EnqueueAsync(TaskType(fixture), Json.Members(("role", "bucket")), Options(lateQueue));
        await using (var bucket = await _database.OpenAsync())
        {
            Failure.Check((await ClaimAsync(bucket, lateQueue, $"{name}-bucket", lease)) == 1, "the late queue did not admit its unbudgeted start");
        }

        await EnqueueAsync(TaskType(fixture), Json.Members(("role", "holder")), Options(holderQueue) with { Budget = name });
        await using var blocker = await _database.OpenAsync();
        await using var late = await _database.OpenAsync();
        await using var holder = await _database.OpenAsync();
        var latePid = late.ProcessID;
        Task<int>? lateClaim = null;
        NpgsqlTransaction? blocking = null;
        NpgsqlTransaction? holding = null;
        try
        {
            blocking = await blocker.BeginTransactionAsync();
            Database.Run(
                blocker,
                $"SELECT pg_advisory_xact_lock(hashtextextended('workhorse:admission-shard:' || '{lateQueue.Replace("'", "''", StringComparison.Ordinal)}' || ':' || shard, 0)) FROM generate_series(0, 7) AS shard");
            lateClaim = Task.Run(() => ClaimAsync(late, lateQueue, $"{name}-late", lease));
            await EventuallyAsync("the late claim never reached the admission shards", 10, () => WaitsOnAsync(latePid, null));
            await EnqueueAsync(TaskType(fixture), Json.Members(("role", "late")), Options(lateQueue) with { Budget = name });
            holding = await holder.BeginTransactionAsync();
            var holderClaims = await ClaimAsync(holder, holderQueue, $"{name}-holder", lease);
            await blocking.CommitAsync();
            var claim = lateClaim;
            await EventuallyAsync("the late claim neither finished nor waited for the budget", 10, async () => claim.IsCompleted || await WaitsOnAsync(latePid, "advisory"));
            await holding.CommitAsync();
            var lateClaims = await lateClaim.WaitAsync(Patience);
            var active = long.Parse(
                (await ValueAsync($"SELECT count(*) FROM workhorse.task_runtime WHERE state = 'active' AND budget_name = '{name}'"))!,
                CultureInfo.InvariantCulture);
            Failure.Check(holderClaims == (long)fixture["expectedHolderClaims"]!, $"the holder claimed {holderClaims}");
            Failure.Check(lateClaims == (long)fixture["expectedLateClaims"]!, $"the late claim admitted {lateClaims}");
            Failure.Check(active == (long)fixture["expectedActive"]!, $"{active} budgeted tasks are active");
        }
        finally
        {
            foreach (var transaction in new[] { blocking, holding })
            {
                if (transaction is { Connection: not null })
                {
                    try
                    {
                        await transaction.RollbackAsync();
                    }
                    catch (InvalidOperationException)
                    {
                        // The transaction already ended.
                    }
                }
            }

            if (lateClaim is not null)
            {
                await Settled(lateClaim);
            }
        }
    }

    /// <summary>The task stores the caller's W3C trace context at enqueue, and the handler span continues it.</summary>
    private async Task TraceAsync(OrderedDictionary<string, object?> fixture)
    {
        using var recording = new TelemetryRecorder();
        Guid taskId;
        ActivityContext caller;
        using (var span = TelemetryRecorder.Caller.StartActivity("caller") ?? throw new Failure("the caller span did not start"))
        {
            caller = span.Context;
            taskId = await EnqueueAsync(TaskType(fixture), Json.Members(), Options(QueueName(fixture)));
        }

        var stored = Json.Parse((await ValueAsync($"SELECT COALESCE(trace_context::text, 'null') FROM workhorse.task WHERE id = '{taskId}'"))!);
        var parts = (Json.Object(stored)?.GetValueOrDefault("traceparent") as string ?? "").Split('-');
        Failure.Check(parts.Length == 4 && parts[1] == caller.TraceId.ToHexString(), "enqueue stored no caller trace context");
        await using (var pool = Intercept.Create(_database, Intercept.Hook.None))
        {
            await using var subject = NewWorker(pool, fixture);
            subject.Handle<JsonElement>(TaskType(fixture), (_, _) => Task.CompletedTask);
            Failure.Check(await subject.RunOnceAsync(), "the worker did not run the traced task");
        }

        var handlers = recording.SpansNamed(Names.SpanHandler, span => Equals(span.GetTagItem(Names.TaskId), taskId.ToString()));
        Failure.Check(handlers.Count == 1, $"recorded {handlers.Count} handler spans, want 1");
        Failure.Check(handlers[0].TraceId == caller.TraceId, "the handler span left the enqueuing trace");
        Failure.Check(handlers[0].ParentSpanId.ToHexString() == parts[2], "the handler span's parent is not the stored context");
    }

    private async Task MissingHandlerAsync(OrderedDictionary<string, object?> fixture)
    {
        var name = QueueName(fixture);
        var taskId = await EnqueueAsync(TaskType(fixture), Json.Members(("index", 1L)), Options(name));
        var handled = new ConcurrentQueue<object?>();
        await using (var pool = Intercept.Create(_database, Intercept.Hook.None))
        {
            var olderOptions = BaseOptions(name, $"dotnet-{Runner.Text(fixture["id"])}-older");
            olderOptions.Lease = Millis(fixture, "leaseMs");
            olderOptions.PollInterval = Millis(fixture, "pollMs");
            await using var older = new Worker(pool.DataSource, olderOptions);
            older.Handle<JsonElement>((string)fixture["registeredTaskType"]!, (_, _) => Task.CompletedTask);

            // A pass that released each task that it claimed made no progress, so it returns false.
            var processed = fixture.GetValueOrDefault("expectedReleasedPassOutcome") is not "unprocessed";
            Failure.Check(await older.RunOnceAsync() == processed, "the released-only pass reported progress");
            await ExpectStateAsync(taskId, Get(fixture, "expectedAfterRelease"));

            // The refusal belongs to no attempt, so the task keeps the attempt it was enqueued with.
            var attempts = await AttemptsAsync(taskId);
            Failure.Check(attempts == (long)fixture["expectedAttempts"]!, $"the release recorded {attempts} attempts");
            var releases = await ReleasesAsync(taskId);
            Failure.Check(releases == (long)fixture["expectedReleaseEvents"]!, $"the release recorded {releases} events");

            // The worker keeps no state between calls. The next call claims the ready task again at
            // once, inside the poll interval, releases it, and returns false again.
            Failure.Check(await older.RunOnceAsync() == processed, "the pass after the release reported progress");
            attempts = await AttemptsAsync(taskId);
            Failure.Check(attempts == (long)fixture["expectedAttempts"]!, $"the next pass recorded {attempts} attempts");
            releases = await ReleasesAsync(taskId);
            Failure.Check(releases == (long)fixture["expectedReleaseEventsAfterNextPass"]!, $"after the next pass the task had {releases} release events");
            await ExpectStateAsync(taskId, Get(fixture, "expectedAfterRelease"));

            var newerOptions = BaseOptions(name, $"dotnet-{Runner.Text(fixture["id"])}-newer");
            newerOptions.Lease = Millis(fixture, "leaseMs");
            await using var newer = new Worker(pool.DataSource, newerOptions);
            newer.Handle<JsonElement>(TaskType(fixture), (_, payload) =>
            {
                handled.Enqueue(Json.From(payload));
                return Task.CompletedTask;
            });
            Failure.Check(await newer.RunOnceAsync(), "the registered worker did not run the task");
        }

        Failure.Check(Matcher.Same(handled.ToList(), new List<object?> { Json.Members(("index", 1L)) }), $"the handler received {Matcher.Render(handled.ToList())}");
        await ExpectStateAsync(taskId, Get(fixture, "expectedAfterHandled"));
    }

    /// <summary>
    /// Runs a listening worker that has no handler for the one ready task. Each release wakes the
    /// worker, so the gap between two releases shows its bound.
    /// </summary>
    private async Task ReleaseWaitAsync(OrderedDictionary<string, object?> fixture)
    {
        var name = QueueName(fixture);
        var taskId = await EnqueueAsync(TaskType(fixture), Json.Members(), Options(name));
        var listened = false;
        await using (var pool = Intercept.Create(_database, Intercept.Hook.None))
        {
            var options = BaseOptions(name, $"dotnet-{Runner.Text(fixture["id"])}");
            options.PollingOnly = false;
            options.Lease = Millis(fixture, "leaseMs");
            options.PollInterval = Millis(fixture, "pollMs");
            await using var subject = new Worker(pool.DataSource, options);
            subject.Handle<JsonElement>((string)fixture["registeredTaskType"]!, (_, _) => Task.CompletedTask);
            var run = Running(subject, () => subject.RunAsync(CancellationToken.None));
            try
            {
                // Without a listener, the worker gets no notification, and the fixture proves nothing.
                var start = Stopwatch.GetTimestamp();
                while (Stopwatch.GetElapsedTime(start) < TimeSpan.FromMilliseconds((long)fixture["runMs"]!))
                {
                    listened |= subject.ListeningForTests;
                    await Task.Delay(10);
                }
            }
            finally
            {
                subject.Stop();
            }

            await JoinAsync(run);
        }

        Failure.Check(listened, "no session listened while the worker ran");
        var times = (await RowsAsync(
                $"SELECT (extract(epoch FROM occurred_at) * 1000)::float8 AS at_ms FROM workhorse.task_event WHERE task_id = '{taskId}' AND event_type = 'released' ORDER BY occurred_at"))
            .Select(row => Convert.ToDouble(Json.Object(row)!["at_ms"], CultureInfo.InvariantCulture))
            .ToList();
        Failure.Check(
            times.Count >= (long)fixture["expectedMinimumReleases"]! && times.Count <= (long)fixture["expectedMaximumReleases"]!,
            $"the worker released the task {times.Count} times while it ran");
        for (var index = 1; index < times.Count; index++)
        {
            var gap = times[index] - times[index - 1];
            Failure.Check(gap >= (long)fixture["expectedMinimumReleaseGapMs"]!, $"the worker released the task again after {Math.Round(gap)} ms");
        }
    }

    /// <summary>
    /// Runs a worker that can listen, but holds its <c>LISTEN</c> until the first task ran. Without a
    /// live subscription, the worker polls at the polling-only base. With one, it waits for the
    /// notification poll interval after each empty claim. When the runner ends the listener session,
    /// the loss wakes the worker, and it polls at the polling-only base again.
    /// </summary>
    private async Task SubscriptionRecoveryAsync(OrderedDictionary<string, object?> fixture)
    {
        var name = QueueName(fixture);
        // The runner can replace the gate to hold the next LISTEN. Each gate opens in the finally path.
        var listenGate = new ManualResetEventSlim(false);
        var gates = new ConcurrentQueue<ManualResetEventSlim>([listenGate]);
        // The backend process id of the connection that ran the last LISTEN.
        var listenerPid = 0;
        var recording = 1;
        var recoveryEnd = 0;
        long lostAt = 0;
        long enqueuedAfterLoss = 0;

        // Each claim_many_v1 call's start, its return to the worker, and whether it found a task.
        var claims = new ConcurrentQueue<(long Start, long End, long Rows)>();
        var starts = new ConcurrentDictionary<Intercept.Call, long>();
        var handled = new ConcurrentQueue<string>();
        var hook = new Intercept.Callbacks(
            before: call =>
            {
                if (call.Sql == SessionCommands.Listen)
                {
                    // Until the runner releases it, the worker has no live subscription.
                    Volatile.Read(ref listenGate).Wait();
                    Volatile.Write(ref listenerPid, call.ProcessId);
                }
                else if (call.Is(SqlCatalogue.ClaimManyV1))
                {
                    starts[call] = Stopwatch.GetTimestamp();
                }
            },
            after: call =>
            {
                if (!call.Is(SqlCatalogue.ClaimManyV1))
                {
                    return;
                }

                starts.TryRemove(call, out var start);
                if (Volatile.Read(ref recording) == 1)
                {
                    claims.Enqueue((start, Stopwatch.GetTimestamp(), call.Rows));
                }
            });
        await using (var pool = Intercept.Create(_database, hook))
        {
            var options = BaseOptions(name, $"dotnet-{Runner.Text(fixture["id"])}");
            options.PollingOnly = false;
            await using var subject = new Worker(pool.DataSource, options);
            subject.Handle<JsonElement>(TaskType(fixture), (_, payload) =>
            {
                handled.Enqueue(payload.GetProperty("task").GetString()!);
                return Task.CompletedTask;
            });
            var run = Running(subject, () => subject.RunAsync(CancellationToken.None));
            try
            {
                await EventuallyAsync("the worker made no empty claim before the first enqueue", 5, () => claims.Any(claim => claim.Rows == 0));
                await EnqueueAsync(TaskType(fixture), Json.Members(("task", "first")), Options(name));
                await EventuallyAsync("the worker did not run the first task", 5, () => handled.Count == 1);

                listenGate.Set();
                await EventuallyAsync("the listener did not run LISTEN", 5, () => subject.ListeningForTests);
                await EnqueueAsync(TaskType(fixture), Json.Members(("task", "second")), Options(name));
                await EventuallyAsync("the worker did not run the second task", 7, () => handled.Count == 2);
                await Task.Delay(Millis(fixture, "observeAfterRecoveryMs"));
                recoveryEnd = claims.Count;

                // The next empty claim starts a new wait at the notification base. Then the runner ends
                // the live listener session and holds the next LISTEN, so the subscription is lost.
                await EventuallyAsync("the worker made no empty claim after the second task", 7, () => claims.Skip(recoveryEnd).Any(claim => claim.Rows == 0));
                var held = new ManualResetEventSlim(false);
                gates.Enqueue(held);
                Volatile.Write(ref listenGate, held);
                var pid = Volatile.Read(ref listenerPid);
                Failure.Check(pid != 0, "the runner did not see the pid of the listener session");
                await ValueAsync($"SELECT pg_terminate_backend({pid})::text");
                await EventuallyAsync("the listener session did not end", 7, async () => await ValueAsync($"SELECT 1 FROM pg_stat_activity WHERE pid = {pid}") is null);
                lostAt = Stopwatch.GetTimestamp();

                // The loss wakes the worker. The third task waits for the claims after that wake.
                await EventuallyAsync("the worker made no claim after the subscription was lost", 7, () => claims.Any(claim => claim.Start >= lostAt));
                enqueuedAfterLoss = Stopwatch.GetTimestamp();
                await EnqueueAsync(TaskType(fixture), Json.Members(("task", "third")), Options(name));
                await EventuallyAsync("the worker did not run the third task", 7, () => handled.Count == 3);
            }
            finally
            {
                Volatile.Write(ref recording, 0);
                foreach (var gate in gates)
                {
                    gate.Set();
                }

                subject.Stop();
                await Settled(run);
                foreach (var gate in gates)
                {
                    gate.Dispose();
                }
            }
        }

        var ordered = claims.OrderBy(claim => claim.Start).ToList();
        var found = Enumerable.Range(0, ordered.Count).Where(index => ordered[index].Rows > 0).ToList();
        Failure.Check(found.Count == 3, $"{found.Count} claims found a task, want 3");
        Failure.Check(found[0] > 0, "no empty claim came before the first task");
        var first = (long)Stopwatch.GetElapsedTime(ordered[found[0] - 1].End, ordered[found[0]].Start).TotalMilliseconds;
        var maximum = (long)fixture["expectedMaximumClaimDelayMs"]!;
        Failure.Check(first <= maximum, $"without a live subscription, the claim of the first task waited {first} ms, want at most {maximum} ms");
        // With a live subscription, the worker waits the notification base after an empty claim.
        var recovered = claims.Take(recoveryEnd).OrderBy(claim => claim.Start).ToList();
        var lastFound = recovered.FindLastIndex(claim => claim.Rows > 0);
        var empty = recovered.Skip(Math.Max(0, lastFound)).Count(claim => claim.Rows == 0);
        var allowed = (long)fixture["expectedMaximumEmptyClaimsAfterRecovery"]!;
        Failure.Check(empty <= allowed, $"with a live subscription, {empty} empty claims followed the second task, want at most {allowed}");

        // After the loss, the worker claims at once and then polls at the polling-only base again.
        var lossMaximum = (long)fixture["expectedMaximumClaimDelayAfterLossMs"]!;
        var afterLoss = (long)Stopwatch.GetElapsedTime(lostAt, ordered.First(claim => claim.Start >= lostAt).Start).TotalMilliseconds;
        Failure.Check(afterLoss <= lossMaximum, $"after the subscription was lost, the first claim waited {afterLoss} ms, want at most {lossMaximum} ms");
        var third = (long)Stopwatch.GetElapsedTime(enqueuedAfterLoss, ordered[found[2]].Start).TotalMilliseconds;
        Failure.Check(third <= lossMaximum, $"after the subscription was lost, the claim of the third task waited {third} ms, want at most {lossMaximum} ms");
    }

    private async Task JsonRoundTripAsync(OrderedDictionary<string, object?> fixture)
    {
        var payload = fixture.GetValueOrDefault("payload");
        var taskId = await EnqueueAsync(TaskType(fixture), payload, Options(QueueName(fixture)));
        var received = new ConcurrentQueue<object?>();
        await using (var pool = Intercept.Create(_database, Intercept.Hook.None))
        {
            await using var subject = NewWorker(pool, fixture);
            subject.Handle<JsonElement, JsonElement>(TaskType(fixture), (_, handled) =>
            {
                received.Enqueue(Json.From(handled));
                return Task.FromResult(handled);
            });
            Failure.Check(await subject.RunOnceAsync(), "the worker did not run the task");
        }

        Failure.Check(received.Count == 1 && Exact(received.Single(), payload), $"the handler received {Matcher.Render(received.ToList())}");
        var stored = Json.Parse((await ValueAsync($"SELECT payload::text FROM workhorse.task WHERE id = '{taskId}'"))!);
        Failure.Check(Exact(stored, payload), $"the stored payload is {Matcher.Render(stored)}");
        var result = Json.Parse((await ValueAsync($"SELECT result::text FROM workhorse.task_outcome WHERE task_id = '{taskId}'"))!);
        Failure.Check(Exact(result, payload), $"the stored result is {Matcher.Render(result)}");
        await ExpectStateAsync(taskId, Get(fixture, "expectedState"));
        await ExpectOutcomesAsync(taskId, [fixture.GetValueOrDefault("expectedAttemptOutcome")]);
    }

    /// <summary>
    /// The handler returns an array of zeros, whose <c>jsonb</c> text is longer than its compact JSON.
    /// One pass can also run the immediate retry, so the runner passes until the task settles.
    /// </summary>
    private async Task OversizedResultAsync(OrderedDictionary<string, object?> fixture)
    {
        var name = QueueName(fixture);
        if (fixture.GetValueOrDefault("tier") is "fast")
        {
            await using var connection = await _database.DataSource.OpenConnectionAsync();
            await Sql.RowsAsync(
                connection,
                SqlCatalogue.SetQueueTierV1,
                [Parameters.Text(name), Parameters.Text("fast"), Parameters.Text("runtime-fixture"), Parameters.Text(Runner.Text(fixture["id"]))],
                CancellationToken.None);
        }

        var maxAttempts = checked((int)(long)fixture["maxAttempts"]!);
        var taskId = await EnqueueAsync(TaskType(fixture), fixture.GetValueOrDefault("oversizedZeros"), Options(name) with { MaxAttempts = maxAttempts, RetryPolicy = RetryPolicy.Fixed(TimeSpan.Zero) });
        var settled = Get(fixture, "expectedSettled");
        var names = Get(fixture, "expectedErrorNames");
        Failure.Check(names.ContainsKey(Language), $"expectedErrorNames has no {Language} entry");
        var errorName = names[Language];
        await using var pool = Intercept.Create(_database, Intercept.Hook.None);
        await using var subject = NewWorker(pool, fixture);
        subject.Handle<long, IReadOnlyList<long>>(TaskType(fixture), (_, count) => Task.FromResult<IReadOnlyList<long>>(new long[count]));
        for (var attempt = 0; attempt < maxAttempts; attempt++)
        {
            if (Matcher.Same((await StateAsync(taskId))["state"], settled["state"]))
            {
                break;
            }

            Failure.Check(await subject.RunOnceAsync(), "the worker did not run the oversized task");
        }

        var task = await StateAsync(taskId);
        Failure.Check(
            Matcher.Same(task["state"], settled["state"]) && Matcher.Same(task["attempt"], settled["attempt"]) && Matcher.Same(task["errorName"], errorName),
            $"the oversized task is {task["state"]}/{task["attempt"]} with error {task["errorName"]}, want {settled["state"]}/{settled["attempt"]} with {errorName}");
        var fittingId = await EnqueueAsync(TaskType(fixture), fixture.GetValueOrDefault("fittingZeros"), Options(name));
        Failure.Check(await subject.RunOnceAsync(), "the worker did not run the fitting task");
        var fitting = await StateAsync(fittingId);
        var expected = Get(fixture, "expectedFitting");
        Failure.Check(
            Matcher.Same(fitting["state"], expected["state"]) && Matcher.Same(fitting["attempt"], expected["attempt"]),
            $"the fitting task is {fitting["state"]}/{fitting["attempt"]}: {fitting["errorName"]}");
    }

    /// <summary>
    /// One batch handler receives every task, highest priority first. Each member settles on its own:
    /// one succeeds, one retries, and one fails. The handler pauses the worker, so the first pass ends
    /// after one batch, and the second pass runs the retry.
    /// </summary>
    private async Task BatchAsync(OrderedDictionary<string, object?> fixture)
    {
        var name = QueueName(fixture);
        var taskIds = new Dictionary<string, Guid>(StringComparer.Ordinal);
        foreach (var item in (List<object?>)fixture["tasks"]!)
        {
            var task = Runner.Object(item, "task");
            var key = Runner.Text(task["key"]);
            taskIds[key] = await EnqueueAsync(
                TaskType(fixture),
                Json.Members(("key", key), ("outcome", task.GetValueOrDefault("outcome"))),
                Options(name) with
                {
                    Priority = Runner.Int(task.GetValueOrDefault("priority")),
                    MaxAttempts = Runner.Int(task.GetValueOrDefault("maxAttempts")),
                    RetryPolicy = RetryPolicy.Fixed(TimeSpan.Zero),
                });
        }

        var seen = new ConcurrentQueue<object?>();
        Worker? holder = null;
        await using var pool = Intercept.Create(_database, Intercept.Hook.None);
        await using var subject = NewWorker(pool, fixture, options => options.Concurrency = checked((int)(long)fixture["concurrency"]!));
        subject.HandleBatch<JsonElement>(
            TaskType(fixture),
            new BatchOptions { MaxSize = checked((int)(long)fixture["batchMaxSize"]!), Linger = TimeSpan.FromMilliseconds(100) },
            (items, _) =>
            {
                holder?.Pause();
                var outcomes = new List<BatchHandlerOutcome>();
                foreach (var item in items)
                {
                    var payload = Runner.Object(Json.From(item.Payload), "payload");
                    seen.Enqueue(Runner.Text(payload["key"]));
                    var attempt = item.Context.Task.Attempt;
                    outcomes.Add(payload.GetValueOrDefault("outcome") is "succeed" || attempt > 1
                        ? new BatchSucceeded(Json.Element(Json.Members(("attempt", (long)attempt))))
                        : new BatchFailed(new InvalidOperationException($"{payload.GetValueOrDefault("outcome")} on attempt {attempt}")));
                }

                return Task.FromResult<IReadOnlyList<BatchHandlerOutcome>>(outcomes);
            });
        holder = subject;
        Failure.Check(await subject.RunOnceAsync(), "the first run delivered no batch");
        Failure.Check(Matcher.Same(seen.ToList(), fixture.GetValueOrDefault("expectedHandlerOrder")), $"handler order [{string.Join(", ", seen)}], want {Matcher.Render(fixture.GetValueOrDefault("expectedHandlerOrder"))}");
        await BatchStatesAsync(taskIds, Get(fixture, "expectedAfterFirstRun"), "first");
        subject.Resume();
        Failure.Check(await subject.RunOnceAsync(), "the second run delivered no batch");
        await BatchStatesAsync(taskIds, Get(fixture, "expectedAfterSecondRun"), "second");
    }

    private async Task BatchStatesAsync(Dictionary<string, Guid> taskIds, OrderedDictionary<string, object?> expected, string run)
    {
        foreach (var (key, value) in expected)
        {
            var want = Runner.Object(value, "state");
            Failure.Check(taskIds.TryGetValue(key, out var taskId), $"the fixture names no task {key}");
            var actual = await StateAsync(taskId);
            Failure.Check(
                Matcher.Same(want["state"], actual["state"]) && Matcher.Same(want["attempt"], actual["attempt"]),
                $"after the {run} run {key} is {Matcher.Render(actual)}, want {Matcher.Render(want)}");
        }
    }

    /// <summary>
    /// The handler waits for its cancellation. With an <c>error</c> handler result it then throws the
    /// cancellation of its token; with a <c>value</c> one it returns a value. One attempt makes a
    /// charged attempt fail the task for good.
    /// </summary>
    private async Task ShutdownCancellationAsync(OrderedDictionary<string, object?> fixture)
    {
        var behavior = Get(fixture, "shutdownBehavior");
        Failure.Check(behavior.ContainsKey(Language), $"shutdownBehavior has no {Language} entry");
        Failure.Check(behavior[Language] is "cancel", "the fixture does not expect a cancelling C# worker");
        var taskId = await EnqueueAsync(TaskType(fixture), Json.Members(), Options(QueueName(fixture)) with { MaxAttempts = Runner.Int(fixture.GetValueOrDefault("maxAttempts")) });
        var started = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var reasons = new ConcurrentQueue<CancelReason?>();
        await using (var pool = Intercept.Create(_database, Intercept.Hook.None))
        {
            await using var subject = NewWorker(pool, fixture, options => options.ShutdownGrace = Millis(fixture, "shutdownGraceMs"));
            subject.Handle<JsonElement, object?>(TaskType(fixture), async (context, _) =>
            {
                started.TrySetResult();
                await WaitForCancellationAsync("the shutdown never reached the handler", context.CancellationToken);
                reasons.Enqueue(context.CancelReason);
                if (fixture.GetValueOrDefault("handlerResult") is "error")
                {
                    context.CancellationToken.ThrowIfCancellationRequested();
                }

                return Json.Members(("finished", true));
            });
            var run = Running(subject, () => subject.RunAsync(CancellationToken.None));
            await Started(started, "the handler never started");
            subject.Stop();
            await JoinAsync(run);
        }

        Failure.Check(reasons.SequenceEqual([CancelReason.Shutdown]), $"the handler saw cancellation reasons [{string.Join(", ", reasons)}]");
        var expected = Get(fixture, "expectedCancelled");
        var actual = await StateAsync(taskId);
        Failure.Check(
            Matcher.Same(actual["state"], expected["state"]) && Matcher.Same(actual["attempt"], expected["attempt"]),
            $"the stopped task is {actual["state"]}/{actual["attempt"]}, want {expected["state"]}/{expected["attempt"]}");
        var events = (await RowsAsync($"SELECT event_type FROM workhorse.task_event WHERE task_id = '{taskId}' ORDER BY occurred_at, event_id"))
            .Select(row => Json.Object(row)!["event_type"])
            .ToList();
        Failure.Check(Matcher.Same(events, expected.GetValueOrDefault("events")), $"the stopped task recorded events {Matcher.Render(events)}, want {Matcher.Render(expected.GetValueOrDefault("events"))}");
    }

    private async Task HeartbeatFailureAsync(OrderedDictionary<string, object?> fixture)
    {
        var taskId = await EnqueueAsync(TaskType(fixture), Json.Members(), Options(QueueName(fixture)));
        var started = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        using var release = new ManualResetEventSlim();
        var cancellations = 0;
        var timeout = (long)fixture["renewalTimeoutMs"]! / 1000;
        await using var pool = Intercept.Create(_database, Intercept.Hook.None);
        await using var subject = NewWorker(pool, fixture, options =>
        {
            options.Lease = Millis(fixture, "leaseMs");
            options.Heartbeat = Millis(fixture, "heartbeatMs");
        });
        subject.Handle<JsonElement>(TaskType(fixture), async (context, _) =>
        {
            started.TrySetResult();
            await WaitAsync(release, "the handler was never released");
            if (context.CancellationToken.IsCancellationRequested)
            {
                Interlocked.Increment(ref cancellations);
            }
        });
        var result = Running(subject, () => subject.RunOnceAsync());
        try
        {
            await Started(started, "the handler never started");
            var renewed = await RenewalAsync(taskId, await ExpiryAsync(taskId), timeout);
            var minimum = (long)fixture["expectedMinimumFailedRounds"]!;
            var during = renewed;
            await InjectedAsync(Get(fixture, "injection"), async failedCalls =>
            {
                await EventuallyAsync($"fewer than {minimum} heartbeat rounds failed", timeout, async () => await failedCalls() >= minimum);
                during = await ExpiryAsync(taskId);
            });

            // Once the rounds answer again the lease renews, so the failures cost the attempt nothing.
            await RenewalAsync(taskId, during, timeout);
            release.Set();
            Failure.Check(await JoinAsync(result), "the worker did not run the task");
        }
        finally
        {
            release.Set();
            await Settled(result);
        }

        Failure.Check(cancellations == (long)fixture["expectedCancellations"]!, "the handler saw a cancellation");
        await ExpectStateAsync(taskId, Get(fixture, "expectedState"));
        await ExpectOutcomesAsync(taskId, [fixture.GetValueOrDefault("expectedAttemptOutcome")]);
    }

    /// <summary>
    /// Busy heartbeat rounds renew nothing, and the worker retries only the busy lease sooner than the
    /// next regular round. The injected function answers <c>busy</c> for its first calls and records
    /// each one, then hands every call to the real function, which renews the lease.
    /// </summary>
    private async Task HeartbeatBusyAsync(OrderedDictionary<string, object?> fixture)
    {
        var taskId = await EnqueueAsync(TaskType(fixture), Json.Members(), Options(QueueName(fixture)));
        var started = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        using var release = new ManualResetEventSlim();
        var cancellations = 0;
        var timeout = (long)fixture["renewalTimeoutMs"]! / 1000;
        var expected = (long)fixture["expectedBusyRounds"]!;
        var injection = Get(fixture, "injection");
        var rounds = new List<object?>();
        await using (var pool = Intercept.Create(_database, Intercept.Hook.None))
        {
            await using var subject = NewWorker(pool, fixture, options =>
            {
                options.Lease = Millis(fixture, "leaseMs");
                options.Heartbeat = Millis(fixture, "heartbeatMs");
            });
            subject.Handle<JsonElement>(TaskType(fixture), async (context, _) =>
            {
                started.TrySetResult();
                await WaitAsync(release, "the handler was never released", TimeSpan.FromSeconds(30));
                if (context.CancellationToken.IsCancellationRequested)
                {
                    Interlocked.Increment(ref cancellations);
                }
            });
            var result = Running(subject, () => subject.RunOnceAsync());
            try
            {
                await Started(started, "the handler never started");
                await RenewalAsync(taskId, await ExpiryAsync(taskId), timeout);
                await InjectedBodyAsync(injection, async () =>
                {
                    var query = (string)injection["roundsQuery"]!;
                    await EventuallyAsync($"fewer than {expected} busy heartbeat rounds ran", timeout, async () =>
                    {
                        rounds = await RowsAsync(query);
                        return rounds.Count >= expected;
                    });

                    // The busy rounds renewed nothing. The next round reaches the real function.
                    await RenewalAsync(taskId, await ExpiryAsync(taskId), timeout);
                });
                release.Set();
                Failure.Check(await JoinAsync(result), "the worker did not run the task");
            }
            finally
            {
                release.Set();
                await Settled(result);
            }
        }

        var busy = rounds.Take((int)expected).Select(row => Json.Object(row)!).ToList();
        var maximumGap = Convert.ToDouble(fixture["maximumRetryGapMs"], CultureInfo.InvariantCulture);
        for (var index = 0; index < busy.Count; index++)
        {
            var leases = Convert.ToInt64(busy[index]["lease_count"], CultureInfo.InvariantCulture);
            Failure.Check(leases == 1, $"busy round {index} sent {leases} leases, want 1");
            if (index > 0)
            {
                var gap = Convert.ToDouble(busy[index]["round_at_ms"], CultureInfo.InvariantCulture) - Convert.ToDouble(busy[index - 1]["round_at_ms"], CultureInfo.InvariantCulture);
                Failure.Check(gap < maximumGap, $"busy round {index} came {gap} ms after the previous one");
            }
        }

        Failure.Check(cancellations == (long)fixture["expectedCancellations"]!, "the handler saw a cancellation");
        await ExpectStateAsync(taskId, Get(fixture, "expectedState"));
        await ExpectOutcomesAsync(taskId, [fixture.GetValueOrDefault("expectedAttemptOutcome")]);
    }

    /// <summary>
    /// <c>tick_v1</c> returns a phase failure as data, so a raising <c>promote_v1</c> models a lock
    /// timeout inside the promote phase. The runner records the rows of each <c>tick_v1</c> call in
    /// PostgreSQL, because Npgsql has no hook that shows the rows the worker reads.
    /// </summary>
    private async Task MaintenancePhaseErrorAsync(OrderedDictionary<string, object?> fixture)
    {
        var injection = Get(fixture, "injection");
        await InjectedAsync(injection, async _ =>
        {
            var taskId = await EnqueueAsync(TaskType(fixture), Json.Members(), Options(QueueName(fixture)));
            await RecordResultsAsync("tick_v1");
            using var recording = new TelemetryRecorder();
            await using (var pool = Intercept.Create(_database, Intercept.Hook.None))
            {
                // The first pass is due at once. A long interval keeps a slow pass from starting a
                // second tick, so the pass runs exactly the failing one.
                await using var subject = NewWorker(pool, fixture, options => options.MaintenanceInterval = TimeSpan.FromMinutes(1));
                subject.Handle<JsonElement>(TaskType(fixture), (_, _) => Task.CompletedTask);

                // The failing phase runs on this pass, and the pass still claims and settles the task.
                Failure.Check(await subject.RunOnceAsync(), "the worker did not run the task");
            }

            var ticks = (await RowsAsync("SELECT call, row FROM public.conformance_results WHERE function_name = 'tick_v1' ORDER BY sequence"))
                .Select(row => Json.Object(row)!)
                .ToList();
            var calls = ticks.Select(row => row["call"]).Distinct().Count();
            Failure.Check(calls == 1, $"the worker ran {calls} ticks, want 1");
            object? error = null;
            foreach (var row in ticks.Select(tick => Runner.Object(tick["row"], "tick row")))
            {
                if (Matcher.Same(row.GetValueOrDefault("phase"), fixture.GetValueOrDefault("expectedPhase")))
                {
                    error = row.GetValueOrDefault("error");
                }
            }

            Failure.Check(Matcher.Render(error).Contains((string)injection["message"]!, StringComparison.Ordinal), $"the worker's tick reported {Matcher.Render(error)}");

            // The rows above are what PostgreSQL returned. The error metric shows that the worker read
            // the error of that phase from them.
            var phase = Runner.Text(fixture.GetValueOrDefault("expectedPhase"));
            Failure.Check(
                recording.Of("workhorse.maintenance.errors", point => Equals(point.Tags.GetValueOrDefault(Names.MaintenancePhase), phase)).Count > 0,
                $"the worker recorded no maintenance error for the {phase} phase");
            await ExpectStateAsync(taskId, Get(fixture, "expectedState"));
        });
    }

    // ----- database interposition ----------------------------------------------------------------

    /// <summary>
    /// Wraps <c>claim_many_v1</c> so that the claim of <paramref name="taskId"/> returns
    /// <paramref name="column"/> <paramref name="leadMs"/> earlier than PostgreSQL holds it. With
    /// <paramref name="deadlineMs"/>, the wrapper first moves the stored deadline to that many
    /// milliseconds after the claim. A cleanup restores the function.
    /// </summary>
    private async Task ShiftClaimsAsync(Guid taskId, string column, long leadMs, long? deadlineMs)
    {
        var function = Json.Object((await RowsAsync(
            """
            SELECT p.oid::regprocedure::text AS signature, pg_get_function_arguments(p.oid) AS arguments,
                   pg_get_function_identity_arguments(p.oid) AS identity, pg_get_function_result(p.oid) AS result,
                   (SELECT array_agg(a.name ORDER BY a.position) FROM unnest(p.proargnames, p.proargmodes::text[]) WITH ORDINALITY AS a(name, mode, position) WHERE a.mode = 't') AS columns
              FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
             WHERE n.nspname = 'workhorse' AND p.proname = 'claim_many_v1'
            """)).Single())!;
        var columns = Runner.Strings(function["columns"]).ToList();
        Failure.Check(columns.Contains(column), $"claim_many_v1 returns no {column} column");
        var move = deadlineMs is { } milliseconds
            ? $"UPDATE workhorse.task_runtime SET deadline_at = clock_timestamp() + ({milliseconds} * interval '1 millisecond') WHERE task_runtime.task_id = claimed.task_id RETURNING task_runtime.deadline_at INTO anchor;"
            : "";
        var assign = string.Join(" ", columns.Select(name => name == column ? $"{name} := anchor;" : $"{name} := claimed.{name};"));
        await UpdateAsync($"ALTER FUNCTION {function["signature"]} RENAME TO claim_many_v1__shifted");
        _cleanups.Add(async () =>
        {
            await UpdateAsync($"DROP FUNCTION IF EXISTS workhorse.claim_many_v1({function["identity"]})");
            await UpdateAsync("ALTER FUNCTION workhorse.claim_many_v1__shifted RENAME TO claim_many_v1");
        });
        await UpdateAsync(
            $"""
            CREATE FUNCTION workhorse.claim_many_v1({function["arguments"]}) RETURNS {function["result"]} LANGUAGE plpgsql AS $shift$
            #variable_conflict use_column
            DECLARE claimed record; anchor timestamptz;
            BEGIN
              FOR claimed IN SELECT * FROM workhorse.claim_many_v1__shifted($1, $2, $3, $4) LOOP
                anchor := claimed.{column};
                IF claimed.task_id = '{taskId}'::uuid THEN
                  {move}
                  anchor := anchor - ({leadMs} * interval '1 millisecond');
                END IF;
                {assign}
                RETURN NEXT;
              END LOOP;
            END $shift$
            """);
    }

    /// <summary>
    /// Wraps <paramref name="function"/> so that each call records the rows it returns in
    /// <c>public.conformance_results</c>. A cleanup restores the function.
    /// </summary>
    private async Task RecordResultsAsync(string function)
    {
        var overload = Json.Object((await RowsAsync(
            $"""
            SELECT p.oid::regprocedure::text AS signature, pg_get_function_arguments(p.oid) AS arguments,
                   pg_get_function_identity_arguments(p.oid) AS identity, pg_get_function_result(p.oid) AS result, p.pronargs::integer AS arity
              FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
             WHERE n.nspname = 'workhorse' AND p.proname = '{function}'
            """)).Single())!;
        var arguments = string.Join(", ", Enumerable.Range(1, (int)(long)overload["arity"]!).Select(position => $"${position}"));
        await UpdateAsync(
            "CREATE TABLE IF NOT EXISTS public.conformance_results (sequence bigserial PRIMARY KEY, function_name text NOT NULL, call bigint NOT NULL, row jsonb NOT NULL)");
        await UpdateAsync("CREATE SEQUENCE IF NOT EXISTS public.conformance_result_calls");
        await UpdateAsync($"DELETE FROM public.conformance_results WHERE function_name = '{function}'");
        await UpdateAsync($"ALTER FUNCTION {overload["signature"]} RENAME TO {function}__results");
        _cleanups.Add(async () =>
        {
            await UpdateAsync($"DROP FUNCTION IF EXISTS workhorse.{function}({overload["identity"]})");
            await UpdateAsync($"ALTER FUNCTION workhorse.{function}__results RENAME TO {function}");
        });
        await UpdateAsync(
            $"""
            CREATE FUNCTION workhorse.{function}({overload["arguments"]}) RETURNS {overload["result"]} LANGUAGE sql AS $results$
              WITH call AS (SELECT nextval('public.conformance_result_calls') AS n),
                   returned AS (SELECT * FROM workhorse.{function}__results({arguments})),
                   logged AS (INSERT INTO public.conformance_results (function_name, call, row)
                              SELECT '{function}', call.n, to_jsonb(returned) FROM returned, call)
              SELECT * FROM returned
            $results$
            """);
    }

    /// <summary>
    /// Replaces one installed function with a raising body, and restores it afterwards. The exception
    /// rolls the call back, so only a sequence carries the count of raised calls out.
    /// </summary>
    private async Task InjectedAsync(OrderedDictionary<string, object?> injection, Func<Func<Task<long>>, Task> body)
    {
        var original = await ValueAsync($"SELECT pg_get_functiondef('{injection["function"]}'::regprocedure)");
        var sequence = injection.GetValueOrDefault("counterSequence") as string;
        try
        {
            if (sequence is not null)
            {
                await UpdateAsync($"CREATE SEQUENCE {sequence} MINVALUE 0 START 0");
            }

            await UpdateAsync(
                $"CREATE OR REPLACE FUNCTION {injection["header"]} LANGUAGE plpgsql AS $injected$ BEGIN {(sequence is null ? "" : $"PERFORM nextval('{sequence}');")} RAISE EXCEPTION '{injection["message"]}' USING ERRCODE = '{injection["errorCode"]}'; END; $injected$");
            await body(async () => sequence is null ? 0 : long.Parse((await ValueAsync($"SELECT last_value FROM {sequence}"))!, CultureInfo.InvariantCulture));
        }
        finally
        {
            await UpdateAsync(original!);
            if (sequence is not null)
            {
                await UpdateAsync($"DROP SEQUENCE IF EXISTS {sequence}");
            }
        }
    }

    /// <summary>
    /// Replaces one installed function with the body of the fixture while <paramref name="body"/>
    /// runs. It runs every <c>setup</c> statement first. Afterwards it restores the definition that
    /// the database reported, then runs every <c>teardown</c> statement, whatever the body does.
    /// </summary>
    private async Task InjectedBodyAsync(OrderedDictionary<string, object?> injection, Func<Task> body)
    {
        var original = await ValueAsync($"SELECT pg_get_functiondef('{injection["function"]}'::regprocedure)");
        Failure.Check(original is not null, $"the function {injection["function"]} is not installed");
        try
        {
            foreach (var statement in Runner.Strings(injection["setup"]))
            {
                await UpdateAsync(statement);
            }

            await UpdateAsync($"CREATE OR REPLACE FUNCTION {injection["header"]} LANGUAGE plpgsql AS $injected$ {injection["body"]} $injected$");
            try
            {
                await body();
            }
            finally
            {
                await UpdateAsync(original!);
            }
        }
        finally
        {
            foreach (var statement in Runner.Strings(injection["teardown"]))
            {
                await UpdateAsync(statement);
            }
        }
    }

    // ----- support -------------------------------------------------------------------------------

    private static string QueueName(OrderedDictionary<string, object?> fixture) => $"runtime-{Runner.Text(fixture["id"])}";

    private static string TaskType(OrderedDictionary<string, object?> fixture) => (string)fixture["taskType"]!;

    private static TimeSpan Millis(OrderedDictionary<string, object?> fixture, string key) => TimeSpan.FromMilliseconds((long)fixture[key]!);

    private static OrderedDictionary<string, object?> Get(OrderedDictionary<string, object?> fixture, string key) => Runner.Object(fixture.GetValueOrDefault(key), key);

    private static EnqueueOptions Options(string queue) => new() { Queue = queue };

    private async Task<Guid> EnqueueAsync(string taskType, object? payload, EnqueueOptions options) =>
        (await _queue.EnqueueAsync(taskType, Json.Element(payload), options)).TaskId;

    /// <summary>The options of every fixture worker: one queue, polling only, no registry row, and a 5 ms poll.</summary>
    private static WorkerOptions BaseOptions(string queue, string workerId) => new()
    {
        Queues = [queue],
        WorkerId = workerId,
        PollingOnly = true,
        DisableRegistry = true,
        LoggerFactory = TestLog.Instance,
    };

    private static Worker NewWorker(Intercept pool, OrderedDictionary<string, object?> fixture, Action<WorkerOptions>? configure = null)
    {
        var options = BaseOptions(QueueName(fixture), $"dotnet-{Runner.Text(fixture["id"])}");
        options.PollInterval = TimeSpan.FromMilliseconds(5);
        configure?.Invoke(options);
        return new Worker(pool.DataSource, options);
    }

    /// <summary>A worker call in the background. A fixture that fails early skips its own stop, so a cleanup stops the worker.</summary>
    private Task<T> Running<T>(Worker subject, Func<Task<T>> action)
    {
        var task = Task.Run(action);
        _cleanups.Add(async () =>
        {
            subject.Stop();
            await Settled(task);
        });
        return task;
    }

    private Task<bool> Running(Worker subject, Func<Task> action) =>
        Running(subject, async () =>
        {
            await action();
            return true;
        });

    /// <summary>
    /// Runs each cleanup in reverse order, and waits for each one. A cleanup that fails does not stop
    /// the others, and the first failure is thrown after the last cleanup.
    /// </summary>
    private async Task CleanUpAsync()
    {
        var cleanups = _cleanups.AsEnumerable().Reverse().ToList();
        _cleanups.Clear();
        Exception? first = null;
        foreach (var cleanup in cleanups)
        {
            try
            {
                await cleanup();
            }
            catch (Exception error)
            {
                first ??= error;
            }
        }

        if (first is not null)
        {
            throw new Failure($"a cleanup failed: {first.GetType().Name}: {first.Message}");
        }
    }

    /// <summary>The result of a worker call, with its error.</summary>
    private static async Task<T> JoinAsync<T>(Task<T> task)
    {
        try
        {
            return await task.WaitAsync(Patience);
        }
        catch (TimeoutException)
        {
            throw new Failure("the worker run did not return");
        }
    }

    private static async Task JoinAsync(Task task)
    {
        try
        {
            await task.WaitAsync(Patience);
        }
        catch (TimeoutException)
        {
            throw new Failure("the worker run did not return");
        }
    }

    /// <summary>Waits a bounded time for <paramref name="task"/>, and ignores its result.</summary>
    private static async Task Settled(Task task)
    {
        try
        {
            await task.WaitAsync(Patience);
        }
        catch (Exception)
        {
            // The fixture already reported its outcome; this wait only bounds the task.
        }
    }

    private static async Task<bool> Completes(Task task, TimeSpan timeout)
    {
        try
        {
            await task.WaitAsync(timeout);
            return true;
        }
        catch (TimeoutException)
        {
            return false;
        }
    }

    private static async Task Started(TaskCompletionSource started, string message) =>
        Failure.Check(await Completes(started.Task, TimeSpan.FromSeconds(5)), message);

    /// <summary>Waits until <paramref name="token"/> is cancelled, or fails after 5 s.</summary>
    private static async Task WaitForCancellationAsync(string message, CancellationToken token)
    {
        try
        {
            await Task.Delay(TimeSpan.FromSeconds(5), token);
        }
        catch (OperationCanceledException) when (token.IsCancellationRequested)
        {
            return;
        }

        throw new InvalidOperationException(message);
    }

    /// <summary>Waits until <paramref name="latch"/> is set, or throws after 10 s.</summary>
    private static async Task WaitAsync(ManualResetEventSlim latch, string message, TimeSpan? timeout = null)
    {
        var deadline = Stopwatch.GetTimestamp();
        while (!latch.IsSet)
        {
            if (Stopwatch.GetElapsedTime(deadline) > (timeout ?? Patience))
            {
                throw new InvalidOperationException(message);
            }

            await Task.Delay(2);
        }
    }

    private static void Maximum(ref int target, int value)
    {
        var current = Volatile.Read(ref target);
        while (value > current)
        {
            var seen = Interlocked.CompareExchange(ref target, value, current);
            if (seen == current)
            {
                return;
            }

            current = seen;
        }
    }

    private static Task EventuallyAsync(string message, long timeoutSeconds, Func<bool> condition) =>
        EventuallyAsync(message, timeoutSeconds, () => Task.FromResult(condition()));

    private static async Task EventuallyAsync(string message, long timeoutSeconds, Func<Task<bool>> condition)
    {
        var start = Stopwatch.GetTimestamp();
        while (!await condition())
        {
            if (Stopwatch.GetElapsedTime(start) > TimeSpan.FromSeconds(timeoutSeconds))
            {
                throw new Failure(message);
            }

            await Task.Delay(5);
        }
    }

    private static async Task<int> ClaimAsync(NpgsqlConnection connection, string queue, string workerId, int lease) =>
        (await Sql.RowsAsync(connection, SqlCatalogue.ClaimV1, [Parameters.Text(queue), Parameters.Text(workerId), Parameters.Integer(lease)], CancellationToken.None)).Count;

    private async Task<DateTimeOffset> ExpiryAsync(Guid taskId)
    {
        var text = await ValueAsync($"SELECT expires_at::text FROM workhorse.task_runtime WHERE task_id = '{taskId}'");
        Failure.Check(text is not null, $"task {taskId} holds no lease");
        return Database.Instant(text!);
    }

    private async Task<DateTimeOffset> RenewalAsync(Guid taskId, DateTimeOffset previous, long timeoutSeconds)
    {
        var renewed = previous;
        await EventuallyAsync($"the lease of {taskId} was not renewed", timeoutSeconds, async () => (renewed = await ExpiryAsync(taskId)) > previous);
        return renewed;
    }

    private async Task<bool> WaitsOnAsync(int pid, string? lockName) =>
        await ValueAsync(
            $"SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE pid = {pid} AND wait_event_type = 'Lock'{(lockName is null ? "" : $" AND wait_event = '{lockName}'")})") == "t";

    private async Task<long> AttemptsAsync(Guid taskId) =>
        long.Parse((await ValueAsync($"SELECT count(*) FROM workhorse.attempt_history WHERE task_id = '{taskId}'"))!, CultureInfo.InvariantCulture);

    private async Task<long> ReleasesAsync(Guid taskId) =>
        long.Parse((await ValueAsync($"SELECT count(*) FROM workhorse.task_event WHERE task_id = '{taskId}' AND event_type = 'released'"))!, CultureInfo.InvariantCulture);

    private async Task<OrderedDictionary<string, object?>> StateAsync(Guid taskId)
    {
        var rows = await RowsAsync(
            $"""
            SELECT state::text AS state, current_attempt, error->>'name' AS error_name FROM workhorse.task_runtime WHERE task_id = '{taskId}'
            UNION ALL SELECT state::text, current_attempt, error->>'name' FROM workhorse.task_outcome WHERE task_id = '{taskId}'
            UNION ALL SELECT state, attempt, NULL FROM workhorse.fast_task_runtime WHERE task_id = '{taskId}'
            UNION ALL SELECT state, attempt, error->>'name' FROM workhorse.fast_task_outcome WHERE task_id = '{taskId}'
            """);
        Failure.Check(rows.Count == 1, $"task {taskId} has {rows.Count} state rows");
        var row = Json.Object(rows[0])!;
        return Json.Members(("state", row["state"]), ("attempt", row["current_attempt"]), ("errorName", row["error_name"]));
    }

    private async Task ExpectStateAsync(Guid taskId, OrderedDictionary<string, object?> expected)
    {
        var actual = await StateAsync(taskId);
        var want = Json.Members(("state", expected.GetValueOrDefault("state")), ("attempt", expected.GetValueOrDefault("attempt")));
        var got = Json.Members(("state", actual["state"]), ("attempt", actual["attempt"]));
        if (expected.TryGetValue("errorName", out var errorName))
        {
            want["errorName"] = errorName;
            got["errorName"] = actual["errorName"];
        }

        Failure.Check(Matcher.Same(want, got), $"task state {Matcher.Render(actual)}, want {Matcher.Render(want)}");
    }

    private async Task ExpectStatesAsync(Dictionary<string, Guid> taskIds, OrderedDictionary<string, object?> expected)
    {
        foreach (var (key, want) in expected)
        {
            await ExpectStateAsync(taskIds[key], Runner.Object(want, key));
        }
    }

    private async Task ExpectOutcomesAsync(Guid taskId, List<object?> expected)
    {
        var outcomes = (await RowsAsync($"SELECT outcome::text AS outcome FROM workhorse.attempt_history WHERE task_id = '{taskId}' ORDER BY attempt"))
            .Select(row => Json.Object(row)!["outcome"])
            .ToList();
        Failure.Check(Matcher.Same(outcomes, expected), $"attempt outcomes {Matcher.Render(outcomes)}, want {Matcher.Render(expected)}");
    }

    /// <summary>The first column of the one row that <paramref name="sql"/> returns, as text, or <c>null</c>.</summary>
    private async Task<string?> ValueAsync(string sql)
    {
        await using var connection = await _database.DataSource.OpenConnectionAsync();
        await using var command = new NpgsqlCommand(sql, connection) { AllResultTypesAreUnknown = true };
        await using var reader = await command.ExecuteReaderAsync();
        return await reader.ReadAsync() && !await reader.IsDBNullAsync(0) ? reader.GetString(0) : null;
    }

    private async Task<List<object?>> RowsAsync(string sql)
    {
        await using var connection = await _database.DataSource.OpenConnectionAsync();
        return Database.Rows(connection, sql);
    }

    private async Task UpdateAsync(string sql)
    {
        await using var connection = await _database.DataSource.OpenConnectionAsync();
        Database.Run(connection, sql);
    }

    /// <summary>
    /// Two JSON values that agree, with the same kind of each number. Object keys compare as a set,
    /// because <c>jsonb</c> reorders them.
    /// </summary>
    private static bool Exact(object? left, object? right)
    {
        if (left is long or double or System.Numerics.BigInteger || right is long or double or System.Numerics.BigInteger)
        {
            return left is not null && right is not null && left.GetType() == right.GetType() && left.Equals(right);
        }

        if (left is List<object?> list)
        {
            return right is List<object?> other && list.Count == other.Count && list.Zip(other).All(pair => Exact(pair.First, pair.Second));
        }

        if (Json.Object(left) is { } members || Json.Object(right) is not null)
        {
            var leftMembers = Json.Object(left);
            var rightMembers = Json.Object(right);
            return leftMembers is not null && rightMembers is not null
                && leftMembers.Keys.ToHashSet(StringComparer.Ordinal).SetEquals(rightMembers.Keys)
                && leftMembers.All(member => Exact(member.Value, rightMembers[member.Key]));
        }

        return Matcher.Same(left, right);
    }
}
