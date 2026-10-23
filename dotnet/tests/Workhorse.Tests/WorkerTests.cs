using System.Text.Json;
using Workhorse.Internal;
using Workhorse.Tests.Testing;
using static Workhorse.Tests.Testing.WorkerHarness;

namespace Workhorse.Tests;

/// <summary>The C# worker against PostgreSQL: claim, run, settle, fences, cancellation, and drain.</summary>
public sealed class WorkerTests(ScratchDatabase database)
{
    private static readonly string[] RequiredValue = ["value"];

    private sealed record Order(int OrderId);

    private sealed record Total(int Value);

    /// <summary>An exception type that names itself, as the fixtures' <c>PaymentDeclined</c> does.</summary>
    private sealed class PaymentDeclinedException(string message) : Exception(message);

    /// <summary>An exception whose text members throw, as a faulty formatter can.</summary>
    private sealed class UnprintableException : Exception
    {
        public override string Message => throw new InvalidOperationException("no message");

        public override string ToString() => throw new InvalidOperationException("no text");
    }

    [Fact]
    public async Task CompletesAHandledTaskWithItsResult()
    {
        var queue = UniqueQueue("complete");
        await using var worker = new Worker(database.DataSource, Options(queue));
        worker.Handle<Order, Total>("total", (_, order) => Task.FromResult(new Total(order.OrderId * 2)));
        var taskId = await EnqueueAsync(database.DataSource, queue, "total", new { orderId = 7 });

        await using var running = new RunningWorker(worker);
        var row = await TaskInStateAsync(database.DataSource, taskId, "succeeded");

        Assert.Equal(14, row.Json("result")!.Value.GetProperty("value").GetInt32());
        Assert.Equal(1, row.RequiredInteger("current_attempt"));
        await running.StopAsync();
    }

    [Fact]
    public async Task AReplayConflictInsideAWrapperFailsTheTaskWithoutARetry()
    {
        var queue = UniqueQueue("wrapped-conflict");
        var delays = 0;
        await using var worker = new Worker(database.DataSource, Options(queue, options => options.RetryDelay = (_, _) =>
        {
            Interlocked.Increment(ref delays);
            return TimeSpan.Zero;
        }));
        worker.Handle<Order>("replay", (_, _) =>
            Task.FromException(new InvalidOperationException("wrapped", new ConflictException("checkpoint", "saved"))));
        var taskId = await EnqueueAsync(database.DataSource, queue, "replay", new { orderId = 1 }, new { maxAttempts = 5 });

        Assert.True(await worker.RunOnceAsync(TestContext.Current.CancellationToken));
        var row = await TaskAsync(database.DataSource, taskId);
        Assert.Equal("failed", row.Text("state"));
        Assert.Equal(1, row.RequiredInteger("current_attempt"));
        Assert.Equal("ConflictException", row.Json("error")!.Value.GetProperty("name").GetString());
        Assert.Equal(0, delays);
    }

    [Fact]
    public async Task APlainWrapperWithoutAConflictStillRetries()
    {
        var queue = UniqueQueue("wrapped-plain");
        var delays = 0;
        await using var worker = new Worker(database.DataSource, Options(queue, options => options.RetryDelay = (_, _) =>
        {
            Interlocked.Increment(ref delays);
            return TimeSpan.FromMinutes(1);
        }));
        worker.Handle<Order>("replay", (_, _) =>
            Task.FromException(new InvalidOperationException("wrapped", new TimeoutException("slow"))));
        var taskId = await EnqueueAsync(database.DataSource, queue, "replay", new { orderId = 1 }, new { maxAttempts = 5 });

        Assert.True(await worker.RunOnceAsync(TestContext.Current.CancellationToken));
        var row = await TaskAsync(database.DataSource, taskId);
        Assert.Equal("scheduled", row.Text("state"));
        Assert.Equal(2, row.RequiredInteger("current_attempt"));
        Assert.Equal(1, delays);
    }

