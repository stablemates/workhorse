using System.Text.Json;
using System.Text.Json.Nodes;
using Npgsql;
using Workhorse.Internal;
using Workhorse.Internal.Contracts;
using Workhorse.Internal.Database;
using Workhorse.Internal.Durable;
using Workhorse.Internal.Json;
using Workhorse.Internal.Runtime;

namespace Workhorse;

public sealed partial class Worker
{
    private const long MaxWaitMs = 31_536_000_000L;
    private const long MaxExternalTimeoutMs = 604_800_000L;
    private const int MaxExternalValueBytes = 65_536;
    private const int MaxChildren = 100;
    private const int MaxDurableNameLength = 200;
    private const string ExternalNameWhitespace = "\0\t\n\u000B\f\r ";

    private static readonly JsonElement NullChildResult = JsonDocument.Parse("null").RootElement.Clone();
    private Queue? _durableQueue;

    /// <summary>The queue code that sends child requests and group adds, with the codec of this worker.</summary>
    private Queue DurableQueue => LazyInitializer.EnsureInitialized(ref _durableQueue, () => new Queue(_dataSource, _codec));

    /// <summary>
    /// Whether <paramref name="queue"/> is on the fast tier. The first durable call of a context runs
    /// this read, once the heartbeat renews the lease, and not the claim.
    /// </summary>
    private async Task<bool> FastTierAsync(string queue, CancellationToken cancellationToken)
    {
        await using var connection = await DataSources.OpenAsync(_dataSource, cancellationToken).ConfigureAwait(false);
        var rows = await Sql.RowsAsync(connection, SqlCatalogue.QueueControl, [], cancellationToken).ConfigureAwait(false);
        return rows.Any(row => row.Text("queue_name") == queue && row.Text("tier") == "fast");
    }

    /// <summary>
    /// Records the suspension, sets <see cref="CancelReason.Suspended"/>, cancels the token, and
    /// returns the exception that unwinds the handler (ADR 0107, "Suspension").
    /// </summary>
    /// <remarks>
    /// The suspension cancels the token whether or not its outcome wins. An outcome that won first
    /// and saw the release, such as the lease watchdog, does not cancel the token itself. The first
    /// reason stays, so a reason that an earlier cancellation set does not change.
    /// </remarks>
    internal static SuspensionException SuspendAttempt(Arbiter arbiter, TaskCancellation cancellation, Outcome outcome)
    {
        arbiter.Release(outcome);
        arbiter.Submit(outcome);
        cancellation.Cancel(CancelReason.Suspended);
        return new SuspensionException(cancellation.Token);
    }

    /// <summary>
    /// The context of one attempt. The counterpart of Ruby's <c>HandlerContext</c> and the JVM's
    /// <c>TaskContext</c>.
    /// </summary>
    /// <remarks>
    /// Each statement takes the stop-path token, never the handler's token, so a cancellation of the
    /// handler cannot cut a durable write in the middle (ADR 0107, "Cancellation and statements").
    /// Only the operation of a checkpoint receives the handler's token.
    /// </remarks>
    private sealed class DurableContext : HandlerContext
    {
        private readonly Worker _worker;
        private readonly Arbiter _arbiter;
        private readonly CancellationToken _statements;
        private readonly Func<CancellationToken, Task<bool>> _fastTierRead;
        private readonly Lock _lock = new();
        private readonly Dictionary<string, Running> _calls = new(StringComparer.Ordinal);
        private Task<Dictionary<string, Saved>>? _checkpoints;
        private Task<TaskProgress?>? _progress;
        private TaskProgress? _savedProgress;
        private bool? _fastTier;

        internal DurableContext(Worker worker, Active task, Arbiter arbiter, Func<CancellationToken, Task<bool>> fastTierRead)
            : base(task.Task, task.Cancellation)
        {
            _worker = worker;
            _arbiter = arbiter;
            _statements = task.Run.StopPath.Token;
            _fastTierRead = fastTierRead;
            TaskGroup = new ActivationTaskGroup(this);
        }

        public override TaskGroupContext TaskGroup { get; }

        /// <summary>A saved checkpoint, and its value as the JSON text that PostgreSQL returned.</summary>
        private sealed record Saved(TaskCheckpoint Checkpoint, string Text);

        /// <summary>A durable call in flight: its request, and the result that every caller shares.</summary>
        private sealed record Running(object? Request, TaskCompletionSource<object?> Result);

        // -----------------------------------------------------------------------------------------
        // Checkpoints

        private protected override async Task<TaskCheckpoint?> GetCheckpointCoreAsync(string name) =>
            (await SavedCheckpointAsync(name).ConfigureAwait(false))?.Checkpoint;

