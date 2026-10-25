using System.Diagnostics;
using Workhorse.Internal;
using Workhorse.Internal.Database;
using Workhorse.Internal.Telemetry;
using Workhorse.Tests.Testing;
using static Workhorse.Tests.Testing.WorkerHarness;

namespace Workhorse.Tests.Telemetry;

/// <summary>
/// The failed-round test runs alone. The counter has no queue attribute, and the meter listener sees
/// the whole process, so a failed round of a parallel test would add a measurement.
/// </summary>
[CollectionDefinition(nameof(HeartbeatRoundFailureTelemetryTests), DisableParallelization = true)]
public sealed class HeartbeatRoundFailureTelemetryRunsAlone;

/// <summary>The telemetry of a heartbeat round that fails before PostgreSQL gives a verdict (SM-1704).</summary>
[Collection(nameof(HeartbeatRoundFailureTelemetryTests))]
public sealed class HeartbeatRoundFailureTelemetryTests(ScratchDatabase database) : TelemetryDatabaseCase(database)
{
    private const string RoundFailure = "workhorse.worker.heartbeat.round_failure";

    /// <summary>The reasons the failed-round test accepts: the injected failure, and a later round that reaches its deadline.</summary>
    private static readonly string[] Reasons = ["connection", "timeout"];

    private readonly ScratchDatabase _database = database;

    /// <summary>
    /// The first heartbeat statement fails with an I/O error before it goes out, as a broken socket
    /// does. The worker counts that round once as a <c>connection</c> failure. The round gives no
    /// ownership verdict, so the ownership counter stays empty. The next rounds renew the lease, and
    /// the task completes. Both the dedicated heartbeat and the shared heartbeats count the round.
    /// <para>
    /// SM-1817: with a 100 ms heartbeat, each round of the dedicated heartbeat has a 75 ms bound and a
    /// server budget of about 18 ms. On a loaded host, a later round can reach that bound and count
    /// once as <c>timeout</c>. That is a second failed round, so the test accepts it. A borrowing round
    /// of the shared heartbeats has no round deadline. The injected failure is an
    /// <see cref="IOException"/> with no timeout in its chain, so it can only count as <c>connection</c>.
    /// </para>
    /// </summary>
    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task AFailedRoundCountsOnceAndTheTaskStillCompletes(bool sharedHeartbeats)
    {
        var heartbeats = 0;
        // Npgsql calls the command filter only while its activity source has a listener. This one
        // samples nothing.
        using var npgsql = new ActivityListener
        {
            ShouldListenTo = source => source.Name == "Npgsql",
            Sample = (ref ActivityCreationOptions<ActivityContext> _) => ActivitySamplingResult.None,
        };
        ActivitySource.AddActivityListener(npgsql);
        var builder = _database.CreateDataSourceBuilder();
        builder.ConfigureTracing(tracing => tracing.ConfigureCommandFilter(command =>
        {
            if (command.CommandText == SqlCatalogue.HeartbeatManyV2.Sql && Interlocked.Increment(ref heartbeats) == 1)
            {
                throw new IOException("injected: the heartbeat socket broke");
            }

            return false;
        }));
        await using var dataSource = builder.Build();

        var taskId = await EnqueueAsync("email.send");
        await using var worker = new Worker(dataSource, Options(QueueName, options =>
        {
            options.PollingOnly = true;
            options.DisableRegistry = true;
            options.Lease = TimeSpan.FromSeconds(5);
            options.Heartbeat = TimeSpan.FromMilliseconds(100);
            options.SharedHeartbeats = sharedHeartbeats;
            options.MaintenanceInterval = TimeSpan.FromHours(1);
        }));
        worker.Handle<object?, object?>("email.send", async (_, _) =>
        {
            // A round after the failed one commits a renewal in PostgreSQL before the handler returns.
            // Only a committed renewal ends this wait (SM-1817).
            await EventuallyAsync(() => RenewedAsync(taskId), "a heartbeat round after the failed one renews the lease");
            return new { done = true };
        });
        Assert.True(await worker.RunOnceAsync(Token));

        Assert.Equal("succeeded", (await TaskAsync(DataSource, taskId)).Text("state"));
        var points = Recorder.Of(RoundFailure);
        var point = Assert.Single(points, point => Reason(point) == "connection");
        Assert.Equal(1, point.Value);
        // A later round that reaches its deadline is a second failed round (SM-1817).
        Assert.All(points, point => Assert.Contains(Reason(point), Reasons));
        Assert.Equal("{round}", Recorder.Instruments[RoundFailure].Unit);
        Assert.Empty(Recorder.Of("workhorse.worker.heartbeat.failure"));
        Recorder.AssertGoverned(Surface);
    }

    /// <summary>
    /// A borrowing round opens its own connection. When the pool is full, Npgsql ends the wait at the
    /// data source's <c>Timeout</c>. That wait is not the round deadline, so the reason is
    /// <c>connection</c>. The test reads the exception that the real pool gives.
    /// </summary>
    [Fact]
    public async Task APoolWaitOfABorrowingRoundIsAConnectionFailure()
    {
        await using var pool = _database.CreateDataSource(connection =>
        {
            connection.MaxPoolSize = 1;
            connection.Timeout = 1;
        });
        await using var held = await pool.OpenConnectionAsync(Token);
        var error = Assert.ThrowsAny<WorkhorseException>(() => DataSources.Open(pool));
        Assert.Contains(ErrorChain(error), entry => entry is TimeoutException);
        Assert.Equal("connection", WorkerTelemetry.HeartbeatRoundFailureReason(error, deadlineReached: false));
    }

    /// <summary>
    /// Whether a heartbeat has renewed the lease of <paramref name="taskId"/> since its claim. The
    /// claim sets <c>heartbeat_at</c> to <c>acquired_at</c>, and only a committed renewal moves it later.
    /// </summary>
    private async Task<bool> RenewedAsync(Guid taskId) =>
        await ScalarAsync(
            DataSource,
            "SELECT heartbeat_at > acquired_at FROM workhorse.task_runtime WHERE task_id = $1",
            taskId) is true;

    /// <summary>The failure reason of <paramref name="point"/>, its only tag.</summary>
    private static string? Reason(TelemetryRecorder.Measurement point)
    {
        var tag = Assert.Single(point.Tags);
        Assert.Equal(Names.HeartbeatFailureReason, tag.Key);
        return (string?)tag.Value;
    }

    private static IEnumerable<Exception> ErrorChain(Exception? error)
    {
        for (; error is not null; error = error.InnerException)
        {
            yield return error;
        }
    }
}