    [Fact]
    public async Task AHandlerExceptionFailsTheAttemptAndTheWorkerContinues()
    {
        var queue = UniqueQueue("failure");
        await using var worker = new Worker(database.DataSource, Options(queue));
        worker.Handle<Order, Total>("charge", (_, order) =>
            order.OrderId == 1 ? throw new PaymentDeclinedException("card declined") : Task.FromResult(new Total(order.OrderId)));
        var failing = await EnqueueAsync(database.DataSource, queue, "charge", new { orderId = 1 }, new { maxAttempts = 1 });

        await using var running = new RunningWorker(worker);
        var failed = await TaskInStateAsync(database.DataSource, failing, "failed");
        var error = failed.Json("error")!.Value;
        Assert.Equal("PaymentDeclinedException", error.GetProperty("name").GetString());
        Assert.Equal("card declined", error.GetProperty("message").GetString());
        Assert.Contains(nameof(PaymentDeclinedException), error.GetProperty("stack").GetString(), StringComparison.Ordinal);

        // The run did not end: the next task completes on the same worker.
        var next = await EnqueueAsync(database.DataSource, queue, "charge", new { orderId = 2 });
        await TaskInStateAsync(database.DataSource, next, "succeeded");
        Assert.False(running.Run.IsCompleted);
        await running.StopAsync();
    }

    [Fact]
    public async Task AStaleFenceCannotSettleTheTask()
    {
        var queue = UniqueQueue("fence");
        var firstStarted = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var secondStarted = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var firstProceeds = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var secondProceeds = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var calls = 0;
        await using var worker = new Worker(database.DataSource, Options(queue, options => options.Concurrency = 2));
        worker.Handle<Order, string>("fenced", async (_, _) =>
        {
            if (Interlocked.Increment(ref calls) == 1)
            {
                firstStarted.SetResult();
                // The first attempt ignores its token, so it reaches its settlement after the fence moved.
                await firstProceeds.Task;
                return "stale";
            }

            secondStarted.SetResult();
            await secondProceeds.Task;
            return "current";
        });
        var taskId = await EnqueueAsync(database.DataSource, queue, "fenced", new { orderId = 1 });

        await using var running = new RunningWorker(worker);
        await firstStarted.Task.WaitAsync(Patience, TestContext.Current.CancellationToken);
        var staleFence = long.Parse((await TaskAsync(database.DataSource, taskId)).RequiredText("version"), System.Globalization.CultureInfo.InvariantCulture);
        // The release moves the task back to its queue, and the second slot claims it with a newer fence.
        Assert.Equal("released", await ScalarAsync(database.DataSource, "SELECT workhorse.release_owned_v1($1, $2, $3)", taskId, worker.WorkerId, staleFence));
        await secondStarted.Task.WaitAsync(Patience, TestContext.Current.CancellationToken);
        var currentFence = long.Parse((await TaskAsync(database.DataSource, taskId)).RequiredText("version"), System.Globalization.CultureInfo.InvariantCulture);
        Assert.True(currentFence > staleFence);

        // The same worker ID with the old fence cannot complete the task that a newer attempt owns.
        Assert.Equal(false, await ScalarAsync(database.DataSource, "SELECT workhorse.complete_v1($1, $2, $3, '\"stale\"'::jsonb)", taskId, worker.WorkerId, staleFence));
        firstProceeds.SetResult();
        await EventuallyAsync(() => worker.ActiveAttempts == 1, "the stale attempt ends without a settlement");
        Assert.Equal("active", (await TaskAsync(database.DataSource, taskId)).Text("state"));

        secondProceeds.SetResult();
        var row = await TaskInStateAsync(database.DataSource, taskId, "succeeded");
        Assert.Equal("current", row.Json("result")!.Value.GetString());
        await running.StopAsync();
    }

    /// <summary>The drain attempts that a loaded host can make inconclusive before the drain test fails.</summary>
    private const int DrainAttempts = 3;

    [Fact]
    public async Task DrainFinishesRunningTasksInsideTheGraceAndReturnsTheRest()
    {
        // After the grace, the cancelled handler has one unwind window of 250 ms to release its task.
        // On a loaded host, that release or the settlement of the finishing task can take longer. The
        // stop then abandons that attempt and throws, and the stop path cancels the late statement
        // (SM-1682, as SM-1543 and SM-1155). Such an attempt shows nothing about the drain, so the
        // test runs it again.
        for (var attempt = 1; attempt <= DrainAttempts; attempt++)
        {
            if (await DrainOnceAsync())
            {
                return;
            }
        }

        Assert.Fail(
            $"In each of {DrainAttempts} attempts, the stop abandoned one attempt because its settlement outlived the unwind window. "
            + "A host stall cannot explain that every time, so look for a slow settlement on the stop path.");
    }

