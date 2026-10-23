using System.Diagnostics;
using Workhorse.Internal.Telemetry;
using Workhorse.Tests.Testing;
using static Workhorse.Tests.Testing.WorkerHarness;

namespace Workhorse.Tests.Telemetry;

/// <summary>
/// The spans and measurements of an enqueue and a worker run against PostgreSQL, as the runtime
/// listeners capture them (ADR 0107, "Telemetry"). Each test also holds every captured name to
/// <c>api/telemetry.txt</c>.
/// </summary>
public sealed class TelemetryDatabaseTests(ScratchDatabase database) : IDisposable
{
    private static readonly TelemetrySurface Surface = TelemetrySurface.Read();
    private static readonly string[] RetriedStates = ["ready", "scheduled"];
    private readonly TelemetryRecorder _recorder = new();
    private readonly string _queue = UniqueQueue("telemetry");

    private static CancellationToken Token => TestContext.Current.CancellationToken;

    private sealed record Approval(string By);

    public void Dispose() => _recorder.Dispose();

    [Fact]
    public async Task TheHandlerSpanContinuesTheTraceOfTheEnqueue()
    {
        Guid taskId;
        ActivityContext caller;
        using (var span = TelemetryRecorder.Caller.StartActivity("caller"))
        {
            caller = span!.Context;
            taskId = await EnqueueAsync("email.send");
        }

        await using var worker = Worker();
        worker.Handle<object?, object?>("email.send", (_, _) =>
        {
            using (TelemetryRecorder.Caller.StartActivity("inside"))
            {
                return Task.FromResult<object?>(null);
            }
        });
        Assert.True(await worker.RunOnceAsync(Token));

        var enqueue = Single(Names.SpanEnqueue, span => span.TraceId == caller.TraceId);
        Assert.Equal(caller.SpanId, enqueue.ParentSpanId);
        Assert.Equal(_queue, enqueue.GetTagItem(Names.QueueName));
        Assert.Equal("email.send", enqueue.GetTagItem(Names.TaskType));
        Assert.Equal(1L, enqueue.GetTagItem(Names.EnqueueCount));
        Assert.Equal(taskId.ToString(), enqueue.GetTagItem(Names.TaskId));
        Assert.Equal("accepted", enqueue.GetTagItem(Names.EnqueueOutcome));

        Assert.Equal(TraceParent(enqueue), await StoredTraceParentAsync(taskId));

        var handler = Handler(taskId);
        Assert.Equal(ActivityKind.Consumer, handler.Kind);
        Assert.Equal(caller.TraceId, handler.TraceId);
        Assert.Equal(enqueue.SpanId, handler.ParentSpanId);
        Assert.Equal(_queue, handler.GetTagItem(Names.QueueName));
        Assert.Equal("email.send", handler.GetTagItem(Names.TaskType));
        Assert.Equal(1L, handler.GetTagItem(Names.TaskAttempt));
        Assert.Equal("succeeded", handler.GetTagItem(Names.HandlerOutcome));
        Assert.Equal(ActivityStatusCode.Unset, handler.Status);
        Assert.Equal(handler.SpanId, Single("inside", span => span.TraceId == caller.TraceId).ParentSpanId);

        var complete = Single(Names.SpanComplete, span => Equals(span.GetTagItem(Names.TaskId), taskId.ToString()));
        Assert.Equal(handler.SpanId, complete.ParentSpanId);
        Assert.Equal(true, complete.GetTagItem(Names.CompleteAccepted));

        var claim = Single(Names.SpanClaim, span => Equals(span.GetTagItem(Names.TaskId), taskId.ToString()));
        Assert.Equal(_queue, claim.GetTagItem(Names.QueueName));
        Assert.Equal("full", claim.GetTagItem(Names.QueueTier));
        Assert.NotEqual(caller.TraceId, claim.TraceId);

        var task = Tags((Names.QueueName, _queue), (Names.TaskType, "email.send"));
        var succeeded = Tags((Names.QueueName, _queue), (Names.TaskType, "email.send"), (Names.HandlerOutcome, "succeeded"));
        AssertPoints("workhorse.tasks.claimed", [task]);
        AssertPoints("workhorse.tasks.completed", [task]);
        AssertPoints("workhorse.handler.runtime", [task]);
        AssertPoints("workhorse.handler.executions", [succeeded]);
        AssertPoints("workhorse.handler.duration", [succeeded]);
        Assert.All(
            _recorder.Of("workhorse.handler.executions", measurement => Equals(measurement.Tags[Names.QueueName], _queue)),
            measurement => Assert.Equal(handler.TraceId, measurement.Trace));
        Assert.Contains(
            _recorder.Of("workhorse.claim.duration", measurement => Equals(measurement.Tags[Names.QueueName], _queue)),
            measurement => Equals(measurement.Tags[Names.ClaimResult], "claimed"));
        _recorder.AssertGoverned(Surface);
    }

