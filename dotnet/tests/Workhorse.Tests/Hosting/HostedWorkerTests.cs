using System.Collections.Concurrent;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Workhorse.Hosting;
using Workhorse.Hosting.Internal;
using Workhorse.Tests.Testing;
using static Workhorse.Tests.Testing.WorkerHarness;

namespace Workhorse.Tests.Hosting;

/// <summary>The hosted worker of <c>Workhorse.Hosting</c> against PostgreSQL (ADR 0107).</summary>
public sealed class HostedWorkerTests(ScratchDatabase database) : IClassFixture<ScratchDatabase>
{
    private static CancellationToken Token => TestContext.Current.CancellationToken;

    internal sealed record Order(int OrderId);

    internal sealed record Total(int Value);

    /// <summary>Lets a test hold a handler until the host stops.</summary>
    internal sealed class Gate
    {
        internal TaskCompletionSource Started { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);

        internal TaskCompletionSource Release { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
    }

    internal sealed class GatedHandler(Gate gate) : ITaskHandler<Order>
    {
        public string TaskType => "hosted.gated";

        public async Task<object?> HandleAsync(HandlerContext context, Order payload)
        {
            gate.Started.TrySetResult();
            await gate.Release.Task.ConfigureAwait(false);
            return new Total(payload.OrderId * 2);
        }
    }

    /// <summary>Records each scoped resource that a handler uses, and each disposal.</summary>
    internal sealed class Ledger
    {
        internal ConcurrentQueue<Guid> Used { get; } = new();

        internal ConcurrentDictionary<Guid, int> Disposed { get; } = new();
    }

    internal sealed class AttemptResource(Ledger ledger) : IAsyncDisposable
    {
        internal Guid Id { get; } = Guid.NewGuid();

        internal void Use() => ledger.Used.Enqueue(Id);

        public ValueTask DisposeAsync()
        {
            ledger.Disposed.AddOrUpdate(Id, 1, (_, count) => count + 1);
            return ValueTask.CompletedTask;
        }
    }

    internal sealed class ScopedHandler(AttemptResource resource) : ITaskHandler<Order>
    {
        public string TaskType => "hosted.scoped";

        public Task<object?> HandleAsync(HandlerContext context, Order payload)
        {
            resource.Use();
            return context.Task.Attempt == 1
                ? throw new InvalidOperationException("the first attempt fails")
                : Task.FromResult<object?>(new Total(payload.OrderId));
        }
    }

    /// <summary>
    /// The queue and the admin client of the container log through the logger factory of the host,
    /// as the hosted worker does.
    /// </summary>
    [Fact]
    public async Task TheQueueAndTheAdminLogThroughTheHost()
    {
        var testing = new HostingTesting(database.DataSource, UniqueQueue("logs"));
        using var host = testing.Build();

        await host.Services.GetRequiredService<Queue>().EnqueueAsync("hosted.logged", new Order(1), Token);
        await host.Services.GetRequiredService<Admin>().PauseQueueAsync(
            testing.Queue, new AdminAudit { Actor = "dotnet-test", Reason = "host log", RequestId = Guid.NewGuid().ToString("N") }, Token);

        Assert.Equal(1, testing.Log.Count("workhorse.task.enqueued"));
        Assert.Equal(1, testing.Log.Count("workhorse.queue.paused"));
    }

