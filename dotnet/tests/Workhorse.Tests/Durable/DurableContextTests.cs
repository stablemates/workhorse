using System.Collections.Concurrent;
using System.Text.Json;
using Microsoft.Extensions.Logging;
using Npgsql;
using Workhorse.Internal;
using Workhorse.Internal.Database;
using Workhorse.Internal.Durable;
using Workhorse.Tests.Testing;
using static Workhorse.Tests.Testing.WorkerHarness;

namespace Workhorse.Tests.Durable;

/// <summary>
/// The durable context against PostgreSQL: checkpoints, timers, waits, children, task groups,
/// progress, and suspension (ADR 0107, "Durable context" and "Suspension"). Each test drives the
/// worker with <see cref="Worker.RunOnceAsync"/> passes and reads the task state, so no test waits
/// for a fixed time.
/// </summary>
/// <remarks>
/// Each worker pass of these tests runs maintenance, and a maintenance pass skips a routine that
/// another pass holds. This class has a database of its own, so its passes do not make a pass of a
/// parallel class skip a routine (SM-1732).
/// </remarks>
public sealed class DurableContextTests(ScratchDatabase database) : IClassFixture<ScratchDatabase>
{
    private readonly string _queue = UniqueQueue("durable");

    private static CancellationToken Token => TestContext.Current.CancellationToken;

    private NpgsqlDataSource DataSource => database.DataSource;

    // ---------------------------------------------------------------------------------------------
    // Checkpoints and suspension

    [Fact]
    public async Task SuspendsATaskAndResumesItOnASecondWorkerThatReadsTheCheckpoint()
    {
        var taskId = await EnqueueAsync("prepare-then-wait", null);
        var operations = 0;
        TaskCheckpoint? seen = null;
        var reasons = new ConcurrentQueue<CancelReason?>();
        async Task<object?> Handler(HandlerContext context, object? payload)
        {
            try
            {
                seen = await context.GetCheckpointAsync("prepare");
                var prepared = await context.CheckpointAsync("prepare", _ => Task.FromResult(new Charge(Interlocked.Increment(ref operations))));
                await context.SleepAsync("after-prepare", TimeSpan.FromSeconds(30));
                return new { prepared };
            }
            finally
            {
                reasons.Enqueue(context.CancellationToken.IsCancellationRequested ? context.CancelReason : null);
            }
        }

        await using var first = Worker("dotnet-durable-first");
        first.Handle<object?, object?>("prepare-then-wait", Handler);
        Assert.True(await first.RunOnceAsync(Token));
        var suspended = await TaskAsync(DataSource, taskId);
        Assert.Equal("scheduled", suspended.Text("state"));
        Assert.Null(seen);
        Assert.Equal(0L, await ScalarAsync(DataSource, "SELECT count(*) FROM workhorse.attempt_history WHERE task_id = $1", taskId));
        Assert.Equal(CancelReason.Suspended, Assert.Single(reasons));

        await WakeAsync(taskId);
        await using var second = Worker("dotnet-durable-second");
        second.Handle<object?, object?>("prepare-then-wait", Handler);
        var done = await DriveAsync(second, taskId, "succeeded");
        Assert.Equal(1, done.RequiredInteger("current_attempt"));
        Assert.Equal(1, done.Json("result")!.Value.GetProperty("prepared").GetProperty("operation").GetInt32());
        Assert.Equal(1, operations);
        Assert.NotNull(seen);
        Assert.Equal("dotnet-durable-first", seen.WorkerId);
        Assert.Equal(1, seen.Value!.Value.GetProperty("operation").GetInt32());
        Assert.Null(seen.InputFingerprint);
    }

    [Fact]
    public async Task ReplaysACheckpointAndANullValueOnTheNextAttempt()
    {
        var taskId = await EnqueueAsync("checkpoint-retry", null, Retrying(2));
        var operations = 0;
        await using var worker = Worker();
        worker.Handle<object?, object?>("checkpoint-retry", async (context, _) =>
        {
            var empty = await context.CheckpointAsync<string?>("empty", _ =>
            {
                Interlocked.Increment(ref operations);
                return Task.FromResult<string?>(null);
            });
            var count = await context.CheckpointAsync("count", _ => Task.FromResult(Interlocked.Increment(ref operations)));
            return context.Task.Attempt == 1 ? throw new InvalidOperationException("the first attempt fails after its checkpoints") : new { empty, count };
        });

        var done = await DriveAsync(worker, taskId, "succeeded");
        Assert.Equal(2, done.RequiredInteger("current_attempt"));
        Assert.Equal("""{"count":2,"empty":null}""", Canonical(done.Json("result")));
        Assert.Equal(2, operations);
    }