    [Fact]
    public async Task AHandlerFailureMarksTheHandlerSpanAndRecordsTheRetry()
    {
        var taskId = await EnqueueAsync("email.send", new EnqueueOptions { MaxAttempts = 2 });
        await using var worker = Worker();
        worker.Handle<object?, object?>("email.send", (_, _) => throw new InvalidOperationException("declined"));
        Assert.True(await worker.RunOnceAsync(Token));

        var handler = Handler(taskId);
        Assert.Equal(Single(Names.SpanEnqueue, span => Equals(span.GetTagItem(Names.TaskId), taskId.ToString())).SpanId, handler.ParentSpanId);
        Assert.Equal(ActivityStatusCode.Error, handler.Status);
        var exception = Assert.Single(handler.Events);
        Assert.Equal("exception", exception.Name);
        Assert.Equal(typeof(InvalidOperationException).FullName, exception.Tags.Single(tag => tag.Key == "exception.type").Value);

        var retry = Single(Names.SpanRetry, span => Equals(span.GetTagItem(Names.TaskId), taskId.ToString()));
        Assert.Equal(handler.SpanId, retry.ParentSpanId);
        var state = Assert.IsType<string>(retry.GetTagItem(Names.RetryOutcome));
        Assert.Contains(state, RetriedStates);
        Assert.Equal(state, handler.GetTagItem(Names.HandlerOutcome));

        var task = Tags((Names.QueueName, _queue), (Names.TaskType, "email.send"));
        AssertPoints("workhorse.tasks.failed", [Tags((Names.QueueName, _queue), (Names.TaskType, "email.send"), (Names.AttemptOutcome, state))]);
        AssertPoints("workhorse.tasks.retried", [task]);
        AssertPoints("workhorse.handler.executions", [Tags((Names.QueueName, _queue), (Names.TaskType, "email.send"), (Names.HandlerOutcome, "retry"))]);
        _recorder.AssertGoverned(Surface);
    }

    /// <summary>
    /// A durable wait ends the first attempt, and a later attempt resumes the handler. Both handler
    /// spans continue the trace of the enqueue, because the trace context stays on the task.
    /// </summary>
    [Fact]
    public async Task EachAttemptAfterASuspensionContinuesTheTraceOfTheEnqueue()
    {
        Guid taskId;
        ActivityTraceId trace;
        using (var span = TelemetryRecorder.Caller.StartActivity("caller"))
        {
            trace = span!.TraceId;
            taskId = await EnqueueAsync("await-signal");
        }

        await using var worker = Worker();
        worker.Handle<object?, object?>("await-signal", async (context, _) =>
            new { signal = await context.WaitForSignalAsync<Approval>("approved", TimeSpan.FromHours(1)) });
        Assert.True(await worker.RunOnceAsync(Token));
        Assert.Equal("suspended", Handler(taskId).GetTagItem(Names.HandlerOutcome));

        await new Queue(database.DataSource).SendSignalAsync(taskId, "approved", new Approval("ops"), "signal-1", "test", Token);
        for (var pass = 0; pass < 20 && (await TaskAsync(database.DataSource, taskId)).Text("state") != "succeeded"; pass++)
        {
            await ScalarAsync(database.DataSource, "SELECT count(*) FROM workhorse.tick_v1(100, 100)");
            await worker.RunOnceAsync(Token);
        }

        var enqueue = Single(Names.SpanEnqueue, span => span.TraceId == trace);
        var handlers = Handlers(taskId);
        Assert.Equal(2, handlers.Count);
        Assert.All(handlers, handler =>
        {
            Assert.Equal(trace, handler.TraceId);
            Assert.Equal(enqueue.SpanId, handler.ParentSpanId);
        });
        Assert.Equal("succeeded", handlers[1].GetTagItem(Names.HandlerOutcome));
        _recorder.AssertGoverned(Surface);
    }