    /// <summary>
    /// Runs one drain of two handlers. Returns <c>false</c> when the stop abandoned one attempt
    /// because its settlement outlived the unwind window.
    /// </summary>
    private async Task<bool> DrainOnceAsync()
    {
        var queue = UniqueQueue("drain");
        var bothStarted = new CountdownEvent(2);
        var seen = new TaskCompletionSource<CancelReason?>(TaskCreationOptions.RunContinuationsAsynchronously);
        var finish = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        await using var worker = new Worker(database.DataSource, Options(queue, options =>
        {
            options.Concurrency = 2;
            options.ShutdownGrace = TimeSpan.FromSeconds(2);
        }));
        worker.Handle<Order, string>("drain", async (context, order) =>
        {
            bothStarted.Signal();
            if (order.OrderId == 1)
            {
                // This handler finishes inside the grace.
                await finish.Task;
                return "finished";
            }

            // This handler waits for its token, which the drain cancels at the end of the grace.
            try
            {
                await Task.Delay(Timeout.Infinite, context.CancellationToken);
            }
            finally
            {
                seen.TrySetResult(context.CancelReason);
            }

            return "never";
        });
        var finishing = await EnqueueAsync(database.DataSource, queue, "drain", new { orderId = 1 });
        var returned = await EnqueueAsync(database.DataSource, queue, "drain", new { orderId = 2 });

        await using var running = new RunningWorker(worker);
        await EventuallyAsync(() => bothStarted.IsSet, "both handlers run");
        var stop = running.StopAsync();
        finish.SetResult();
        try
        {
            await stop;
        }
        catch (ShutdownIncompleteException error) when (error.Abandoned == 1)
        {
            // The host stalled a settlement of either attempt past the unwind window.
            return false;
        }

        var completed = await TaskAsync(database.DataSource, finishing);
        Assert.Equal("succeeded", completed.Text("state"));
        var back = await TaskAsync(database.DataSource, returned);
        Assert.Equal("ready", back.Text("state"));
        Assert.Equal(CancelReason.Shutdown, await seen.Task.WaitAsync(Patience, TestContext.Current.CancellationToken));
        return true;
    }

    [Fact]
    public async Task AHandlerThatIgnoresTheShutdownEndsTheRunWithShutdownIncomplete()
    {
        var queue = UniqueQueue("abandon");
        var started = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        await using var worker = new Worker(database.DataSource, Options(queue, options => options.ShutdownGrace = TimeSpan.FromMilliseconds(200)));
        worker.Handle<Order>("stuck", async (_, _) =>
        {
            started.SetResult();
            await release.Task;
        });
        await EnqueueAsync(database.DataSource, queue, "stuck", new { orderId = 1 });

        var running = new RunningWorker(worker);
        await started.Task.WaitAsync(Patience, TestContext.Current.CancellationToken);
        var error = await Assert.ThrowsAsync<ShutdownIncompleteException>(running.StopAsync);
        Assert.Equal(1, error.Abandoned);
        release.SetResult();
    }

    [Fact]
    public async Task ATaskTypeWithoutAHandlerGoesBackToItsQueue()
    {
        var queue = UniqueQueue("unhandled");
        await using var worker = new Worker(database.DataSource, Options(queue));
        worker.Handle<Order>("known", (_, _) => Task.CompletedTask);
        var taskId = await EnqueueAsync(database.DataSource, queue, "unknown", new { orderId = 1 });

        Assert.False(await worker.RunOnceAsync(TestContext.Current.CancellationToken));

        var row = await TaskAsync(database.DataSource, taskId);
        Assert.Equal("ready", row.Text("state"));
    }