    [Fact]
    public async Task AHostRunsAServiceHandlerAndDrainsItOnStop()
    {
        var testing = new HostingTesting(database.DataSource, UniqueQueue("hosted"));
        var gate = new Gate();
        testing.Services.AddSingleton(gate);
        testing.Services.AddWorkhorseHandler<GatedHandler, Order>();
        testing.Services.AddWorkhorseWorker(_ => { });
        using var host = testing.Build();
        await host.StartAsync(Token);

        var queue = host.Services.GetRequiredService<Queue>();
        var task = await queue.EnqueueAsync("hosted.gated", new Order(21), Token);
        await gate.Started.Task.WaitAsync(Patience, Token);

        // The handler finishes only after the host asked the worker to stop, so the task succeeds
        // only if the stop drains it.
        var lifetime = host.Services.GetRequiredService<IHostApplicationLifetime>();
        using var release = lifetime.ApplicationStopping.Register(() => gate.Release.TrySetResult());
        await host.StopAsync(Token);

        var row = await TaskAsync(database.DataSource, task.TaskId);
        Assert.Equal("succeeded", row.Text("state"));
        Assert.Equal(42, row.Json("result")!.Value.GetProperty("value").GetInt32());
        Assert.Equal(WorkerPhase.Stopped, host.Services.GetRequiredService<WorkerState>().Phase);
        Assert.Equal(0, testing.Log.Count("workhorse.hosting.no_worker"));
        Assert.Equal(0, testing.Log.Count("workhorse.hosting.worker_failed"));
    }

    [Fact]
    public async Task DisposingARunningHostDrainsAsARequestedStop()
    {
        using var exitCode = new ExitCodeGuard();
        Environment.ExitCode = 0;
        var testing = new HostingTesting(database.DataSource, UniqueQueue("dispose"));
        var gate = new Gate();
        testing.Services.AddSingleton(gate);
        testing.Services.AddWorkhorseHandler<GatedHandler, Order>();
        testing.Services.AddWorkhorseWorker(_ => { });
        var host = testing.Build();
        await host.StartAsync(Token);
        var state = host.Services.GetRequiredService<WorkerState>();

        var task = await host.Services.GetRequiredService<Queue>().EnqueueAsync("hosted.gated", new Order(4), Token);
        await gate.Started.Task.WaitAsync(Patience, Token);

        // The host is disposed without StopAsync, while the handler still runs.
        var disposing = ((IAsyncDisposable)host).DisposeAsync().AsTask();
        gate.Release.TrySetResult();
        await disposing.WaitAsync(Patience, Token);

        Assert.Equal("succeeded", (await TaskAsync(database.DataSource, task.TaskId)).Text("state"));
        Assert.Equal(WorkerPhase.Stopped, state.Phase);
        Assert.Equal(0, Environment.ExitCode);
        Assert.Equal(0, testing.Log.Count("workhorse.hosting.worker_ended"));
    }

    /// <summary>
    /// The service seam holds <c>ExecuteAsync</c> after the run ends and before it records the
    /// outcome. The disposal must not return while it is held (SM-1731). A pass does not depend on
    /// host load, because the held service cannot record anything. Without the fix, the disposal
    /// returns at once after the run, well inside the hold.
    /// </summary>
    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task DisposalReturnsOnlyAfterTheServiceRecordsTheOutcome(bool abandon)
    {
        using var exitCode = new ExitCodeGuard();
        Environment.ExitCode = 0;
        // A zero grace cancels the handler at once. The handler ignores its token, so the drain
        // abandons it and the run throws ShutdownIncompleteException.
        var testing = new HostingTesting(
            database.DataSource,
            UniqueQueue("dispose-held"),
            abandon ? new Dictionary<string, string?> { ["Workhorse:Worker:ShutdownGrace"] = "00:00:00" } : null);
        var gate = new Gate();
        testing.Services.AddSingleton(gate);
        testing.Services.AddWorkhorseHandler<GatedHandler, Order>();
        testing.Services.AddWorkhorseWorker(_ => { });
        var host = testing.Build();
        var service = host.Services.GetServices<IHostedService>().OfType<WorkerService>().Single();
        var reached = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var hold = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        service.AfterRun = () =>
        {
            reached.TrySetResult();
            return hold.Task;
        };
        try
        {
            await host.StartAsync(Token);
            var state = host.Services.GetRequiredService<WorkerState>();
            await host.Services.GetRequiredService<Queue>().EnqueueAsync("hosted.gated", new Order(4), Token);
            await gate.Started.Task.WaitAsync(Patience, Token);

            var disposing = ((IAsyncDisposable)host).DisposeAsync().AsTask();
            if (!abandon)
            {
                gate.Release.TrySetResult();
            }

            await reached.Task.WaitAsync(Patience, Token);
            await Task.WhenAny(disposing, Task.Delay(TimeSpan.FromSeconds(1), Token));
            Assert.False(disposing.IsCompleted, "the host disposal returned before the hosted worker recorded its outcome");
            Assert.Equal(WorkerPhase.Running, state.Phase);

            hold.SetResult();
            await disposing.WaitAsync(Patience, Token);
            Assert.Equal(abandon ? WorkerPhase.Abandoned : WorkerPhase.Stopped, state.Phase);
            Assert.Equal(abandon ? 1 : 0, Environment.ExitCode);
            Assert.Equal(abandon ? 1 : 0, testing.Log.Count("workhorse.hosting.worker_failed"));
        }
        finally
        {
            hold.TrySetResult();
            gate.Release.TrySetResult();
        }
    }

