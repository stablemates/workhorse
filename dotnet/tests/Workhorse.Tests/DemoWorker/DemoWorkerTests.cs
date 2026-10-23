using System.Diagnostics;
using System.Text;
using Npgsql;
using Workhorse.Tests.Testing;
using static Workhorse.DemoWorker.DemoWorkerProgram;
using static Workhorse.Tests.Testing.WorkerHarness;

namespace Workhorse.Tests.DemoWorker;

/// <summary>The .NET worker of the hosted dashboard demo (<c>dotnet/demo/Workhorse.DemoWorker</c>).</summary>
public sealed class DemoWorkerTests(ScratchDatabase database)
{
    private static CancellationToken Token => TestContext.Current.CancellationToken;

    private static Func<string, string?> Environment(params (string Name, string Value)[] values) =>
        name => values.FirstOrDefault(value => value.Name == name).Value;

    /// <summary>
    /// Runs the program as its own process, as the JVM test runs <c>DemoWorkerProgram</c>. The
    /// program must read its environment, serve its three queues, refuse a task for another
    /// language, and drain and deregister on SIGTERM. Only this test runs a worker on the demo
    /// queues, because the scratch database is shared and the queue names are fixed.
    /// </summary>
    [Fact]
    public async Task TheProgramReadsItsEnvironmentRunsATaskAndDrainsOnSigterm()
    {
        if (OperatingSystem.IsWindows())
        {
            Assert.Skip("The test sends SIGTERM");
        }

        var url = PrimaryUrl();
        var start = new ProcessStartInfo(
            System.Environment.GetEnvironmentVariable("DOTNET_HOST_PATH") ?? "dotnet",
            [ProgramPath()])
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
        };
        start.Environment["DATABASE_URL_PRIMARY"] = url;
        start.Environment["WORKHORSE_DEMO_MODE"] = "development";
        start.Environment["WORKHORSE_WORKER_POLL_MS"] = "50";
        var output = new StringBuilder();
        using var program = new Process { StartInfo = start };
        program.OutputDataReceived += (_, line) => { lock (output) { output.AppendLine(line.Data); } };
        program.ErrorDataReceived += (_, line) => { lock (output) { output.AppendLine(line.Data); } };
        var clock = Stopwatch.StartNew();
        Assert.True(program.Start());
        program.BeginOutputReadLine();
        program.BeginErrorReadLine();
        string Describe() { lock (output) { return output.ToString(); } }
        async Task<string> ReportAsync(string failure)
        {
            var elapsed = clock.Elapsed;
            if (program.HasExited)
            {
                // HasExited does not wait for the output callbacks. WaitForExitAsync also waits for
                // the end of both output streams.
                try
                {
                    await program.WaitForExitAsync(Token).WaitAsync(TimeSpan.FromSeconds(5), Token);
                }
                catch (TimeoutException)
                {
                    // Report the output that arrived.
                }
            }

            return $"{failure}\nAt {elapsed.TotalSeconds:F1} s after the start, the program "
                + (program.HasExited ? $"exited with code {program.ExitCode}" : "still runs")
                + $". Its output:\n{Describe()}";
        }

        // Each wait ends at once if the program exits. A failed wait reports the process state and
        // the program output, so a timeout tells a stalled program from a program that exited (SM-1731).
        async Task UntilAsync(Func<Task<bool>> condition, string what)
        {
            try
            {
                await EventuallyAsync(
                    async () => program.HasExited ? throw new InvalidOperationException($"The program exited before {what}") : await condition(),
                    what);
            }
            catch (Exception error) when (error is not OperationCanceledException)
            {
                Assert.Fail(await ReportAsync(error.Message));
            }
        }