    [Fact]
    public async Task ClaimedTasksNeverExceedTheConcurrency()
    {
        var queue = UniqueQueue("bounded");
        var running = 0;
        var peak = 0;
        await using var worker = new Worker(database.DataSource, Options(queue, options => options.Concurrency = 2));
        worker.Handle<Order>("bounded", async (_, _) =>
        {
            InterlockedMax(ref peak, Interlocked.Increment(ref running));
            // Each handler waits until both slots run, so the peak shows the bound and not timing.
            await EventuallyAsync(() => Volatile.Read(ref running) >= 2 || Volatile.Read(ref peak) >= 2, "both slots run");
            Assert.InRange(worker.ActiveAttempts, 1, 2);
            Interlocked.Decrement(ref running);
        });
        var tasks = new List<Guid>();
        for (var index = 0; index < 6; index++)
        {
            tasks.Add(await EnqueueAsync(database.DataSource, queue, "bounded", new { orderId = index }));
        }

        await using var run = new RunningWorker(worker);
        foreach (var taskId in tasks)
        {
            await TaskInStateAsync(database.DataSource, taskId, "succeeded");
        }

        Assert.Equal(2, peak);
        await run.StopAsync();
    }

    [Fact]
    public async Task ACancelRequestCancelsTheTokenWithItsReason()
    {
        var queue = UniqueQueue("cancel");
        var started = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        CancelReason? seen = null;
        await using var worker = new Worker(database.DataSource, Options(queue, options =>
        {
            options.Lease = TimeSpan.FromSeconds(3);
            options.Heartbeat = TimeSpan.FromMilliseconds(200);
        }));
        worker.Handle<Order>("cancellable", async (context, _) =>
        {
            // The reason is set before the token is cancelled, so a callback reads it.
            using var registration = context.CancellationToken.Register(() => seen = context.CancelReason);
            started.SetResult();
            await Task.Delay(Timeout.Infinite, context.CancellationToken);
        });
        var taskId = await EnqueueAsync(database.DataSource, queue, "cancellable", new { orderId = 1 });

        await using var running = new RunningWorker(worker);
        await started.Task.WaitAsync(Patience, TestContext.Current.CancellationToken);
        await ScalarAsync(database.DataSource, "SELECT status FROM workhorse.cancel_v1($1, 'test', 'no longer needed')", taskId);

        await TaskInStateAsync(database.DataSource, taskId, "canceled");
        await EventuallyAsync(() => seen is not null, "the cancellation callback runs");
        Assert.Equal(CancelReason.Requested, seen);
        await running.StopAsync();
    }

    [Fact]
    public async Task TheHeartbeatRenewsTheLeaseOfALongHandler()
    {
        var queue = UniqueQueue("renew");
        DateTimeOffset? claimedLease = null;
        // A 3 s lease leaves a busy shared machine room for a slow round (SM-1155).
        await using var worker = new Worker(database.DataSource, Options(queue, options => options.Lease = TimeSpan.FromSeconds(3)));
        worker.Handle<Order>("long", async (context, _) =>
        {
            claimedLease = context.Task.LeaseExpiresAt;
            // The handler outlives its first lease window, and returns once PostgreSQL shows a renewal
            // that the heartbeat sent after that window ended.
            await EventuallyAsync(
                async () => await ScalarAsync(database.DataSource, "SELECT expires_at FROM workhorse.task_runtime WHERE task_id = $1", context.Task.Id)
                    is DateTime renewed && new DateTimeOffset(renewed, TimeSpan.Zero) > claimedLease!.Value.AddSeconds(3.5),
                "a renewal after the first lease window ended");
        });
        var taskId = await EnqueueAsync(database.DataSource, queue, "long", new { orderId = 1 });

        await using var running = new RunningWorker(worker);
        var row = await TaskInStateAsync(database.DataSource, taskId, "succeeded");
        Assert.Equal(1, row.RequiredInteger("current_attempt"));
        await running.StopAsync();
    }

    [Fact]
    public async Task ANotificationWakesAListeningWorker()
    {
        var queue = UniqueQueue("notify");
        await using var worker = new Worker(database.DataSource, Options(queue, options =>
        {
            // Polling alone would wait a minute, so only the notification can claim the task in time.
            options.PollInterval = TimeSpan.FromMinutes(1);
            options.DisableRegistry = true;
        }));
        worker.Handle<Order>("notified", (_, _) => Task.CompletedTask);

        await using var running = new RunningWorker(worker);
        await EventuallyAsync(() => worker.ListeningForTests, "the worker listens");
        // A claim that found nothing starts the minute-long wait, so only a notification ends it.
        await EventuallyAsync(() => Volatile.Read(ref worker.ClaimsAnswered) > 0 && Volatile.Read(ref worker.ClaimsInFlight) == 0, "a claim finds nothing");
        var taskId = await EnqueueAsync(database.DataSource, queue, "notified", new { orderId = 1 });
        await TaskInStateAsync(database.DataSource, taskId, "succeeded");
        await running.StopAsync();
    }