    /// <summary>
    /// A worker saves a checkpoint and then loses PostgreSQL, as a crashed process does. Its lease
    /// expires, recovery returns the task to its queue, and another worker replays the checkpoint
    /// without running the operation again.
    /// </summary>
    [Fact]
    public async Task ACheckpointWrittenBeforeACrashReplaysAfterAReclaim()
    {
        var direct = new NpgsqlConnectionStringBuilder(DataSource.ConnectionString);
        await using var proxy = new FaultProxy(direct.Host!, direct.Port);
        await using var crashing = database.CreateDataSource(builder =>
        {
            builder.Host = "127.0.0.1";
            builder.Port = proxy.Port;
            // A loaded machine can take seconds to open a connection. After the freeze the proxy
            // refuses connections, so this timeout does not slow the test.
            builder.Timeout = 15;
            builder.CancellationTimeout = 2_000;
        });
        var taskId = await EnqueueAsync("charge", null, Retrying(3));
        var operations = 0;
        var saved = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var crashed = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        Func<HandlerContext, object?, Task<object?>> handler = async (context, _) =>
        {
            var charge = await context.CheckpointAsync("charge-card", _ => Task.FromResult(new Charge(Interlocked.Increment(ref operations))));
            if (context.Task.Attempt == 1)
            {
                saved.SetResult();
                // The process is gone: the handler never returns, and nothing renews its lease.
                await crashed.Task;
            }

            return charge;
        };

        var first = new Worker(crashing, Options(_queue, options =>
        {
            options.WorkerId = "dotnet-durable-crashed";
            options.Lease = TimeSpan.FromSeconds(1);
            options.Heartbeat = TimeSpan.FromMilliseconds(250);
            options.PollingOnly = true;
            options.DisableRegistry = true;
            options.ShutdownGrace = TimeSpan.Zero;
        }));
        first.Handle("charge", handler);
        var running = new RunningWorker(first);
        try
        {
            await saved.Task.WaitAsync(Patience, Token);
            await proxy.FreezeAsync(refuseConnections: true);

            await using var second = Worker("dotnet-durable-survivor");
            second.Handle("charge", handler);
            Row? done = null;
            await EventuallyAsync(
                async () =>
                {
                    await ScalarAsync(DataSource, "SELECT workhorse.recover_expired_v1(100, 0)");
                    await second.RunOnceAsync(Token);
                    done = await TaskAsync(DataSource, taskId);
                    return done.Text("state") == "succeeded";
                },
                "the second worker completes the reclaimed task");
            Assert.Equal(2, done!.RequiredInteger("current_attempt"));
            Assert.Equal(1, done.Json("result")!.Value.GetProperty("operation").GetInt32());
            Assert.Equal(1, operations);
            var checkpoint = await ScalarAsync(DataSource, "SELECT worker_id FROM workhorse.task_checkpoint WHERE task_id = $1", taskId);
            Assert.Equal("dotnet-durable-crashed", checkpoint);
        }
        finally
        {
            crashed.TrySetResult();
            proxy.Thaw();
            await running.DisposeAsync();
            await first.DisposeAsync();
        }
    }

    [Fact]
    public async Task ConcurrentCallsWithOneNameShareOneOperation()
    {
        var taskId = await EnqueueAsync("concurrent-checkpoint", null);
        var operations = 0;
        await using var worker = Worker();
        worker.Handle<object?, object?>("concurrent-checkpoint", async (context, _) =>
        {
            var started = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            var proceed = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            var mine = context.CheckpointAsync("shared", async _ =>
            {
                started.SetResult();
                await proceed.Task;
                return Interlocked.Increment(ref operations);
            });
            await started.Task;
            // The second call starts while the operation of the first runs, and shares it.
            var other = context.CheckpointAsync("shared", _ => Task.FromResult(Interlocked.Increment(ref operations)));
            proceed.SetResult();
            return new[] { await mine, await other };
        });

        Assert.True(await worker.RunOnceAsync(Token));
        Assert.Equal("[1,1]", Canonical((await TaskAsync(DataSource, taskId)).Json("result")));
        Assert.Equal(1, operations);
    }