        async Task<string?> StateAsync(Guid task) => (await TaskAsync(database.DataSource, task)).Text("state");
        try
        {
            // The demo seed moves the fast-tier queue to the fast tier before it enqueues there.
            await new Admin(database.DataSource).SetQueueTierAsync(
                DotnetFastQueue,
                QueueTier.Fast,
                new AdminAudit { Actor = "demo-worker-test", Reason = "Run the fast tier", RequestId = Guid.NewGuid().ToString() },
                Token);
            var language = await EnqueueAsync(database.DataSource, DotnetQueue, LanguageTaskType, new { language = "dotnet" });
            var fast = await EnqueueAsync(database.DataSource, DotnetFastQueue, LanguageTaskType, new { language = "dotnet" });
            var shared = await EnqueueAsync(database.DataSource, SharedQueue, SharedTaskType, new { source = "schedule" });
            var misrouted = await EnqueueAsync(
                database.DataSource, DotnetQueue, LanguageTaskType, new { language = "ruby" }, new { maxAttempts = 1 });

            await UntilAsync(async () => await StateAsync(language) == "succeeded", $"task {language} reaches succeeded");
            var result = (await TaskAsync(database.DataSource, language)).Json("result")!.Value;
            Assert.Equal("dotnet", result.GetProperty("language").GetString());
            Assert.Equal("dotnet", result.GetProperty("runtime").GetString());
            Assert.Equal(1, result.GetProperty("attempt").GetInt32());
            await UntilAsync(
                async () => await ScalarAsync(database.DataSource, "SELECT state FROM workhorse.fast_task_outcome WHERE task_id = $1", fast) is "succeeded",
                "the fast-tier task succeeds");
            var fastResult = (string)(await ScalarAsync(
                database.DataSource, "SELECT result::text FROM workhorse.fast_task_outcome WHERE task_id = $1", fast))!;
            Assert.Contains("\"runtime\": \"dotnet\"", fastResult, StringComparison.Ordinal);
            await UntilAsync(async () => await StateAsync(shared) == "succeeded", $"task {shared} reaches succeeded");
            var sharedResult = (await TaskAsync(database.DataSource, shared)).Json("result")!.Value;
            Assert.Equal("schedule", sharedResult.GetProperty("source").GetString());
            await UntilAsync(async () => await StateAsync(misrouted) == "failed", $"task {misrouted} reaches failed");
            await UntilAsync(async () => await RegisteredAsync(program.Id) == 1, "the program registers its worker");

            using (var signal = Process.Start("kill", ["-TERM", program.Id.ToString(System.Globalization.CultureInfo.InvariantCulture)]))
            {
                await signal.WaitForExitAsync(Token);
            }

            // The drain must end inside the 30 s force-kill window of the other demo workers.
            try
            {
                await program.WaitForExitAsync(Token).WaitAsync(TimeSpan.FromSeconds(30), Token);
            }
            catch (TimeoutException)
            {
                Assert.Fail(await ReportAsync("The program did not exit within 30 s of SIGTERM"));
            }

            if (program.ExitCode != 0)
            {
                Assert.Fail(await ReportAsync("The program exited with a failure code after SIGTERM"));
            }

            Assert.Equal(0, await RegisteredAsync(program.Id));
        }
        finally
        {
            if (!program.HasExited)
            {
                program.Kill();
            }
        }
    }

    [Fact]
    public async Task TheSchemaWaitEndsWhenTheSchemaIsCompatible()
    {
        await WaitForSchemaAsync(database.DataSource, TimeSpan.FromMilliseconds(10), Token).WaitAsync(Patience, Token);
    }

    /// <summary>
    /// The program in its own build output. The copy in the test output cannot run, because its
    /// <c>deps.json</c> names package files that only the program's own output holds. The program
    /// builds with the configuration and the framework of this test assembly.
    /// </summary>
    private static string ProgramPath()
    {
        var output = new DirectoryInfo(AppContext.BaseDirectory.TrimEnd(Path.DirectorySeparatorChar));
        return Repository.Path(Path.Combine(
            "dotnet", "demo", "Workhorse.DemoWorker", "bin", output.Parent!.Name, output.Name, "Workhorse.DemoWorker.dll"));
    }

    /// <summary>The scratch database as the <c>postgres://</c> URL that the demo environment gives.</summary>
    private string PrimaryUrl()
    {
        NpgsqlConnectionStringBuilder? builder = null;
        using (database.CreateDataSource(value => builder = new NpgsqlConnectionStringBuilder(value.ConnectionString)))
        {
        }

        return Url(builder!);
    }

    /// <summary>A <c>postgres://</c> URL for <paramref name="builder"/>. An IPv6 host gets brackets.</summary>
    private static string Url(NpgsqlConnectionStringBuilder builder)
    {
        var user = Uri.EscapeDataString(builder.Username ?? "");
        var password = Uri.EscapeDataString(builder.Password ?? "");
        var host = builder.Host!.Contains(':', StringComparison.Ordinal) ? $"[{builder.Host}]" : builder.Host;
        return $"postgres://{user}:{password}@{host}:{builder.Port}/{Uri.EscapeDataString(builder.Database!)}";
    }

    /// <summary>The registry rows of the program process. The worker ID holds the process ID.</summary>
    private async Task<long> RegisteredAsync(int processId) =>
        (long)(await ScalarAsync(
            database.DataSource,
            "SELECT count(*) FROM workhorse.worker_registry WHERE worker_id LIKE $1",
            $"demo-dotnet-%-{processId}-%"))!;

    [Fact]
    public void TheWorkerSettingsNameTheDemoQueuesAndNamespaces()
    {
        var settings = WorkerSettings(null, "demo-dotnet-test");
        Assert.Equal(["demo-dotnet", "demo-shared", "demo-dotnet-fast"], [settings["Workhorse:Worker:Queues:0"], settings["Workhorse:Worker:Queues:1"], settings["Workhorse:Worker:Queues:2"]]);
        Assert.Equal("workhorse-demo", settings["Workhorse:Worker:ScheduleNamespaces:0"]);
        Assert.Equal("workhorse-demo-fast-tier", settings["Workhorse:Worker:ScheduleNamespaces:1"]);
        Assert.Equal("3", settings["Workhorse:Worker:Concurrency"]);
        Assert.Equal("00:00:25", settings["Workhorse:Worker:ShutdownGrace"]);
        Assert.False(settings.ContainsKey("Workhorse:Worker:PollInterval"));
        Assert.Equal("00:00:00.0150000", WorkerSettings(TimeSpan.FromMilliseconds(15), "id")["Workhorse:Worker:PollInterval"]);
    }

    [Fact]
    public void TheEnvironmentIsReadAsTheOtherDemoWorkersReadIt()
    {
        Assert.Equal(TimeSpan.FromSeconds(15), PollInterval(Environment()));
        Assert.Null(PollInterval(Environment(("WORKHORSE_WORKER_POLL_MS", "0"))));
        Assert.Equal(TimeSpan.FromMilliseconds(15), PollInterval(Environment(("WORKHORSE_WORKER_POLL_MS", "15"))));
        Assert.Throws<ArgumentException>(() => PollInterval(Environment(("WORKHORSE_WORKER_POLL_MS", "-1"))));
        Assert.False(WaitsForSchema(Environment()));
        Assert.False(WaitsForSchema(Environment(("WORKHORSE_DEMO_MODE", "production"))));
        Assert.True(WaitsForSchema(Environment(("WORKHORSE_DEMO_MODE", "development"))));
        Assert.Throws<ArgumentException>(() => WaitsForSchema(Environment(("WORKHORSE_DEMO_MODE", "staging"))));
        Assert.Throws<ArgumentException>(() => DatabaseUrl(Environment()));
        Assert.Matches("^demo-dotnet-[A-Za-z0-9._-]+-[0-9]+-[0-9a-f]{8}$", WorkerId());
    }

    [Fact]
    public void ThePrimaryUrlBecomesAConnectionString()
    {
        var builder = new NpgsqlConnectionStringBuilder(
            ConnectionString("postgres://work%40horse:p%3Ass@db.internal:6543/demo%20primary?sslmode=disable&application_name=demo"));
        Assert.Equal("db.internal", builder.Host);
        Assert.Equal(6543, builder.Port);
        Assert.Equal("work@horse", builder.Username);
        Assert.Equal("p:ss", builder.Password);
        Assert.Equal("demo primary", builder.Database);
        Assert.Equal(SslMode.Disable, builder.SslMode);
        Assert.Equal("demo", builder.ApplicationName);
        Assert.Equal(7, builder.MaxPoolSize);
        Assert.Equal(
            GssEncryptionMode.Disable,
            new NpgsqlConnectionStringBuilder(ConnectionString("postgres://h/d?gssencmode=disable")).GssEncryptionMode);

        var socket = new NpgsqlConnectionStringBuilder(ConnectionString("postgresql://demo@/demo?host=/run/demo-postgres"));
        Assert.Equal("/run/demo-postgres", socket.Host);
        Assert.Equal(5432, socket.Port);
        Assert.Equal("/tmp/pg+sock", new NpgsqlConnectionStringBuilder(ConnectionString("postgres:///d?host=/tmp/pg+sock")).Host);
        Assert.Equal(SslMode.VerifyFull, new NpgsqlConnectionStringBuilder(ConnectionString("postgres://h/d?sslmode=verify-full")).SslMode);

        var loopback = new NpgsqlConnectionStringBuilder { Host = "::1", Port = 5432, Username = "u", Password = "p@ss", Database = "d" };
        var roundTrip = new NpgsqlConnectionStringBuilder(ConnectionString(Url(loopback)));
        Assert.Equal(("::1", "p@ss"), (roundTrip.Host, roundTrip.Password));

        Assert.Throws<ArgumentException>(() => ConnectionString("postgres://demo@/demo"));
        Assert.Throws<ArgumentException>(() => ConnectionString("mysql://h/d"));
        Assert.Throws<ArgumentException>(() => ConnectionString("postgres://h/d?target_session_attrs=any"));
    }
}