    /// <summary>
    /// A fast-tier task completes through the fused statement. Its claim span names no tier, and its
    /// handler and complete spans continue the trace of the enqueue as on the full tier.
    /// </summary>
    [Fact]
    public async Task AFastTierAttemptContinuesTheTraceOfTheEnqueue()
    {
        await WorkerFastTierTests.FastTierAsync(database.DataSource, _queue);
        Guid taskId;
        ActivityTraceId trace;
        using (var span = TelemetryRecorder.Caller.StartActivity("caller"))
        {
            trace = span!.TraceId;
            taskId = await EnqueueAsync("total");
        }

        await using var worker = new Worker(database.DataSource, Options(_queue));
        worker.Handle<object?, object?>("total", (_, _) => Task.FromResult<object?>(1));
        await using (var running = new RunningWorker(worker))
        {
            await EventuallyAsync(
                async () => (long)(await ScalarAsync(database.DataSource, "SELECT count(*) FROM workhorse.fast_task_outcome WHERE task_id = $1", taskId))! == 1,
                "the fast-tier outcome");
            await running.StopAsync();
        }

        var enqueue = Single(Names.SpanEnqueue, span => span.TraceId == trace);
        var handler = Handler(taskId);
        Assert.Equal(trace, handler.TraceId);
        Assert.Equal(enqueue.SpanId, handler.ParentSpanId);
        Assert.Equal("succeeded", handler.GetTagItem(Names.HandlerOutcome));
        var complete = Single(Names.SpanComplete, span => Equals(span.GetTagItem(Names.TaskId), taskId.ToString()));
        Assert.Equal(handler.SpanId, complete.ParentSpanId);
        Assert.Equal(true, complete.GetTagItem(Names.CompleteAccepted));
        var claim = Single(Names.SpanClaim, span => Equals(span.GetTagItem(Names.TaskId), taskId.ToString()));
        Assert.Equal(_queue, claim.GetTagItem(Names.QueueName));
        Assert.Null(claim.GetTagItem(Names.QueueTier));
        var task = Tags((Names.QueueName, _queue), (Names.TaskType, "total"));
        AssertPoints("workhorse.tasks.claimed", [task]);
        AssertPoints("workhorse.tasks.completed", [task]);
        _recorder.AssertGoverned(Surface);
    }

    /// <summary>
    /// A batch handler runs two members in one invocation. Each member keeps its own handler span
    /// under its own enqueue, and the batch records its size and linger once.
    /// </summary>
    [Fact]
    public async Task ABatchRecordsItsSizeAndEachMemberKeepsItsTrace()
    {
        var members = new List<(Guid TaskId, ActivityTraceId Trace)>();
        for (var index = 0; index < 2; index++)
        {
            using var span = TelemetryRecorder.Caller.StartActivity("caller");
            members.Add((await EnqueueAsync("charge"), span!.TraceId));
        }

        await using var worker = new Worker(database.DataSource, Options(_queue, options => options.Concurrency = 2));
        worker.HandleBatch<object?>("charge", new BatchOptions { MaxSize = 2, Linger = TimeSpan.FromSeconds(30) }, (items, _) =>
            Task.FromResult<IReadOnlyList<BatchHandlerOutcome>>([.. items.Select(_ => new BatchSucceeded(null))]));
        await using (var running = new RunningWorker(worker))
        {
            foreach (var (taskId, _) in members)
            {
                await TaskInStateAsync(database.DataSource, taskId, "succeeded");
            }

            await running.StopAsync();
        }

        foreach (var (taskId, trace) in members)
        {
            var handler = Handler(taskId);
            Assert.Equal(trace, handler.TraceId);
            Assert.Equal(Single(Names.SpanEnqueue, span => span.TraceId == trace).SpanId, handler.ParentSpanId);
            Assert.Equal("succeeded", handler.GetTagItem(Names.HandlerOutcome));
        }

        var batch = Tags((Names.QueueName, _queue), (Names.TaskType, "charge"), (Names.HandlerBatchFull, true));
        AssertPoints("workhorse.handler.batch.size", [batch]);
        AssertPoints("workhorse.handler.batch.linger", [batch]);
        Assert.Equal(2, Assert.Single(_recorder.Of("workhorse.handler.batch.size", measurement => Equals(measurement.Tags[Names.QueueName], _queue))).Value);
        _recorder.AssertGoverned(Surface);
    }