    [Fact]
    public async Task ADifferentCheckpointInputFailsTheTaskWithoutRunningTheOperation()
    {
        var taskId = await EnqueueAsync("checkpoint-input", null, Retrying(3));
        var operations = 0;
        await using var worker = Worker();
        worker.Handle<object?>("checkpoint-input", async (context, _) =>
        {
            // The first two attempts give the same input, and the third another one.
            var cents = context.Task.Attempt < 3 ? 1000 : 900;
            await context.CheckpointAsync(
                "charge-card",
                new CheckpointOptions { Input = new { amountCents = cents } },
                _ => Task.FromResult(new { chargedCents = Interlocked.Increment(ref operations) }));
            throw new InvalidOperationException($"attempt {context.Task.Attempt} fails");
        });

        var failed = await DriveAsync(worker, taskId, "failed");
        Assert.Equal(3, failed.RequiredInteger("current_attempt"));
        Assert.Equal("CheckpointInputConflictException", failed.Json("error")!.Value.GetProperty("name").GetString());
        Assert.Equal(1, operations);
        Assert.Equal(
            Checkpoints.InputFingerprint(new { amountCents = 1000 }),
            await ScalarAsync(DataSource, "SELECT input_fingerprint FROM workhorse.task_checkpoint WHERE task_id = $1", taskId));
    }

    [Fact]
    public async Task AHandlerThatCatchesTheSuspensionStillSuspends()
    {
        var taskId = await EnqueueAsync("swallowing", null);
        Exception? caught = null;
        Exception? refused = null;
        await using var worker = Worker();
        worker.Handle<object?, string>("swallowing", async (context, _) =>
        {
            try
            {
                await context.SleepAsync("nap", TimeSpan.FromSeconds(30));
            }
            catch (Exception error)
            {
                caught = error;
            }

            try
            {
                await context.SetProgressAsync(1);
            }
            catch (CancelledException error)
            {
                refused = error;
            }

            return "ignored";
        });

        Assert.True(await worker.RunOnceAsync(Token));
        Assert.Equal("scheduled", (await TaskAsync(DataSource, taskId)).Text("state"));
        var cancelled = Assert.IsAssignableFrom<OperationCanceledException>(caught);
        Assert.True(cancelled.CancellationToken.IsCancellationRequested);
        Assert.Equal(CancelReason.Suspended, Assert.IsType<CancelledException>(refused).Reason);
        Assert.Equal(0L, await ScalarAsync(DataSource, "SELECT count(*) FROM workhorse.task_progress WHERE task_id = $1", taskId));
    }

    /// <summary>
    /// A handler that catches the suspension and returns a result keeps nothing: the worker does not
    /// encode the result, so a result that blocks or throws cannot hold the slot.
    /// </summary>
    [Fact]
    public async Task TheWorkerDoesNotEncodeTheResultOfASuspendedHandler()
    {
        var taskId = await EnqueueAsync("suspended-result", null);
        var enumerated = false;
        IEnumerable<int> Result()
        {
            enumerated = true;
            yield return 1;
        }

        await using var worker = Worker();
        worker.Handle<object?, IEnumerable<int>>("suspended-result", async (context, _) =>
        {
            try
            {
                await context.SleepAsync("nap", TimeSpan.FromSeconds(30));
            }
            catch (OperationCanceledException)
            {
                // The handler keeps the suspension and returns a result.
            }

            return Result();
        });

        Assert.True(await worker.RunOnceAsync(Token));
        Assert.Equal("scheduled", (await TaskAsync(DataSource, taskId)).Text("state"));
        Assert.False(enumerated);
    }

    /// <summary>
    /// The bookkeeping after a durable write cannot change its effect. A logger that throws after
    /// the release still suspends the task with <see cref="CancelReason.Suspended"/>, and a logger
    /// that throws after a checkpoint save does not run the operation again.
    /// </summary>
    [Fact]
    public async Task ALoggerFailureAfterADurableWriteChangesNothing()
    {
        var sleeping = await EnqueueAsync("failing-log-sleep", null);
        var checkpointing = await EnqueueAsync("failing-log-checkpoint", null);
        CancelReason? reason = null;
        var operations = 0;
        await using var worker = Worker(configure: options => options.LoggerFactory = new FailingLoggerFactory("workhorse.task.wait_processed", "workhorse.task.checkpoint_saved"));
        worker.Handle<object?, string>("failing-log-sleep", async (context, _) =>
        {
            try
            {
                await context.SleepAsync("nap", TimeSpan.FromSeconds(30));
            }
            finally
            {
                reason = context.CancelReason;
            }

            return "not reached";
        });
        worker.Handle<object?, int>("failing-log-checkpoint", async (context, _) =>
        {
            try
            {
                await context.CheckpointAsync("charge-card", _ => Task.FromResult(Interlocked.Increment(ref operations)));
            }
            catch (InvalidOperationException)
            {
                // The handler retries the call after the logger failed.
            }

            return await context.CheckpointAsync("charge-card", _ => Task.FromResult(Interlocked.Increment(ref operations)));
        });

        await DriveAsync(worker, checkpointing, "succeeded");
        Assert.Equal("scheduled", (await TaskAsync(DataSource, sleeping)).Text("state"));
        Assert.Equal(CancelReason.Suspended, reason);
        Assert.Equal(1, operations);
    }