    [Fact]
    public async Task TheWorkerRegistersItselfAndAnOperatorCanPauseIt()
    {
        var queue = UniqueQueue("registry");
        await using var worker = new Worker(database.DataSource, Options(queue, options => options.RegistryInterval = TimeSpan.FromMilliseconds(100)));
        worker.Handle<Order>("paused", (_, _) => Task.CompletedTask);

        await using var running = new RunningWorker(worker);
        await EventuallyAsync(
            async () => await ScalarAsync(database.DataSource, "SELECT sdk_language FROM workhorse.worker_registry WHERE worker_id = $1", worker.WorkerId) is "csharp",
            "the worker registers as csharp");
        Assert.Equal(
            SdkVersion.Current,
            await ScalarAsync(database.DataSource, "SELECT sdk_version FROM workhorse.worker_registry WHERE worker_id = $1", worker.WorkerId));

        await ScalarAsync(database.DataSource, "SELECT 1 FROM workhorse.set_worker_paused_v1($1, true, 'test', 'maintenance', $2)", worker.WorkerId, Guid.NewGuid().ToString());
        await EventuallyAsync(() => worker.IsPaused, "the worker reads the remote pause");

        // A paused worker claims nothing, so the task stays ready for many poll intervals.
        var taskId = await EnqueueAsync(database.DataSource, queue, "paused", new { orderId = 1 });
        await Task.Delay(TimeSpan.FromMilliseconds(500), TestContext.Current.CancellationToken);
        Assert.Equal("ready", (await TaskAsync(database.DataSource, taskId)).Text("state"));

        await ScalarAsync(database.DataSource, "SELECT 1 FROM workhorse.set_worker_paused_v1($1, false, 'test', 'done', $2)", worker.WorkerId, Guid.NewGuid().ToString());
        await EventuallyAsync(() => !worker.IsPaused, "the worker reads the resume");
        await TaskInStateAsync(database.DataSource, taskId, "succeeded");
        await running.StopAsync();
        await EventuallyAsync(
            async () => await ScalarAsync(database.DataSource, "SELECT count(*) FROM workhorse.worker_registry WHERE worker_id = $1", worker.WorkerId) is 0L,
            "the stopped worker deregisters");
    }

    [Fact]
    public async Task AResultOverItsLimitFailsOneAttemptAndTheWorkerContinues()
    {
        var queue = UniqueQueue("size");
        await using var worker = new Worker(database.DataSource, Options(queue));
        worker.Handle<Order, string>("sized", (_, order) => Task.FromResult(new string('x', order.OrderId)));
        var large = await EnqueueAsync(database.DataSource, queue, "sized", new { orderId = 200 }, new { maxAttempts = 1, resultMaxBytes = 100 });
        var small = await EnqueueAsync(database.DataSource, queue, "sized", new { orderId = 5 }, new { resultMaxBytes = 100 });

        await using var running = new RunningWorker(worker);
        var failed = await TaskInStateAsync(database.DataSource, large, "failed");
        Assert.Equal(nameof(ValueSizeLimitException), failed.Json("error")!.Value.GetProperty("name").GetString());
        await TaskInStateAsync(database.DataSource, small, "succeeded");
        await running.StopAsync();
    }

    [Fact]
    public async Task AResultThatBreaksItsPayloadContractFailsOneAttemptAndTheWorkerContinues()
    {
        var queue = UniqueQueue("contract");
        var taskType = $"contract-{Guid.NewGuid():N}";
        var definitions = JsonSerializer.Serialize(new[]
        {
            new
            {
                taskType,
                currentVersion = "v1",
                versions = new Dictionary<string, object>
                {
                    ["v1"] = new
                    {
                        payloadSchema = new { type = "object" },
                        resultSchema = new { type = "object", required = RequiredValue },
                    },
                },
            },
        });
        await ScalarAsync(database.DataSource, "SELECT workhorse.sync_contract_definitions_v1($1::text::jsonb)", definitions);
        await using var worker = new Worker(database.DataSource, Options(queue));
        worker.Handle<Order, object>(taskType, (_, order) => Task.FromResult<object>(order.OrderId == 1 ? new { other = 1 } : new Total(2)));
        var breaking = await EnqueueAsync(database.DataSource, queue, taskType, new { orderId = 1 }, new { maxAttempts = 1, contractVersion = "v1" });
        var keeping = await EnqueueAsync(database.DataSource, queue, taskType, new { orderId = 2 }, new { contractVersion = "v1" });

        await using var running = new RunningWorker(worker);
        var failed = await TaskInStateAsync(database.DataSource, breaking, "failed");
        Assert.Equal(nameof(ContractValidationException), failed.Json("error")!.Value.GetProperty("name").GetString());
        await TaskInStateAsync(database.DataSource, keeping, "succeeded");
        await running.StopAsync();
    }