    /// <summary>
    /// A task without a stored trace context starts a new trace, even when the worker runs inside an
    /// unrelated activity. The task comes from <c>enqueue_many_v1</c> directly, because the queue
    /// stores the context of its own enqueue span while a listener samples it.
    /// </summary>
    [Fact]
    public async Task ATaskWithoutATraceContextStartsANewTrace()
    {
        var taskId = await WorkerHarness.EnqueueAsync(database.DataSource, _queue, "email.send", null);
        Assert.Null(await StoredTraceParentAsync(taskId));
        await using var worker = Worker();
        worker.Handle<object?, object?>("email.send", (_, _) => Task.FromResult<object?>(null));
        using (var unrelated = TelemetryRecorder.Caller.StartActivity("unrelated"))
        {
            Assert.True(await worker.RunOnceAsync(Token));
            var handler = Handler(taskId);
            Assert.Equal(default, handler.ParentSpanId);
            Assert.NotEqual(unrelated!.TraceId, handler.TraceId);
        }
    }

    /// <summary>
    /// The pass runs inside a caller activity of this test, so its spans and measurements carry a
    /// trace that no parallel test shares.
    /// </summary>
    [Fact]
    public async Task AMaintenancePassRecordsItsSpansAndPhases()
    {
        await using var worker = Worker();
        ActivityTraceId trace;
        using (var caller = TelemetryRecorder.Caller.StartActivity("caller"))
        {
            trace = caller!.TraceId;
            Assert.False(await worker.RunOnceAsync(Token));
        }

        var maintenance = Single(Names.SpanMaintenance, span => span.TraceId == trace);
        Assert.Equal("tick", maintenance.GetTagItem(Names.MaintenanceOperation));
        Assert.IsType<long>(maintenance.GetTagItem(Names.MaintenanceRowsAffected));
        var recovery = Single(Names.SpanRecovery, span => span.TraceId == trace);
        Assert.Equal(maintenance.SpanId, recovery.ParentSpanId);
        Assert.IsType<bool>(recovery.GetTagItem(Names.RecoverySkipped));
        var runs = _recorder.Of("workhorse.maintenance.runs", measurement => measurement.Trace == trace);
        Assert.Contains(runs, measurement => Equals(measurement.Tags[Names.MaintenanceLoop], "tick") && Equals(measurement.Tags[Names.MaintenancePhase], "recover"));
        Assert.Equal(runs.Count, _recorder.Of("workhorse.maintenance.duration", measurement => measurement.Trace == trace).Count);
        _recorder.AssertGoverned(Surface);
    }

    [Fact]
    public void TheEnqueueStoresNoTraceContextWithoutACurrentActivity()
    {
        Activity.Current = null;
        Assert.Null(Instrumentation.InjectTraceContext());
    }

    [Fact]
    public void TheEnqueueStoresOnlyTheW3CFieldsOfTheCurrentActivity()
    {
        using var span = TelemetryRecorder.Caller.StartActivity("caller")!;
        span.TraceStateString = "vendor=value";
        span.AddBaggage("tenant", "acme");
        var stored = Instrumentation.InjectTraceContext();
        Assert.NotNull(stored);
        Assert.Equal(["traceparent", "tracestate"], stored.Select(member => member.Key));
        Assert.Equal(TraceParent(span), (string?)stored["traceparent"]);
        Assert.Equal("vendor=value", (string?)stored["tracestate"]);
    }