    /// <summary>
    /// A cancellation of the handler does not cut a durable write in the middle: the statement takes
    /// the stop-path token, so it runs to its own end, and the handler sees its status (ADR 0107,
    /// "Cancellation and statements"; SM-1447). The test holds the row lock of the task, so the
    /// checkpoint write waits, and the heartbeat reports the lease as busy until the lease window
    /// ends and the worker cancels the token.
    /// </summary>
    [Fact]
    public async Task ACancellationDoesNotCutADurableWriteInTheMiddle()
    {
        var taskId = await EnqueueAsync("held-checkpoint", null);
        var operating = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var proceed = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var cancelled = new TaskCompletionSource<CancelReason?>(TaskCreationOptions.RunContinuationsAsynchronously);
        var outcome = new TaskCompletionSource<Exception?>(TaskCreationOptions.RunContinuationsAsynchronously);
        await using var worker = new Worker(DataSource, Options(_queue, options =>
        {
            options.Lease = TimeSpan.FromSeconds(1);
            options.Heartbeat = TimeSpan.FromMilliseconds(200);
            options.PollingOnly = true;
            options.DisableRegistry = true;
        }));
        worker.Handle<object?>("held-checkpoint", async (context, _) =>
        {
            using var registration = context.CancellationToken.Register(() => cancelled.TrySetResult(context.CancelReason));
            try
            {
                await context.CheckpointAsync("charge-card", async _ =>
                {
                    operating.SetResult();
                    await proceed.Task;
                    return "charged";
                });
                outcome.SetResult(null);
            }
            catch (Exception error)
            {
                outcome.SetResult(error);
            }
        });

        await using var running = new RunningWorker(worker);
        await operating.Task.WaitAsync(Patience, Token);
        await using var holder = await DataSource.OpenConnectionAsync(Token);
        await using var transaction = await holder.BeginTransactionAsync(Token);
        await using (var lockRow = new NpgsqlCommand("SELECT 1 FROM workhorse.task_runtime WHERE task_id = $1 FOR UPDATE", holder, transaction))
        {
            lockRow.Parameters.Add(new NpgsqlParameter { Value = taskId });
            await lockRow.ExecuteScalarAsync(Token);
        }

        proceed.SetResult();
        await EventuallyAsync(async () => await WaitingWritesAsync() == 1, "the checkpoint write waits for the row lock");
        Assert.Equal(CancelReason.LeaseLost, await cancelled.Task.WaitAsync(Patience, Token));
        // The cancellation sent no cancel request for the statement: it still waits for the lock.
        Assert.Equal(1L, await WaitingWritesAsync());
        Assert.False(outcome.Task.IsCompleted);

        await transaction.RollbackAsync(Token);
        // The statement ends on its own and returns its status. PostgreSQL saves the checkpoint when
        // its lease has not expired yet, and fences the write when it has: the local lease window
        // ends a little before the expiry that PostgreSQL holds. A cut statement would throw a
        // database or cancellation exception instead.
        var error = await outcome.Task.WaitAsync(Patience, Token);
        Assert.True(error is null or LeaseLostException, $"the write ended with {error}");
        await running.StopAsync();
    }

    private async Task<long> WaitingWritesAsync() =>
        (long)(await ScalarAsync(
            DataSource,
            "SELECT count(*) FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE '%save_checkpoint_v2%'"))!;