    [Fact]
    public async Task EachAttemptDisposesItsOwnScopeOnceIncludingAFailedAttempt()
    {
        var testing = new HostingTesting(database.DataSource, UniqueQueue("scoped"));
        var ledger = new Ledger();
        testing.Services.AddSingleton(ledger);
        testing.Services.AddScoped<AttemptResource>();
        testing.Services.AddWorkhorseHandler<ScopedHandler, Order>();
        testing.Services.Configure<WorkerOptions>(options => options.RetryDelay = (_, _) => TimeSpan.Zero);
        testing.Services.AddWorkhorseWorker(_ => { });
        using var host = testing.Build();
        await host.StartAsync(Token);

        var queue = host.Services.GetRequiredService<Queue>();
        var task = await queue.EnqueueAsync("hosted.scoped", new Order(5), new EnqueueOptions { MaxAttempts = 2 }, Token);
        var row = await TaskInStateAsync(database.DataSource, task.TaskId, "succeeded");
        await host.StopAsync(Token);

        Assert.Equal(2, row.RequiredInteger("current_attempt"));
        var used = ledger.Used.ToArray();
        Assert.Equal(2, used.Length);
        Assert.NotEqual(used[0], used[1]);
        foreach (var id in used)
        {
            Assert.Equal(1, ledger.Disposed.GetValueOrDefault(id));
        }

        // The startup scope that read the task type disposed its resource too, and nothing else ran.
        Assert.Equal(3, ledger.Disposed.Count);
        Assert.All(ledger.Disposed.Values, count => Assert.Equal(1, count));
    }

    [Fact]
    public async Task DelegateHandlersRunWithoutServices()
    {
        var testing = new HostingTesting(database.DataSource, UniqueQueue("delegate"));
        testing.Services.AddWorkhorseWorker(handlers => handlers
            .Handle<Order, Total>("hosted.delegate", (_, order) => Task.FromResult(new Total(order.OrderId + 1))));
        using var host = testing.Build();
        await host.StartAsync(Token);

        var task = await host.Services.GetRequiredService<Queue>().EnqueueAsync("hosted.delegate", new Order(1), Token);
        var row = await TaskInStateAsync(database.DataSource, task.TaskId, "succeeded");
        await host.StopAsync(Token);

        Assert.Equal(2, row.Json("result")!.Value.GetProperty("value").GetInt32());
    }

    [Fact]
    public async Task HandlersWithoutAWorkerLogOneWarning()
    {
        var testing = new HostingTesting(database.DataSource, UniqueQueue("noworker"));
        testing.Services.AddSingleton(new Gate());
        testing.Services.AddWorkhorseHandler<GatedHandler, Order>();
        using var host = testing.Build();
        await host.StartAsync(Token);
        await host.StopAsync(Token);

        Assert.Equal(1, testing.Log.Count("workhorse.hosting.no_worker"));
        Assert.Null(host.Services.GetService<WorkerState>());
    }