        private protected override async Task<T> CheckpointCoreAsync<T>(string name, CheckpointOptions? options, Func<CancellationToken, Task<T>> operation)
        {
            DurableName(name, "checkpoint");
            ArgumentNullException.ThrowIfNull(operation);
            var fingerprint = options is null ? null : Checkpoints.InputFingerprint(options.Input, _worker._codec);
            await DurableAsync("checkpoints").ConfigureAwait(false);
            var text = (string)(await OnceAsync(
                "checkpoint",
                name,
                fingerprint,
                name,
                running => CheckInput(name, (string?)running, fingerprint),
                async () =>
                {
                    if (await SavedCheckpointAsync(name).ConfigureAwait(false) is { } existing)
                    {
                        CheckInput(name, existing.Checkpoint.InputFingerprint, fingerprint);
                        return existing.Text;
                    }

                    Live("checkpoint");
                    var encoded = Storable(await operation(CancellationToken).ConfigureAwait(false), "checkpoint value");
                    var row = await FencedAsync(SqlCatalogue.SaveCheckpointV2, Parameters.Text(name), Parameters.Json(encoded), Parameters.Text(fingerprint)).ConfigureAwait(false);
                    if (row.Text("status") == "input_conflict")
                    {
                        CheckInput(name, row.Text("input_fingerprint"), fingerprint);
                    }

                    var status = Expect("checkpoint", row, name, "saved", "existing");
                    var saved = CheckpointRecord(row, name);
                    var checkpoints = await CheckpointsAsync().ConfigureAwait(false);
                    lock (_lock)
                    {
                        checkpoints[name] = saved;
                    }

                    // The cache holds the saved value first, so a failing logger cannot run the operation again.
                    DurableLog.CheckpointSaved(_worker._logger, Task.Id, name, status);
                    return saved.Text;
                }).ConfigureAwait(false))!;
            return Decode<T>(text);
        }

        /// <summary>
        /// Inputs are compared only when both sides carry a fingerprint, so a handler that adds or
        /// removes an input keeps the stored result.
        /// </summary>
        private static void CheckInput(string name, string? stored, string? requested)
        {
            if (stored is not null && requested is not null && stored != requested)
            {
                throw new CheckpointInputConflictException(name, stored, requested);
            }
        }

        private async Task<Saved?> SavedCheckpointAsync(string name)
        {
            var checkpoints = await CheckpointsAsync().ConfigureAwait(false);
            lock (_lock)
            {
                return checkpoints.GetValueOrDefault(name);
            }
        }

        /// <summary>
        /// The checkpoints of this task, read once. The first read's error repeats on every later
        /// call. The dictionary is not thread-safe, so each read and write of it holds the lock.
        /// </summary>
        private Task<Dictionary<string, Saved>> CheckpointsAsync() =>
            Load(ref _checkpoints, async () =>
            {
                var saved = new Dictionary<string, Saved>(StringComparer.Ordinal);
                foreach (var row in await RowsAsync(SqlCatalogue.ListCheckpoints, Parameters.Uuid(Task.Id)).ConfigureAwait(false))
                {
                    var name = row.RequiredText("checkpoint_name");
                    saved[name] = CheckpointRecord(row, name);
                }

                return saved;
            });

        private Saved CheckpointRecord(Row row, string name)
        {
            var text = row.RequiredText("checkpoint_value");
            var checkpoint = new TaskCheckpoint
            {
                TaskId = Task.Id,
                Name = name,
                Value = row.Json("checkpoint_value"),
                Attempt = row.RequiredInteger("attempt"),
                FenceToken = row.RequiredLong("fence_token"),
                WorkerId = row.RequiredText("worker_id"),
                CreatedAt = row.RequiredInstant("created_at"),
                InputFingerprint = row.Text("input_fingerprint"),
            };
            return new Saved(checkpoint, text);
        }

        // -----------------------------------------------------------------------------------------
        // Durable timers