    [Fact]
    public async Task AnInvalidNameThrowsBeforeAnyStatement()
    {
        var taskId = await EnqueueAsync("invalid-names", null);
        var thrown = 0;
        await using var worker = Worker();
        worker.Handle<object?>("invalid-names", async (context, _) =>
        {
            var tooLong = new string('x', 201);
            Func<Task>[] calls =
            [
                () => context.CheckpointAsync(string.Empty, _ => Task.FromResult(1)),
                () => context.CheckpointAsync(tooLong, _ => Task.FromResult(1)),
                () => context.SleepAsync(string.Empty, TimeSpan.FromSeconds(1)),
                () => context.SleepAsync("nap", TimeSpan.Zero),
                () => context.SleepUntilAsync("nap", DateTimeOffset.UtcNow.AddDays(366)),
                () => context.WaitForSignalAsync<object?>(" padded", null),
                () => context.WaitForSignalAsync<object?>("approved", TimeSpan.FromDays(8)),
                () => context.WaitForHumanAsync<object?, object?>("review ", null, null),
                () => context.RunChildAsync<object?, object?>(string.Empty, "child", null, new EnqueueOptions()),
                () => context.RunChildrenAsync(
                [
                    new ChildRequest { Name = "same", TaskType = "child" },
                    new ChildRequest { Name = "same", TaskType = "child" },
                ]),
            ];
            foreach (var call in calls)
            {
                try
                {
                    await call();
                }
                catch (ArgumentException)
                {
                    thrown++;
                }
            }
        });

        Assert.True(await worker.RunOnceAsync(Token));
        Assert.Equal(10, thrown);
        Assert.Equal("succeeded", (await TaskAsync(DataSource, taskId)).Text("state"));
        Assert.Equal(0L, await ScalarAsync(DataSource, "SELECT count(*) FROM workhorse.task_wait WHERE task_id = $1", taskId));
    }

    [Fact]
    public async Task AHumanWaitContextIsMeasuredAsJsonbTextBeforeItsStatement()
    {
        // Compact JSON writes 30,000 zeros in 60,001 bytes. PostgreSQL's jsonb text puts a space
        // after each comma, so it writes the same array in 90,000 bytes, which is above the limit.
        var zeros = new int[30_000];
        Assert.True(JsonSerializer.Serialize(zeros).Length < 65_536);
        var taskId = await EnqueueAsync("oversized-human-context", null);
        string? message = null;
        await using var worker = Worker();
        worker.Handle<object?>("oversized-human-context", async (context, _) =>
        {
            var error = await Assert.ThrowsAsync<ArgumentException>(
                () => context.WaitForHumanAsync<int[], object?>("review", zeros, null));
            message = error.Message;
        });

        Assert.True(await worker.RunOnceAsync(Token));
        Assert.StartsWith("human wait context must be at most 65536 bytes of JSON", message, StringComparison.Ordinal);
        Assert.Equal("succeeded", (await TaskAsync(DataSource, taskId)).Text("state"));
        Assert.Equal(0L, await ScalarAsync(DataSource, "SELECT count(*) FROM workhorse.task_human_wait WHERE task_id = $1", taskId));
    }

    // ---------------------------------------------------------------------------------------------
    // Durable timers

    [Fact]
    public async Task ATimerThatElapsedReturnsAtOnce()
    {
        var taskId = await EnqueueAsync("past-timer", null);
        await using var worker = Worker();
        worker.Handle<object?, string>("past-timer", async (context, _) =>
        {
            await context.SleepUntilAsync("past", DateTimeOffset.UtcNow.AddSeconds(-1));
            return "woke";
        });

        Assert.True(await worker.RunOnceAsync(Token));
        var done = await TaskAsync(DataSource, taskId);
        Assert.Equal("succeeded", done.Text("state"));
        Assert.Equal("woke", done.Json("result")!.Value.GetString());
    }

    [Fact]
    public async Task AnAbsoluteTimerSuspendsUntilItsTimeAndThenReturns()
    {
        var taskId = await EnqueueAsync("future-timer", null);
        var wakeAt = DateTimeOffset.UtcNow.AddSeconds(60);
        var runs = 0;
        await using var worker = Worker();
        worker.Handle<object?, int>("future-timer", async (context, _) =>
        {
            Interlocked.Increment(ref runs);
            await context.SleepUntilAsync("later", wakeAt);
            return runs;
        });

        Assert.True(await worker.RunOnceAsync(Token));
        Assert.Equal("scheduled", (await TaskAsync(DataSource, taskId)).Text("state"));
        await WakeAsync(taskId);
        Assert.Equal(2, (await DriveAsync(worker, taskId, "succeeded")).Json("result")!.Value.GetInt32());
    }

    // ---------------------------------------------------------------------------------------------
    // Signal and human-decision waits

    [Fact]
    public async Task ASignalWaitSuspendsAndReturnsTheDeliveredPayload()
    {
        var taskId = await EnqueueAsync("await-signal", null);
        await using var worker = Worker();
        worker.Handle<object?, object?>("await-signal", async (context, _) =>
            new { signal = await context.WaitForSignalAsync<Approval>("approved", TimeSpan.FromHours(1)) });

        Assert.True(await worker.RunOnceAsync(Token));
        Assert.NotEqual("succeeded", (await TaskAsync(DataSource, taskId)).Text("state"));
        await new Queue(DataSource).SendSignalAsync(taskId, "approved", new Approval("ops"), "signal-1", "test", Token);
        var done = await DriveAsync(worker, taskId, "succeeded");
        Assert.Equal("""{"signal":{"by":"ops"}}""", Canonical(done.Json("result")));
        Assert.Equal(1, done.RequiredInteger("current_attempt"));
    }