    [Fact]
    public async Task AShortHostShutdownTimeoutLogsAWarning()
    {
        var testing = new HostingTesting(database.DataSource, UniqueQueue("timeout"));
        testing.Services.Configure<HostOptions>(options => options.ShutdownTimeout = TimeSpan.FromSeconds(5));
        testing.Services.AddWorkhorseWorker(_ => { });
        using var host = testing.Build();
        await host.StartAsync(Token);
        await host.StopAsync(Token);

        // The grace is 5 s, so 5 s leaves no room for the unwind window.
        Assert.Equal(1, testing.Log.Count("workhorse.hosting.shutdown_timeout"));
    }

    [Fact]
    public async Task TheDefaultHostShutdownTimeoutLogsNoWarning()
    {
        var testing = new HostingTesting(database.DataSource, UniqueQueue("timeout-default"), new Dictionary<string, string?>
        {
            ["Workhorse:Worker:ShutdownGrace"] = "00:00:25",
        });
        testing.Services.AddWorkhorseWorker(_ => { });
        using var host = testing.Build();
        await host.StartAsync(Token);
        await host.StopAsync(Token);

        Assert.Equal(0, testing.Log.Count("workhorse.hosting.shutdown_timeout"));
    }

    [Fact]
    public async Task AFailedRunSetsTheExitCodeStopsTheHostAndRethrows()
    {
        using var exitCode = new ExitCodeGuard();
        Environment.ExitCode = 0;
        // The postgres database has no Workhorse schema, so the worker's startup check refuses it.
        await using var noSchema = database.CreateDataSource(builder => builder.Database = "postgres");
        var testing = new HostingTesting(noSchema, UniqueQueue("fault"));
        testing.Services.AddWorkhorseWorker(_ => { });
        using var host = testing.Build();
        var stopping = host.Services.GetRequiredService<IHostApplicationLifetime>().ApplicationStopping;
        try
        {
            await host.StartAsync(Token);
        }
        catch (CompatibilityException)
        {
            // The run can fail before the host's start returns.
        }

        await EventuallyAsync(() => stopping.IsCancellationRequested, "the failed worker stops the host");
        var state = host.Services.GetRequiredService<WorkerState>();
        Assert.Equal(WorkerPhase.Failed, state.Phase);
        Assert.IsType<CompatibilityException>(state.Failure);
        Assert.Equal(1, Environment.ExitCode);
        Assert.Equal(1, testing.Log.Count("workhorse.hosting.worker_failed"));
        try
        {
            await host.StopAsync(Token);
        }
        catch (CompatibilityException)
        {
            // The .NET 11 host throws the failure of a background service again from its stop.
        }
    }

    /// <summary>
    /// A logger of the application that throws must not change the startup of the host (ADR 0107).
    /// The warnings of the startup check and of the short shutdown timeout come before the run.
    /// </summary>
    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task AThrowingLoggerDoesNotStopTheStartupWarnings(bool atCreate)
    {
        var testing = new HostingTesting(database.DataSource, UniqueQueue("throwing-start"));
        testing.ThrowFromHostingLoggers(atCreate);
        testing.Services.AddSingleton(new Gate());
        testing.Services.AddWorkhorseHandler<GatedHandler, Order>();
        using var host = testing.Build();
        await host.StartAsync(Token);
        await host.StopAsync(Token);

        var timeout = new HostingTesting(database.DataSource, UniqueQueue("throwing-timeout"));
        timeout.ThrowFromHostingLoggers(atCreate);
        timeout.Services.Configure<HostOptions>(options => options.ShutdownTimeout = TimeSpan.FromSeconds(5));
        timeout.Services.AddWorkhorseWorker(_ => { });
        using var timeoutHost = timeout.Build();
        await timeoutHost.StartAsync(Token);
        var state = timeoutHost.Services.GetRequiredService<WorkerState>();
        // The phase is Running before ExecuteAsync starts the run. A stop before that cancels the
        // run before it starts, so the phase never becomes Stopped. The first registration shows
        // that the run is in progress.
        await EventuallyAsync(() => timeout.Log.Count("workhorse.worker.registered") > 0, "the hosted worker registers");
        await timeoutHost.StopAsync(Token);
        // The short shutdown timeout can end StopAsync before the worker records its last phase.
        await EventuallyAsync(() => state.Phase == WorkerPhase.Stopped, "the hosted worker stops");
    }

