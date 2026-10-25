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

    private readonly ScratchDatabase _database = database;

    /// <summary>
    /// The first heartbeat statement fails with an I/O error before it goes out, as a broken socket
    /// does. The worker counts that round once as a <c>connection</c> failure. The round gives no
    /// ownership verdict, so the ownership counter stays empty. The next rounds renew the lease, and
    /// the task completes. Both the dedicated heartbeat and the shared heartbeats count the round.
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
            // Rounds run one at a time, so a third statement starts only after the second round ended.
            await EventuallyAsync(() => Volatile.Read(ref heartbeats) >= 3, "a heartbeat round runs after the failed one");
            return new { done = true };
        });
        Assert.True(await worker.RunOnceAsync(Token));

        Assert.Equal("succeeded", (await TaskAsync(DataSource, taskId)).Text("state"));
        var point = Assert.Single(Recorder.Of(RoundFailure));
        Assert.Equal(1, point.Value);
        var tag = Assert.Single(point.Tags);
        Assert.Equal(Names.HeartbeatFailureReason, tag.Key);
        Assert.Equal("connection", tag.Value);
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

    private static IEnumerable<Exception> ErrorChain(Exception? error)
    {
        for (; error is not null; error = error.InnerException)
        {
            yield return error;
        }
    }
}