    [Fact]
    public async Task AHumanWaitSuspendsAndReturnsTheRecordedDecision()
    {
        var taskId = await EnqueueAsync("await-human", null);
        await using var worker = Worker();
        worker.Handle<object?, JsonElement>("await-human", (context, _) =>
            context.WaitForHumanAsync<object, JsonElement>("review", new { z = 1, a = "refund" }, TimeSpan.FromHours(1)));

        Assert.True(await worker.RunOnceAsync(Token));
        Assert.NotEqual("succeeded", (await TaskAsync(DataSource, taskId)).Text("state"));
        Assert.Equal(
            """{"a":"refund","z":1}""",
            Canonical(Json(await ScalarAsync(DataSource, "SELECT context::text FROM workhorse.task_human_wait WHERE task_id = $1", taskId))));
        await new Queue(DataSource).CompleteHumanWaitAsync(taskId, "review", new { approved = true }, "decision-1", "reviewer", Token);
        Assert.Equal("""{"approved":true}""", Canonical((await DriveAsync(worker, taskId, "succeeded")).Json("result")));
    }

    // ---------------------------------------------------------------------------------------------
    // Linked children

    /// <summary>The worker has one slot, so the child runs only because the suspended parent released it.</summary>
    [Fact]
    public async Task RunChildCreatesTheChildAndReturnsItsResult()
    {
        var parentId = await EnqueueAsync("parent", new Amount(7));
        var parentRuns = 0;
        await using var worker = Worker(configure: options => options.Concurrency = 1);
        worker.Handle<Amount, object?>("parent", async (context, payload) =>
        {
            Interlocked.Increment(ref parentRuns);
            return new { child = await context.RunChildAsync<Amount, Amount>("double", "double", payload, new EnqueueOptions()) };
        });
        worker.Handle<Amount, Amount>("double", (_, payload) => Task.FromResult(new Amount(payload.Value * 2)));

        var done = await DriveAsync(worker, parentId, "succeeded");
        Assert.Equal("""{"child":{"value":14}}""", Canonical(done.Json("result")));
        Assert.Equal(2, parentRuns);
        Assert.Equal(1, done.RequiredInteger("current_attempt"));
        Assert.Equal(
            1L,
            await ScalarAsync(
                DataSource,
                "SELECT count(*) FROM workhorse.task_child edge JOIN workhorse.task child ON child.id = edge.child_task_id WHERE edge.parent_task_id = $1 AND child.queue_name = $2",
                parentId,
                _queue));
    }

    [Fact]
    public async Task RunChildrenReturnsEachOutcomeByName()
    {
        var parentId = await EnqueueAsync("fan-out", null);
        await using var worker = Worker();
        worker.Handle<object?, object?>("fan-out", async (context, _) =>
        {
            var outcomes = await context.RunChildrenAsync(
            [
                new ChildRequest { Name = "good", TaskType = "child-ok", Payload = 1 },
                new ChildRequest { Name = "bad", TaskType = "child-fails", Payload = 2, Options = new EnqueueOptions { MaxAttempts = 1 } },
            ]);
            return new
            {
                good = outcomes["good"].Status.ToString(),
                goodResult = outcomes["good"].Result,
                bad = outcomes["bad"].Status.ToString(),
                badError = outcomes["bad"].Error!.Value.GetProperty("name").GetString(),
            };
        });
        worker.Handle<int, int>("child-ok", (_, payload) => Task.FromResult(payload * 10));
        worker.Handle<int, int>("child-fails", (_, _) => throw new InvalidOperationException("child fails"));

        var done = await DriveAsync(worker, parentId, "succeeded");
        Assert.Equal(
            """{"bad":"Failed","badError":"InvalidOperationException","good":"Succeeded","goodResult":10}""",
            Canonical(done.Json("result")));
    }