    /// <summary>
    /// A logger that throws must not replace the failure of the run, and it must not stop the exit
    /// code 1.
    /// </summary>
    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task AThrowingLoggerKeepsTheFailureAndTheExitCode(bool atCreate)
    {
        using var exitCode = new ExitCodeGuard();
        Environment.ExitCode = 0;
        await using var noSchema = database.CreateDataSource(builder => builder.Database = "postgres");
        var testing = new HostingTesting(noSchema, UniqueQueue("throwing-fault"));
        testing.ThrowFromHostingLoggers(atCreate);
        testing.Services.AddWorkhorseWorker(_ => { });
        using var host = testing.Build();
        var service = host.Services.GetServices<IHostedService>().OfType<WorkerService>().Single();
        var stopping = host.Services.GetRequiredService<IHostApplicationLifetime>().ApplicationStopping;
        try
        {
            await host.StartAsync(Token);
        }
        catch (CompatibilityException)
        {
            // The run can fail before the host's start returns.
        }

        await EventuallyAsync(() => stopping.IsCancellationRequested, "the failed worker stops the host");
        await EventuallyAsync(() => service.ExecuteTask?.IsCompleted == true, "the hosted worker records its outcome");
        Assert.IsType<CompatibilityException>(service.ExecuteTask!.Exception?.InnerException);
        Assert.Equal(1, Environment.ExitCode);
        try
        {
            await host.StopAsync(Token);
        }
        catch (CompatibilityException)
        {
            // The .NET 11 host throws the failure of a background service again from its stop.
        }
    }

    /// <summary>
    /// A run that ends without a stop request sets the exit code 1, also when the logger throws.
    /// </summary>
    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task AThrowingLoggerKeepsTheExitCodeOfAnEndedRun(bool atCreate)
    {
        using var exitCode = new ExitCodeGuard();
        Environment.ExitCode = 0;
        var testing = new HostingTesting(database.DataSource, UniqueQueue("throwing-ended"));
        testing.ThrowFromHostingLoggers(atCreate);
        testing.Services.AddWorkhorseWorker(_ => { });
        using var host = testing.Build();
        var service = host.Services.GetServices<IHostedService>().OfType<WorkerService>().Single();
        await host.StartAsync(Token);

        // The worker stops without the stopping token of the host. A stop before the run starts has
        // no effect, so the test waits for the first registration.
        await EventuallyAsync(() => testing.Log.Count("workhorse.worker.registered") > 0, "the worker registers");
        host.Services.GetRequiredService<WorkerState>().Worker!.Stop();
        await EventuallyAsync(() => service.ExecuteTask?.IsCompleted == true, "the hosted worker records its outcome");
        Assert.IsType<InvalidOperationException>(service.ExecuteTask!.Exception?.InnerException);
        Assert.Contains("without a stop request", service.ExecuteTask.Exception!.InnerException!.Message, StringComparison.Ordinal);
        Assert.Equal(WorkerPhase.Failed, host.Services.GetRequiredService<WorkerState>().Phase);
        Assert.Equal(1, Environment.ExitCode);
        try
        {
            await host.StopAsync(Token);
        }
        catch (InvalidOperationException)
        {
            // The .NET 11 host throws the failure of a background service again from its stop.
        }
    }

    [Fact]
    public void AWorkerNeedsAddWorkhorseFirst()
    {
        var services = new ServiceCollection();
        var error = Assert.Throws<InvalidOperationException>(() => services.AddWorkhorseWorker(_ => { }));
        Assert.Contains("AddWorkhorse", error.Message, StringComparison.Ordinal);
    }
}