    [Fact]
    public async Task AMaintenancePassFiresTheDueSchedulesOfItsNamespaces()
    {
        var queue = UniqueQueue("schedule");
        var @namespace = $"dotnet-{Guid.NewGuid():N}";
        var definitions = JsonSerializer.Serialize(new[]
        {
            new
            {
                type = "cron",
                payload = new { },
                queue,
                name = "every-minute",
                schedule = "* * * * *",
                timezone = "UTC",
                catchupPolicy = "latest",
                enabled = true,
            },
        });
        await ScalarAsync(database.DataSource, "SELECT workhorse.sync_schedule_definitions_v2($1, $2::text::jsonb, true)", @namespace, definitions);
        // The schedule was last evaluated two minutes ago, so one occurrence is due now.
        await ScalarAsync(
            database.DataSource,
            "UPDATE workhorse.schedule_definition SET last_evaluated_at = clock_timestamp() - interval '2 minutes' WHERE namespace = $1",
            @namespace);
        await using var worker = new Worker(database.DataSource, Options(queue, options => options.ScheduleNamespaces = [@namespace]));
        worker.Handle<JsonElement>("cron", (_, _) => Task.CompletedTask);

        Assert.True(await worker.RunOnceAsync(TestContext.Current.CancellationToken));
        Assert.True((long)(await ScalarAsync(database.DataSource, "SELECT count(*) FROM workhorse.schedule_occurrence WHERE namespace = $1", @namespace))! >= 1);
    }

    [Fact]
    public async Task AMaintenancePassRunsTheRetentionRoutines()
    {
        // The routine runs again only after its interval, so the test marks it as never run.
        await ScalarAsync(
            database.DataSource, "UPDATE workhorse.maintenance_state SET last_completed_at = NULL WHERE routine_name = 'terminal_storage'");
        await using var worker = new Worker(database.DataSource, Options(UniqueQueue("retention")));

        Assert.False(await worker.RunOnceAsync(TestContext.Current.CancellationToken));
        Assert.Equal(
            1L,
            await ScalarAsync(
                database.DataSource,
                "SELECT count(*) FROM workhorse.maintenance_state WHERE routine_name = 'terminal_storage' AND last_completed_at IS NOT NULL"));
    }

    [Fact]
    public async Task AnExecutionTimeoutCancelsTheHandlerAndSettlesTheAttempt()
    {
        var queue = UniqueQueue("timeout");
        CancelReason? seen = null;
        await using var worker = new Worker(database.DataSource, Options(queue));
        worker.Handle<Order>("slow", async (context, _) =>
        {
            using var registration = context.CancellationToken.Register(() => seen = context.CancelReason);
            await Task.Delay(Timeout.Infinite, context.CancellationToken);
        });
        var taskId = await EnqueueAsync(database.DataSource, queue, "slow", new { orderId = 1 }, new { maxAttempts = 1, executionTimeoutMs = 300 });

        await using var running = new RunningWorker(worker);
        await TaskInStateAsync(database.DataSource, taskId, "failed");
        await EventuallyAsync(() => seen is not null, "the handler sees the timeout");
        Assert.Equal(CancelReason.ExecutionTimeout, seen);
        await running.StopAsync();
    }