        private protected override async Task SleepCoreAsync(string name, TimeSpan? duration, DateTimeOffset? time)
        {
            DurableName(name, "wait");
            long? durationMs = null;
            DateTimeOffset? wakeAt = null;
            if (duration is { } relative)
            {
                durationMs = Values.Milliseconds(relative, "wait duration", 1, MaxWaitMs);
            }
            else
            {
                var absolute = time!.Value.ToUniversalTime();
                if (absolute > DateTimeOffset.UtcNow.AddMilliseconds(MaxWaitMs))
                {
                    throw new ArgumentException("wait time must be no more than 365 days in the future", nameof(time));
                }

                // The protocol carries milliseconds, so equal requests share one write.
                wakeAt = absolute.AddTicks(-(absolute.Ticks % TimeSpan.TicksPerMillisecond));
            }

            await DurableAsync("durable waits").ConfigureAwait(false);

            // Relative sleeps under one name share the first write, whatever their durations. An
            // absolute sleep shares only with the same wake time.
            await OnceAsync(
                "sleep",
                name,
                wakeAt is { } at ? $"absolute:{Values.Timestamp(at)}" : "relative",
                name,
                null,
                async () =>
                {
                    Live("sleep");
                    var row = await FencedAsync(SqlCatalogue.ScheduleWaitV1, Parameters.Text(name), Parameters.Bigint(durationMs), Parameters.Timestamptz(wakeAt)).ConfigureAwait(false);
                    var status = row.Text("status");
                    switch (status)
                    {
                        case "stale":
                            throw new LeaseLostException(Task.Id, "sleep");
                        case "conflict":
                            throw new ConflictException("sleep", name);
                        case "limit_exceeded":
                            throw new LimitExceededException("sleep", name);
                        case "scheduled" or "elapsed":
                            Processed(status == "scheduled" ? Outcome.SuspendedForWait : null, () => DurableLog.WaitProcessed(_worker._logger, Task.Id, name, status));
                            return null;
                        default:
                            throw new UnexpectedStatusException("sleep", status);
                    }
                }).ConfigureAwait(false);
        }

        // -----------------------------------------------------------------------------------------
        // External waits

        private protected override async Task<T> WaitForSignalCoreAsync<T>(string name, TimeSpan? timeout)
        {
            ExternalName(name, "signal");
            var timeoutMs = ExternalTimeout(timeout, "signal");
            await DurableAsync("signal waits").ConfigureAwait(false);
            var text = (string)(await OnceAsync(
                "waitForSignal",
                name,
                null,
                name,
                null,
                async () =>
                {
                    Live("waitForSignal");
                    var row = await FencedAsync(SqlCatalogue.WaitForSignalV1, Parameters.Text(name), Parameters.Bigint(timeoutMs)).ConfigureAwait(false);
                    var status = row.Text("status");
                    return status switch
                    {
                        "stale" => throw new LeaseLostException(Task.Id, "waitForSignal"),
                        "already_waiting" => throw new AlreadyWaitingException("waitForSignal", name),
                        "limit_exceeded" => throw new LimitExceededException("waitForSignal", name),
                        "waiting" => throw Suspend(Outcome.SuspendedForWait),
                        "delivered" => (object)JsonText(row, "payload"),
                        _ => throw new UnexpectedStatusException("waitForSignal", status),
                    };
                }).ConfigureAwait(false))!;
            return Decode<T>(text);
        }

        private protected override async Task<T> WaitForHumanCoreAsync<TContext, T>(string name, TContext context, TimeSpan? timeout)
        {
            ExternalName(name, "human wait");
            var timeoutMs = ExternalTimeout(timeout, "human wait");
            var encoded = SortedJson(Values.Node(Storable(context, "human wait context")));
            if (Values.Bytes(encoded) > MaxExternalValueBytes)
            {
                throw new ArgumentException($"human wait context must be at most {MaxExternalValueBytes} bytes of JSON", nameof(context));
            }

            await DurableAsync("human waits").ConfigureAwait(false);

            var text = (string)(await OnceAsync(
                "waitForHuman",
                name,
                encoded,
                name,
                null,
                async () =>
                {
                    Live("waitForHuman");
                    var row = await FencedAsync(SqlCatalogue.WaitForHumanV1, Parameters.Text(name), Parameters.Json(encoded), Parameters.Bigint(timeoutMs)).ConfigureAwait(false);
                    var status = row.Text("status");
                    return status switch
                    {
                        "stale" => throw new LeaseLostException(Task.Id, "waitForHuman"),
                        "already_waiting" => throw new AlreadyWaitingException("waitForHuman", name),
                        "limit_exceeded" => throw new LimitExceededException("waitForHuman", name),
                        "conflict" => throw new ConflictException("waitForHuman", name),
                        "waiting" => throw Suspend(Outcome.SuspendedForWait),
                        "completed" => (object)JsonText(row, "result"),
                        _ => throw new UnexpectedStatusException("waitForHuman", status),
                    };
                }).ConfigureAwait(false))!;
            return Decode<T>(text);
        }

        // -----------------------------------------------------------------------------------------
        // Child tasks