    [Fact]
    public async Task RunChildrenAllReturnsEachResultByName()
    {
        var parentId = await EnqueueAsync("fan-out-all", null);
        await using var worker = Worker();
        worker.Handle<object?, IReadOnlyDictionary<string, JsonElement>>("fan-out-all", (context, _) =>
            context.RunChildrenAllAsync(
            [
                new ChildRequest { Name = "one", TaskType = "child-ok", Payload = 1 },
                new ChildRequest { Name = "two", TaskType = "child-ok", Payload = 2 },
            ]));
        worker.Handle<int, int>("child-ok", (_, payload) => Task.FromResult(payload * 10));

        Assert.Equal("""{"one":10,"two":20}""", Canonical((await DriveAsync(worker, parentId, "succeeded")).Json("result")));
    }

    // ---------------------------------------------------------------------------------------------
    // Task groups

    [Fact]
    public async Task AMemberTaskReadsItsGroupAndAddsATaskToIt()
    {
        var queue = new Queue(DataSource);
        var block = await queue.TaskGroupAsync(
            new TaskGroupCallbacks(), builder => builder.Add("member", null, new EnqueueOptions { Queue = _queue }), Token);
        var memberId = block.Tasks[0].TaskId;
        TaskGroupLink? link = null;
        Guid? added = null;
        await using var worker = Worker();
        worker.Handle<object?>("member", async (context, _) =>
        {
            link = await context.TaskGroup.GetAsync();
            if (context.Task.Id == memberId)
            {
                added = (await context.TaskGroup.AddAsync([new EnqueueRequest { TaskType = "member" }]))[0].TaskId;
            }
        });

        await DriveAsync(worker, memberId, "succeeded");
        Assert.NotNull(link);
        Assert.Equal(TaskGroupRole.Member, link.Role);
        Assert.Null(link.Callback);
        Assert.Equal(block.Group.Id, link.Group.Id);
        Assert.NotNull(added);
        Assert.Equal(_queue, (await TaskAsync(DataSource, added.Value)).Text("queue_name"));
        await DriveAsync(worker, added.Value, "succeeded");
        Assert.Equal(2, (await queue.ListTaskGroupMembersAsync(block.Group.Id, Token)).Members.Count);
    }

    [Fact]
    public async Task ATaskWithNoGroupReadsNoneAndCannotAdd()
    {
        var taskId = await EnqueueAsync("ungrouped", null);
        TaskGroupLink? link = null;
        Exception? refused = null;
        await using var worker = Worker();
        worker.Handle<object?>("ungrouped", async (context, _) =>
        {
            link = await context.TaskGroup.GetAsync();
            try
            {
                await context.TaskGroup.AddAsync([new EnqueueRequest { TaskType = "ungrouped" }]);
            }
            catch (ArgumentException error)
            {
                refused = error;
            }
        });

        Assert.True(await worker.RunOnceAsync(Token));
        Assert.Equal("succeeded", (await TaskAsync(DataSource, taskId)).Text("state"));
        Assert.Null(link);
        Assert.IsType<ArgumentException>(refused);
    }

    // ---------------------------------------------------------------------------------------------
    // Progress

    [Fact]
    public async Task SetProgressStoresTheLatestValueAndANewAttemptReadsIt()
    {
        var taskId = await EnqueueAsync("progress", null, Retrying(2));
        var reads = new ConcurrentQueue<string>();
        TaskProgress? written = null;
        TaskProgress? readBack = null;
        await using var worker = Worker();
        worker.Handle<object?, long>("progress", async (context, _) =>
        {
            reads.Enqueue(Canonical((await context.GetProgressAsync())?.Value));
            if (context.Task.Attempt == 1)
            {
                // The handler records the values, and the test asserts them after the run, because
                // the worker treats any exception of this attempt as the expected failure.
                written = await context.SetProgressAsync(new { done = 1 });
                readBack = await context.GetProgressAsync();
                throw new InvalidOperationException("retry");
            }

            return (await context.GetProgressAsync())!.Revision;
        });

        var done = await DriveAsync(worker, taskId, "succeeded");
        Assert.NotNull(written);
        Assert.Equal("""{"done":1}""", Canonical(written.Value));
        Assert.Equal(written, readBack);
        Assert.Equal(["null", """{"done":1}"""], reads);
        Assert.Equal(written.Revision, done.Json("result")!.Value.GetInt64());
    }

    // ---------------------------------------------------------------------------------------------
    // The fast tier