    [Fact]
    public async Task ABusyRowDoesNotCostTheLease()
    {
        var queue = UniqueQueue("busy");
        var started = new TaskCompletionSource<Guid>(TaskCreationOptions.RunContinuationsAsynchronously);
        var proceed = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        await using var worker = new Worker(database.DataSource, Options(queue, options =>
        {
            options.Lease = TimeSpan.FromSeconds(6);
            options.Heartbeat = TimeSpan.FromMilliseconds(500);
        }));
        worker.Handle<Order>("busy", async (context, _) =>
        {
            started.SetResult(context.Task.Id);
            await proceed.Task;
        });
        var taskId = await EnqueueAsync(database.DataSource, queue, "busy", new { orderId = 1 });

        await using var running = new RunningWorker(worker);
        await started.Task.WaitAsync(Patience, TestContext.Current.CancellationToken);
        var busy = worker.HeartbeatForTests.BusyLeases;
        await using (var holder = await database.DataSource.OpenConnectionAsync(TestContext.Current.CancellationToken))
        await using (var transaction = await holder.BeginTransactionAsync(TestContext.Current.CancellationToken))
        {
            // Another transaction locks the row. The rounds report the lease as busy, and renew nothing.
            await using var lockRow = new Npgsql.NpgsqlCommand("SELECT 1 FROM workhorse.task_runtime WHERE task_id = $1 FOR UPDATE", holder, transaction);
            lockRow.Parameters.Add(new Npgsql.NpgsqlParameter { Value = taskId });
            await lockRow.ExecuteScalarAsync(TestContext.Current.CancellationToken);
            await EventuallyAsync(() => worker.HeartbeatForTests.BusyLeases > busy + 1, "two rounds report the lease as busy");
            await transaction.CommitAsync(TestContext.Current.CancellationToken);
        }

        proceed.SetResult();
        var row = await TaskInStateAsync(database.DataSource, taskId, "succeeded");
        Assert.Equal(1, row.RequiredInteger("current_attempt"));
        await running.StopAsync();
    }

    [Fact]
    public async Task ALockedRowCannotHoldTheLeaseWatchdogBehindAnExpirationSettlement()
    {
        var queue = UniqueQueue("watchdog");
        var started = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        CancelReason? seen = null;
        await using var worker = new Worker(database.DataSource, Options(queue, options =>
        {
            options.Lease = TimeSpan.FromSeconds(3);
            options.Heartbeat = TimeSpan.FromSeconds(1);
        }));
        worker.Handle<Order>("locked", async (context, _) =>
        {
            using var registration = context.CancellationToken.Register(() => seen = context.CancelReason);
            started.SetResult();
            await release.Task;
        });
        var taskId = await EnqueueAsync(database.DataSource, queue, "locked", new { orderId = 1 }, new { executionTimeoutMs = 1_500 });

        await using var running = new RunningWorker(worker);
        await started.Task.WaitAsync(Patience, TestContext.Current.CancellationToken);
        await using (var holder = await database.DataSource.OpenConnectionAsync(TestContext.Current.CancellationToken))
        await using (var transaction = await holder.BeginTransactionAsync(TestContext.Current.CancellationToken))
        {
            // The lock outlives the execution timeout, so its settlement waits, and the lease, so the
            // rounds renew nothing. The watchdog still ends the attempt at the end of the lease window.
            await using var lockRow = new Npgsql.NpgsqlCommand("SELECT 1 FROM workhorse.task_runtime WHERE task_id = $1 FOR UPDATE", holder, transaction);
            lockRow.Parameters.Add(new Npgsql.NpgsqlParameter { Value = taskId });
            await lockRow.ExecuteScalarAsync(TestContext.Current.CancellationToken);
            await EventuallyAsync(() => seen is not null, "the lease watchdog cancels the handler while the row is locked");
            Assert.Equal(CancelReason.LeaseLost, seen);
            await transaction.RollbackAsync(TestContext.Current.CancellationToken);
        }

        release.SetResult();
        await EventuallyAsync(() => worker.ActiveAttempts == 0, "the attempt ends");
        await running.StopAsync();
    }

    [Fact]
    public void WorkersOnOneDataSourceShareOneHeartbeatAndOtherSourcesDoNot()
    {
        var first = new Worker(database.DataSource, Options("default"));
        var second = new Worker(database.DataSource, Options("default"));
        using var other = database.CreateDataSource(_ => { });
        var third = new Worker(other, Options("default"));
        var shared = new Worker(database.DataSource, Options("default", options => options.SharedHeartbeats = true));

        Assert.Same(first.HeartbeatForTests, second.HeartbeatForTests);
        Assert.NotSame(first.HeartbeatForTests, third.HeartbeatForTests);
        Assert.NotSame(first.HeartbeatForTests, shared.HeartbeatForTests);
        Assert.Same(Workhorse.Internal.Runtime.Listener.Shared(database.DataSource), Workhorse.Internal.Runtime.Listener.Shared(database.DataSource));
        Assert.NotSame(Workhorse.Internal.Runtime.Listener.Shared(database.DataSource), Workhorse.Internal.Runtime.Listener.Shared(other));
    }