        private protected override async Task<T> RunChildCoreAsync<TPayload, T>(string name, string taskType, TPayload payload, EnqueueOptions options)
        {
            DurableName(name, "child");
            ArgumentNullException.ThrowIfNull(taskType);
            var encodedPayload = _worker._codec.Serialize(payload, "payload");
            _worker.DurableQueue.ChildInput(Task, taskType, encodedPayload, options, null);
            await DurableAsync("child tasks").ConfigureAwait(false);
            Task<string> Build(IReadOnlyDictionary<string, Queue.ChildVersion> versions) =>
                WithConnectionAsync(async connection => SortedJson(await _worker.DurableQueue
                    .SerializeChildRequestAsync(connection, Task, taskType, encodedPayload, options, new(StringComparer.Ordinal), versions.GetValueOrDefault(name), _statements)
                    .ConfigureAwait(false)));
            var encoded = await InitialAsync(Build).ConfigureAwait(false);
            var text = (string)(await OnceAsync(
                "runChild",
                name,
                encoded,
                name,
                null,
                async () =>
                {
                    Live("runChild");
                    var row = await FencedAsync(SqlCatalogue.CreateChildV2, Parameters.Text(name), Parameters.Json(encoded)).ConfigureAwait(false);
                    row = await ReplayedAsync(row, encoded, Build, accepted => FencedAsync(SqlCatalogue.CreateChildV2, Parameters.Text(name), Parameters.Json(accepted))).ConfigureAwait(false);
                    var status = row.Text("status");
                    switch (status)
                    {
                        case "stale":
                            throw new LeaseLostException(Task.Id, "runChild");
                        case "conflict":
                            throw new ConflictException("runChild", name, row.Text("stored_child_name"));
                        case "limit_exceeded":
                            throw new LimitExceededException("runChild", name);
                        case "created" or "completed":
                            Processed(status == "created" ? Outcome.SuspendedForChild : null, () => DurableLog.ChildProcessed(_worker._logger, Task.Id, name, status));
                            return JsonText(row, "result");
                        default:
                            throw new UnexpectedStatusException("runChild", status);
                    }
                }).ConfigureAwait(false))!;
            return Decode<T>(text);
        }

        private protected override async Task<IReadOnlyDictionary<string, ChildOutcome>> RunChildrenCoreAsync(IReadOnlyList<ChildRequest> children) =>
            (IReadOnlyDictionary<string, ChildOutcome>)await RunChildSetAsync(children, "settled").ConfigureAwait(false);

        private protected override async Task<IReadOnlyDictionary<string, JsonElement>> RunChildrenAllCoreAsync(IReadOnlyList<ChildRequest> children) =>
            (IReadOnlyDictionary<string, JsonElement>)await RunChildSetAsync(children, "all_success").ConfigureAwait(false);

        private async Task<object> RunChildSetAsync(IReadOnlyList<ChildRequest> children, string mode)
        {
            ArgumentNullException.ThrowIfNull(children);
            List<ChildRequest> requests = [.. children];
            if (requests.Count > MaxChildren)
            {
                throw new LimitExceededException("runChildren", "child set");
            }

            var names = new HashSet<string>(StringComparer.Ordinal);
            foreach (var child in requests)
            {
                if (child is null)
                {
                    throw new ArgumentException("child request is null", nameof(children));
                }

                DurableName(child.Name, "child");
                ArgumentNullException.ThrowIfNull(child.TaskType, nameof(children));
                names.Add(child.Name);
            }

            if (names.Count != requests.Count)
            {
                throw new ArgumentException("child names must be unique", nameof(children));
            }

            var payloads = requests.Select(child => _worker._codec.Serialize(child.Payload, $"child {child.Name} payload")).ToList();
            for (var index = 0; index < requests.Count; index++)
            {
                _worker.DurableQueue.ChildInput(Task, requests[index].TaskType, payloads[index], requests[index].Options ?? new EnqueueOptions(), null);
            }

            await DurableAsync("child tasks").ConfigureAwait(false);
            Task<string> Build(IReadOnlyDictionary<string, Queue.ChildVersion> versions) =>
                WithConnectionAsync(async connection =>
                {
                    var contracts = new Dictionary<string, PayloadContract?>(StringComparer.Ordinal);
                    var document = new JsonArray();
                    for (var index = 0; index < requests.Count; index++)
                    {
                        var child = requests[index];
                        var request = await _worker.DurableQueue
                            .SerializeChildRequestAsync(connection, Task, child.TaskType, payloads[index], child.Options ?? new EnqueueOptions(), contracts, versions.GetValueOrDefault(child.Name), _statements)
                            .ConfigureAwait(false);
                        document.Add(new JsonObject { ["name"] = child.Name, ["request"] = request });
                    }

                    return SortedJson(document);
                });
            var encoded = await InitialAsync(Build).ConfigureAwait(false);
            return (await OnceAsync(
                "runChildren",
                "set",
                $"{mode}:{encoded}",
                "child set",
                null,
                async () =>
                {
                    Live("runChildren");
                    var row = await FencedAsync(SqlCatalogue.CreateChildrenV1, Parameters.Json(encoded), Parameters.Text(mode)).ConfigureAwait(false);
                    row = await ReplayedAsync(row, encoded, Build, accepted => FencedAsync(SqlCatalogue.CreateChildrenV1, Parameters.Json(accepted), Parameters.Text(mode))).ConfigureAwait(false);
                    var status = row.Text("status");
                    switch (status)
                    {
                        case "stale":
                            throw new LeaseLostException(Task.Id, "runChildren");
                        case "conflict":
                            throw new ConflictException("runChildren", "child set");
                        case "limit_exceeded":
                            throw new LimitExceededException("runChildren", "child set");
                        case "result_too_large":
                            throw new ChildResultLimitExceededException(row.RequiredLong("result_bytes"), row.RequiredLong("result_limit_bytes"));
                        case "created" or "completed":
                            Processed(status == "created" ? Outcome.SuspendedForChild : null, () => DurableLog.ChildProcessed(_worker._logger, Task.Id, "child set", status));
                            return Joined(row.Json("children"), mode);
                        default:
                            throw new UnexpectedStatusException("runChildren", status);
                    }
                }).ConfigureAwait(false))!;
        }