    [Fact]
    public async Task AFastTierTaskRefusesEachDurableCallBeforeAnyWrite()
    {
        await using (var connection = await DataSource.OpenConnectionAsync(Token))
        {
            await Sql.RowsAsync(
                connection,
                SqlCatalogue.SetQueueTierV1,
                [Parameters.Text(_queue), Parameters.Text("fast"), Parameters.Text("operator"), Parameters.Text("test")],
                Token);
        }

        var taskId = await EnqueueAsync("fast", null);
        var features = new ConcurrentQueue<string>();
        await using var worker = Worker();
        worker.Handle<object?>("fast", async (context, _) =>
        {
            Func<Task>[] calls =
            [
                () => context.CheckpointAsync("step", _ => Task.FromResult(1)),
                () => context.SetProgressAsync(1),
                () => context.SleepAsync("nap", TimeSpan.FromSeconds(1)),
                () => context.WaitForSignalAsync<object?>("approved", null),
            ];
            foreach (var call in calls)
            {
                try
                {
                    await call();
                }
                catch (FastTierUnsupportedException refused)
                {
                    features.Enqueue(refused.Feature);
                }
            }
        });

        Assert.True(await worker.RunOnceAsync(Token));
        Assert.Equal(["checkpoints", "progress", "durable waits", "signal waits"], features);
        Assert.Equal(0L, await ScalarAsync(DataSource, "SELECT count(*) FROM workhorse.task_checkpoint WHERE task_id = $1", taskId));
    }

    // ---------------------------------------------------------------------------------------------
    // Support

    /// <summary>A logger factory whose loggers throw for the named events.</summary>
    private sealed class FailingLoggerFactory(params string[] events) : ILoggerFactory, ILogger
    {
        public ILogger CreateLogger(string categoryName) => this;

        public void AddProvider(ILoggerProvider provider)
        {
        }

        public void Dispose()
        {
        }

        public IDisposable? BeginScope<TState>(TState state)
            where TState : notnull => null;

        public bool IsEnabled(LogLevel logLevel) => true;

        public void Log<TState>(LogLevel logLevel, EventId eventId, TState state, Exception? exception, Func<TState, Exception?, string> formatter)
        {
            if (events.Contains(eventId.Name))
            {
                throw new InvalidOperationException($"the logger fails for {eventId.Name}");
            }
        }
    }

    private sealed record Charge(int Operation);

    private sealed record Amount(int Value);

    private sealed record Approval(string By);

    private Worker Worker(string workerId = "dotnet-durable-worker", Action<WorkerOptions>? configure = null) =>
        new(DataSource, Options(_queue, options =>
        {
            options.WorkerId = workerId;
            options.PollingOnly = true;
            options.PollInterval = TimeSpan.FromMilliseconds(10);
            options.DisableRegistry = true;
            configure?.Invoke(options);
        }));

    private static EnqueueOptions Retrying(int maxAttempts) =>
        new() { MaxAttempts = maxAttempts, RetryPolicy = RetryPolicy.Fixed(TimeSpan.Zero) };

    private async Task<Guid> EnqueueAsync(string taskType, object? payload, EnqueueOptions? options = null) =>
        (await new Queue(DataSource).EnqueueAsync(taskType, payload, (options ?? new EnqueueOptions()) with { Queue = _queue }, Token)).TaskId;

    /// <summary>
    /// Wakes a task that a durable timer suspended. The timer is long enough that it cannot elapse on
    /// a slow machine, so the test moves it back and promotes it, as the shared runtime fixture does.
    /// </summary>
    private async Task WakeAsync(Guid taskId)
    {
        await ScalarAsync(DataSource, "UPDATE workhorse.task_runtime SET run_at = clock_timestamp() - interval '1 millisecond' WHERE task_id = $1", taskId);
        await TickAsync();
    }

    private Task<object?> TickAsync() => ScalarAsync(DataSource, "SELECT count(*) FROM workhorse.tick_v1(100, 100)");

    /// <summary>Runs passes of <paramref name="worker"/> until <paramref name="taskId"/> reaches <paramref name="expected"/>.</summary>
    private async Task<Row> DriveAsync(Worker worker, Guid taskId, string expected)
    {
        for (var pass = 0; pass < 20; pass++)
        {
            var current = await TaskAsync(DataSource, taskId);
            if (current.Text("state") == expected)
            {
                return current;
            }

            await TickAsync();
            await worker.RunOnceAsync(Token);
        }

        var last = await TaskAsync(DataSource, taskId);
        Assert.Fail($"the task did not reach {expected}: {last.Text("state")} {last.Text("error")}");
        return last;
    }

    private static JsonElement Json(object? text)
    {
        using var document = JsonDocument.Parse((string)text!);
        return document.RootElement.Clone();
    }

    /// <summary>A value as text with sorted keys, so a test compares it as one string.</summary>
    private static string Canonical(JsonElement? value) =>
        value is { } element ? CanonicalJson.Canonical(element.GetRawText()) : "null";
}