    [Fact]
    public async Task AnExceptionWhoseTextThrowsStillFailsTheAttemptAndTheWorkerContinues()
    {
        var queue = UniqueQueue("unprintable");
        await using var worker = new Worker(database.DataSource, Options(queue));
        worker.Handle<Order>("unprintable", (_, order) => order.OrderId == 1 ? throw new UnprintableException() : Task.CompletedTask);
        var failing = await EnqueueAsync(database.DataSource, queue, "unprintable", new { orderId = 1 }, new { maxAttempts = 1 });

        await using var running = new RunningWorker(worker);
        var failed = await TaskInStateAsync(database.DataSource, failing, "failed");
        var error = failed.Json("error")!.Value;
        Assert.Equal(nameof(UnprintableException), error.GetProperty("name").GetString());
        Assert.Contains("unavailable", error.GetProperty("message").GetString(), StringComparison.Ordinal);

        var next = await EnqueueAsync(database.DataSource, queue, "unprintable", new { orderId = 2 });
        await TaskInStateAsync(database.DataSource, next, "succeeded");
        Assert.False(running.Run.IsCompleted);
        await running.StopAsync();
    }

    [Fact]
    public async Task ADeadlineBeyondTheTimerLimitRunsNormally()
    {
        var queue = UniqueQueue("far");
        await using var worker = new Worker(database.DataSource, Options(queue));
        worker.Handle<Order, int>("far", (_, order) => Task.FromResult(order.OrderId));
        // About 49.7 days is the longest single timer, and this deadline is later.
        var taskId = await EnqueueAsync(database.DataSource, queue, "far", new { orderId = 3 }, new { deadline = DateTimeOffset.UtcNow.AddDays(60) });

        await using var running = new RunningWorker(worker);
        var row = await TaskInStateAsync(database.DataSource, taskId, "succeeded");
        Assert.Equal(1, row.RequiredInteger("current_attempt"));
        Assert.False(running.Run.IsCompleted);
        await running.StopAsync();
    }

    [Fact]
    public async Task AHandlerRegistersOnlyBeforeTheFirstRun()
    {
        var queue = UniqueQueue("frozen");
        await using var worker = new Worker(database.DataSource, Options(queue));
        worker.Handle<Order>("first", (_, _) => Task.CompletedTask);
        await worker.RunOnceAsync(TestContext.Current.CancellationToken);

        Assert.Throws<InvalidOperationException>(() => worker.Handle<Order>("late", (_, _) => Task.CompletedTask));
    }

    [Fact]
    public void AWorkerRefusesAPoolSmallerThanThreeUnlessHeartbeatsAreShared()
    {
        using var small = database.CreateDataSource(builder => builder.MaxPoolSize = 2);
        Assert.Throws<ArgumentException>(() => new Worker(small, Options("default")));
        _ = new Worker(small, Options("default", options => options.SharedHeartbeats = true));

        using var multiplexing = database.CreateDataSource(builder => builder.Multiplexing = true);
        Assert.Throws<ArgumentException>(() => new Worker(multiplexing, Options("default")));
    }

    [Fact]
    public async Task AStartupReservationFailureEndsTheRun()
    {
        // Nothing listens on port 1, so the worker gets no heartbeat connection within its budget.
        using var unreachable = database.CreateDataSource(builder =>
        {
            builder.Host = "127.0.0.1";
            builder.Port = 1;
            builder.Timeout = 1;
        });
        await using var worker = new Worker(unreachable, Options("default"));

        await Assert.ThrowsAsync<WorkerStartupException>(() => worker.RunAsync(TestContext.Current.CancellationToken));
    }

    private static void InterlockedMax(ref int target, int value)
    {
        int current;
        while ((current = Volatile.Read(ref target)) < value && Interlocked.CompareExchange(ref target, value, current) != current)
        {
        }
    }
}