        /// <summary>
        /// Builds the child request under the current contracts. A replayed request that the current
        /// contracts reject builds again with each existing child at the version that it was created
        /// under. PostgreSQL still rejects a request that differs from the accepted one.
        /// </summary>
        private async Task<string> InitialAsync(Func<IReadOnlyDictionary<string, Queue.ChildVersion>, Task<string>> build)
        {
            try
            {
                return await build(new Dictionary<string, Queue.ChildVersion>()).ConfigureAwait(false);
            }
            catch (ContractValidationException)
            {
                var versions = await AcceptedContractVersionsAsync().ConfigureAwait(false);
                if (versions.Count == 0)
                {
                    throw;
                }

                try
                {
                    return await build(versions).ConfigureAwait(false);
                }
                catch (ContractValidationException)
                {
                    // The current contract's refusal is the one that the handler sees.
                }

                throw;
            }
        }

        /// <summary>
        /// PostgreSQL compares a replayed child request with the one it accepted, contract stamp
        /// included. After a contract change, a <c>conflict</c> retries once with each existing child
        /// stamped with the contract version that it was created under.
        /// </summary>
        private async Task<Row> ReplayedAsync(
            Row row, string encoded, Func<IReadOnlyDictionary<string, Queue.ChildVersion>, Task<string>> build, Func<string, Task<Row>> resend)
        {
            if (row.Text("status") != "conflict")
            {
                return row;
            }

            var versions = await AcceptedContractVersionsAsync().ConfigureAwait(false);
            if (versions.Count == 0)
            {
                return row;
            }

            string accepted;
            try
            {
                accepted = await build(versions).ConfigureAwait(false);
            }
            catch (ContractValidationException)
            {
                return row;
            }

            return accepted == encoded ? row : await resend(accepted).ConfigureAwait(false);
        }

        /// <summary>The contract version and the queue of each child that this task created, by child name.</summary>
        private async Task<Dictionary<string, Queue.ChildVersion>> AcceptedContractVersionsAsync()
        {
            var versions = new Dictionary<string, Queue.ChildVersion>(StringComparer.Ordinal);
            foreach (var edge in await RowsAsync(SqlCatalogue.TaskChild, Parameters.Uuid(Task.Id), Parameters.Integer(MaxChildren + 1)).ConfigureAwait(false))
            {
                if (edge.Uuid("parent_task_id") != Task.Id)
                {
                    continue;
                }

                var rows = await RowsAsync(SqlCatalogue.GetTask, Parameters.Uuid(edge.RequiredUuid("child_task_id"))).ConfigureAwait(false);
                var child = rows.Count == 0 ? null : rows[0];
                versions[edge.RequiredText("child_name")] = new Queue.ChildVersion(child?.Text("contract_version"), child?.Text("queue_name"));
            }

            return versions;
        }