    /// <summary>
    /// <c>valid_trace_context_v1</c> measures the <c>jsonb</c> text, which puts a space after each
    /// colon and comma. A carrier at the limit is stored, and one byte more stores nothing.
    /// PostgreSQL agrees on both carriers.
    /// </summary>
    [Fact]
    public async Task TheEnqueueStoresNoTraceContextLargerThanPostgreSQLAccepts()
    {
        const string Parent = "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01";
        // {"traceparent": "…", "tracestate": "…"} has 37 bytes beside its two values.
        var fits = new Dictionary<string, string> { ["traceparent"] = Parent, ["tracestate"] = new string('a', Instrumentation.MaxTraceContextBytes - 37 - Parent.Length) };
        var larger = new Dictionary<string, string>(fits) { ["tracestate"] = fits["tracestate"] + "a" };
        Assert.NotNull(Instrumentation.StoredTraceContext(fits));
        Assert.Null(Instrumentation.StoredTraceContext(larger));
        Assert.Null(Instrumentation.StoredTraceContext(new Dictionary<string, string> { ["tracestate"] = "vendor=value" }));
        Assert.Equal(true, await ValidAsync(fits));
        Assert.Equal(false, await ValidAsync(larger));
    }

    private async Task<object?> ValidAsync(Dictionary<string, string> carrier) =>
        await ScalarAsync(database.DataSource, "SELECT workhorse.valid_trace_context_v1($1::text::jsonb)", System.Text.Json.JsonSerializer.Serialize(carrier));

    private Worker Worker() =>
        new(database.DataSource, Options(_queue, options =>
        {
            options.PollingOnly = true;
            options.PollInterval = TimeSpan.FromMilliseconds(10);
            options.DisableRegistry = true;
        }));

    private async Task<Guid> EnqueueAsync(string taskType, EnqueueOptions? options = null) =>
        (await new Queue(database.DataSource).EnqueueAsync<object?>(taskType, null, (options ?? new EnqueueOptions()) with { Queue = _queue }, Token)).TaskId;

    /// <summary>
    /// The <c>traceparent</c> of <paramref name="span"/>. The flags come from the activity: .NET 11
    /// also sets the W3C random trace ID flag, so a sampled span can carry <c>03</c>, not <c>01</c>.
    /// </summary>
    private static string TraceParent(Activity span) =>
        $"00-{span.TraceId}-{span.SpanId}-{(int)span.ActivityTraceFlags:x2}";

    private async Task<string?> StoredTraceParentAsync(Guid taskId) =>
        await ScalarAsync(database.DataSource, "SELECT trace_context->>'traceparent' FROM workhorse.task WHERE id = $1", taskId) as string;

    private Activity Single(string name, Func<Activity, bool> match) => Assert.Single(_recorder.SpansNamed(name, match));

    private List<Activity> Handlers(Guid taskId) =>
        [.. _recorder.SpansNamed(Names.SpanHandler, span => Equals(span.GetTagItem(Names.TaskId), taskId.ToString())).OrderBy(span => span.StartTimeUtc)];

    private Activity Handler(Guid taskId) => Assert.Single(Handlers(taskId));

    private static Dictionary<string, object?> Tags(params (string Key, object? Value)[] tags) =>
        tags.ToDictionary(tag => tag.Key, tag => tag.Value, StringComparer.Ordinal);

    /// <summary>The tags of each measurement of <paramref name="instrument"/> on this test's queue.</summary>
    private void AssertPoints(string instrument, IReadOnlyList<Dictionary<string, object?>> expected)
    {
        var points = _recorder.Of(instrument, measurement => measurement.Tags.TryGetValue(Names.QueueName, out var queue) && Equals(queue, _queue));
        Assert.Equal(expected.Count, points.Count);
        for (var index = 0; index < expected.Count; index++)
        {
            Assert.Equal(expected[index].OrderBy(tag => tag.Key), points[index].Tags.OrderBy(tag => tag.Key));
        }
    }
}