        private static object Joined(JsonElement? children, string mode)
        {
            var outcomes = new Dictionary<string, ChildOutcome>(StringComparer.Ordinal);
            var results = new Dictionary<string, JsonElement>(StringComparer.Ordinal);
            List<JsonElement> items = children is { ValueKind: JsonValueKind.Array } array ? [.. array.EnumerateArray()] : [];
            foreach (var child in items)
            {
                if (child.ValueKind != JsonValueKind.Object
                    || !child.TryGetProperty("name", out var nameElement)
                    || nameElement.ValueKind != JsonValueKind.String)
                {
                    throw new UnexpectedStatusException("runChildren", null);
                }

                var name = nameElement.GetString()!;
                if (mode == "all_success")
                {
                    results[name] = child.TryGetProperty("result", out var result) ? result.Clone() : NullChildResult;
                    continue;
                }

                var outcome = child.TryGetProperty("outcome", out var value) && value.ValueKind == JsonValueKind.Object ? value : (JsonElement?)null;
                var text = outcome is { } found && found.TryGetProperty("status", out var statusElement) && statusElement.ValueKind == JsonValueKind.String
                    ? statusElement.GetString()
                    : null;
                ChildStatus? status = text switch
                {
                    "succeeded" => ChildStatus.Succeeded,
                    "failed" => ChildStatus.Failed,
                    "canceled" => ChildStatus.Canceled,
                    _ => null,
                };
                if (outcome is not { } settled || status is not { } known)
                {
                    throw new UnexpectedStatusException("runChildren", text);
                }

                outcomes[name] = new ChildOutcome
                {
                    Status = known,
                    Result = Member(settled, "result"),
                    Error = Member(settled, "error"),
                };
            }

            return mode == "all_success" ? results : outcomes;
        }

        private static JsonElement? Member(JsonElement element, string name) =>
            element.TryGetProperty(name, out var member) && member.ValueKind != JsonValueKind.Null ? member.Clone() : null;

        // -----------------------------------------------------------------------------------------
        // Progress

        private protected override async Task<TaskProgress?> GetProgressCoreAsync()
        {
            lock (_lock)
            {
                // An acknowledged write replaces a read that has not run or that failed.
                if (_savedProgress is not null && (_progress is null or { IsFaulted: true } or { IsCanceled: true }))
                {
                    return _savedProgress;
                }
            }

            TaskProgress? loaded;
            try
            {
                loaded = await Load(ref _progress, ReadProgressAsync).ConfigureAwait(false);
            }
            catch (Exception) when (SavedProgress() is not null)
            {
                // The read failed, and a write that PostgreSQL acknowledged since then replaces it.
                return SavedProgress();
            }

            lock (_lock)
            {
                return Newer(loaded, _savedProgress);
            }
        }

        private protected override async Task<TaskProgress> SetProgressCoreAsync<T>(T progress)
        {
            var encoded = Storable(progress, "progress");
            await DurableAsync("progress").ConfigureAwait(false);
            Live("setProgress");
            var row = await FencedAsync(SqlCatalogue.UpdateProgressV1, Parameters.Json(encoded)).ConfigureAwait(false);
            var status = row.Text("status");
            switch (status)
            {
                case "stale":
                    throw new LeaseLostException(Task.Id, "setProgress");
                case "rate_limited":
                    throw new ProgressRateLimitedException(TimeSpan.FromMilliseconds(row.RequiredLong("retry_after_ms")));
                case "updated" or "unchanged":
                    break;
                default:
                    throw new UnexpectedStatusException("setProgress", status);
            }

            var saved = ProgressRecord(row);
            lock (_lock)
            {
                _savedProgress = Newer(_savedProgress, saved);
            }

            DurableLog.ProgressUpdated(_worker._logger, Task.Id, status);
            return saved;
        }

        private async Task<TaskProgress?> ReadProgressAsync()
        {
            var rows = await RowsAsync(SqlCatalogue.ListProgress, Parameters.Uuid(Task.Id)).ConfigureAwait(false);
            return rows.Count switch
            {
                0 => null,
                1 => ProgressRecord(rows[0]),
                _ => throw new WorkhorseException("PostgreSQL returned an invalid progress result"),
            };
        }

        private TaskProgress? SavedProgress()
        {
            lock (_lock)
            {
                return _savedProgress;
            }
        }

        /// <summary>The progress with the higher revision. Writes can return out of order.</summary>
        private static TaskProgress? Newer(TaskProgress? first, TaskProgress? second) =>
            first is null ? second : second is null || first.Revision >= second.Revision ? first : second;

        private TaskProgress ProgressRecord(Row row) => new()
        {
            TaskId = Task.Id,
            Value = row.Json("progress_value"),
            Revision = row.RequiredLong("revision"),
            Attempt = row.RequiredInteger("attempt"),
            FenceToken = row.RequiredLong("fence_token"),
            WorkerId = row.RequiredText("worker_id"),
            CreatedAt = row.RequiredInstant("created_at"),
            UpdatedAt = row.RequiredInstant("updated_at"),
        };

        // -----------------------------------------------------------------------------------------
        // Task groups

        /// <summary>The task group operations of this activation (ADR 0095).</summary>
        private sealed class ActivationTaskGroup(DurableContext context) : TaskGroupContext
        {
            private Task<TaskGroupLink?>? _link;

            public override Task<TaskGroupLink?> GetAsync() =>
                context.Load(ref _link, () => context._worker.DurableQueue.FindTaskGroupAsync(context.Task.Id, context._statements));

            public override Task<IReadOnlyList<EnqueueResult>> AddAsync(IReadOnlyList<EnqueueRequest> requests)
            {
                ArgumentNullException.ThrowIfNull(requests);
                context.Live("taskGroupAdd");
                return context._worker.DurableQueue.AddToTaskGroupAsMemberAsync(context.Task, context._worker.WorkerId, [.. requests], context._statements);
            }
        }

        // -----------------------------------------------------------------------------------------
        // Shared calls and suspension

        /// <summary>
        /// Runs <paramref name="body"/> once for each <paramref name="kind"/> and <paramref name="name"/>
        /// at a time. A concurrent caller with the same <paramref name="request"/> receives the result
        /// or the exception of the running call; a different request conflicts.
        /// <paramref name="overlap"/>, when given, receives the request of the running call and throws
        /// in place of that comparison.
        /// </summary>
        private async Task<object?> OnceAsync(
            string kind, string name, object? request, string conflictName, Action<object?>? overlap, Func<Task<object?>> body)
        {
            var key = $"{kind}\0{name}";
            Running? running;
            Running? mine = null;
            lock (_lock)
            {
                if (!_calls.TryGetValue(key, out running))
                {
                    mine = new Running(request, new TaskCompletionSource<object?>(TaskCreationOptions.RunContinuationsAsynchronously));
                    _calls[key] = mine;
                }
                else if (overlap is not null)
                {
                    overlap(running.Request);
                }
                else if (!Equals(running.Request, request))
                {
                    throw new ConflictException(kind, conflictName);
                }
            }

            if (running is not null)
            {
                return await running.Result.Task.ConfigureAwait(false);
            }

            try
            {
                var value = await body().ConfigureAwait(false);
                mine!.Result.SetResult(value);
                return value;
            }
            catch (Exception error)
            {
                mine!.Result.SetException(error);
                // A call that nobody shared leaves no unobserved exception behind.
                _ = mine.Result.Task.Exception;
                throw;
            }
            finally
            {
                lock (_lock)
                {
                    if (_calls.TryGetValue(key, out var current) && ReferenceEquals(current, mine))
                    {
                        _calls.Remove(key);
                    }
                }
            }
        }

        /// <summary>
        /// Runs the bookkeeping after a durable write. When <paramref name="outcome"/> names a
        /// suspension, the write released the task: the release and the cancellation come first, and
        /// the call unwinds even when the bookkeeping throws, so neither the heartbeat nor a failing
        /// logger lets the handler continue or changes the cancel reason.
        /// </summary>
        private void Processed(Outcome? outcome, Action bookkeeping)
        {
            SuspensionException? suspension = outcome is { } released ? Suspend(released) : null;

            Exception? failure = null;
            try
            {
                bookkeeping();
            }
            catch (Exception error)
            {
                failure = error;
            }

            if (suspension is not null)
            {
                throw suspension;
            }

            if (failure is not null)
            {
                System.Runtime.ExceptionServices.ExceptionDispatchInfo.Throw(failure);
            }
        }

        private SuspensionException Suspend(Outcome outcome) => SuspendAttempt(_arbiter, Cancellation, outcome);

        // -----------------------------------------------------------------------------------------
        // Checks

        /// <summary>
        /// A fast-tier task has no durable execution state (ADR 0077), so each call that would write
        /// it throws before any write. A failed read throws, and the next durable call reads again.
        /// </summary>
        private async Task DurableAsync(string feature)
        {
            bool? fast;
            lock (_lock)
            {
                fast = _fastTier;
            }

            if (fast is null)
            {
                var read = await _fastTierRead(_statements).ConfigureAwait(false);
                lock (_lock)
                {
                    _fastTier ??= read;
                    fast = _fastTier;
                }
            }

            if (fast == true)
            {
                throw new FastTierUnsupportedException(Task.Queue, feature, null);
            }
        }

        /// <summary>
        /// Refuses a durable write once the attempt is cancelled. An attempt that lost its lease
        /// throws <see cref="LeaseLostException"/>, as its fenced write would.
        /// </summary>
        private void Live(string operation)
        {
            var reason = CancelReason;
            if (reason == Workhorse.CancelReason.LeaseLost)
            {
                throw new LeaseLostException(Task.Id, operation);
            }

            if (reason is { } cancelled)
            {
                throw new CancelledException(cancelled);
            }
        }

        private string Expect(string operation, Row row, string name, params string[] known)
        {
            var status = row.Text("status");
            if (status == "stale")
            {
                throw new LeaseLostException(Task.Id, operation);
            }

            if (status == "conflict")
            {
                throw new ConflictException(operation, name);
            }

            return status is not null && known.Contains(status) ? status : throw new UnexpectedStatusException(operation, status);
        }

        /// <summary>
        /// Starts one lazily read value. The first read's error repeats on every later call. The read
        /// starts on the thread pool, so no statement runs under the lock.
        /// </summary>
        private Task<T> Load<T>(ref Task<T>? slot, Func<Task<T>> read)
        {
            lock (_lock)
            {
                return slot ??= System.Threading.Tasks.Task.Run(read);
            }
        }

        /// <summary>
        /// PostgreSQL accepts a checkpoint, wait, or child name of 1 to 200 characters. The check runs
        /// before the tier check, so an invalid name runs no operation and no statement.
        /// </summary>
        private static void DurableName(string? name, string label)
        {
            if (name is null || !LengthFits(name))
            {
                throw new ArgumentException($"{label} name must contain between 1 and {MaxDurableNameLength} characters", nameof(name));
            }
        }

        private static void ExternalName(string? name, string label)
        {
            if (name is not null && LengthFits(name)
                && !ExternalNameWhitespace.Contains(name[0], StringComparison.Ordinal)
                && !ExternalNameWhitespace.Contains(name[^1], StringComparison.Ordinal))
            {
                return;
            }

            throw new ArgumentException($"{label} name must contain between 1 and {MaxDurableNameLength} characters without surrounding whitespace", nameof(name));
        }

        /// <summary>The length in code points, which PostgreSQL counts. A lone surrogate cannot reach PostgreSQL.</summary>
        private static bool LengthFits(string name)
        {
            if (name.Length == 0 || Utf16.HasLoneSurrogate(name))
            {
                return false;
            }

            var length = 0;
            foreach (var _ in name.EnumerateRunes())
            {
                length++;
            }

            return length <= MaxDurableNameLength;
        }

        private static long? ExternalTimeout(TimeSpan? timeout, string label) =>
            timeout is { } value ? Values.Milliseconds(value, $"{label} timeout", 1, MaxExternalTimeoutMs) : null;

        // -----------------------------------------------------------------------------------------
        // Values and statements

        /// <summary>The JSON text that PostgreSQL stores for <paramref name="value"/>.</summary>
        private string Storable<T>(T value, string label)
        {
            var encoded = _worker._codec.Serialize(value, label);
            using var document = JsonDocument.Parse(encoded, JsonTree.DocumentOptions);
            return HoldsNul(document.RootElement)
                ? throw new ArgumentException($"{label} contains a NUL character, which PostgreSQL jsonb cannot store")
                : encoded;
        }

        private T Decode<T>(string text) => _worker._codec.Deserialize<T>(text)!;

        /// <summary>A <c>jsonb</c> column as JSON text. SQL <c>NULL</c> reads as the JSON value <c>null</c>.</summary>
        private static string JsonText(Row row, string column) => row.Text(column) ?? "null";

        /// <summary>JSON with the keys of every object sorted, so equal requests encode to equal text.</summary>
        private static string SortedJson(JsonNode? node) => Values.Write(Sorted(node));

        private static JsonNode? Sorted(JsonNode? node) => node switch
        {
            JsonObject members => new JsonObject(members
                .OrderBy(member => member.Key, StringComparer.Ordinal)
                .Select(member => KeyValuePair.Create(member.Key, Sorted(member.Value)))),
            JsonArray items => new JsonArray([.. items.Select(Sorted)]),
            null => null,
            _ => node.DeepClone(),
        };

        /// <summary>A fenced write of this attempt. The statement takes the stop-path token.</summary>
        private Task<Row> FencedAsync(SqlCatalogue.Statement statement, params NpgsqlParameter[] rest) =>
            _worker.FencedRowAsync(statement, Task, () => [.. rest.Select(Clone)], _statements);

        /// <summary>A parameter belongs to one command, so each resend after a deadlock takes a copy.</summary>
        private static NpgsqlParameter Clone(NpgsqlParameter parameter) => parameter.Clone();

        private async Task<IReadOnlyList<Row>> RowsAsync(SqlCatalogue.Statement statement, params NpgsqlParameter[] parameters)
        {
            await using var connection = await DataSources.OpenAsync(_worker._dataSource, _statements).ConfigureAwait(false);
            return await Sql.RowsAsync(connection, statement, parameters, _statements).ConfigureAwait(false);
        }

        private async Task<T> WithConnectionAsync<T>(Func<NpgsqlConnection, Task<T>> body)
        {
            await using var connection = await DataSources.OpenAsync(_worker._dataSource, _statements).ConfigureAwait(false);
            return await body(connection).ConfigureAwait(false);
        }
    }
}
