using Npgsql;
using Workhorse.Internal.Database;
using Workhorse.Internal.Runtime;
using Workhorse.Internal.Telemetry;
using Workhorse.Tests.Testing;

namespace Workhorse.Tests.Telemetry;

/// <summary>
/// A dedicated heartbeat round that reaches its deadline before a batch goes out (SM-1704). The
/// test shares the collection of <see cref="HeartbeatRoundFailureTelemetryTests"/>, so it runs
/// alone: the counter has no queue attribute, and the listener sees the whole process.
/// </summary>
[Collection(nameof(HeartbeatRoundFailureTelemetryTests))]
public sealed class HeartbeatRoundDeadlineTelemetryTests
{
    private const string RoundFailure = "workhorse.worker.heartbeat.round_failure";

    private static readonly TimeSpan Patience = TimeSpan.FromSeconds(30);

    /// <summary>
    /// Two workers give two batches. In the measured round, the first batch returns only after the
    /// round's deadline has passed, so the second batch must not go out. The first statement of
    /// the next round proves that the measured round has ended. While that statement is held, the
    /// measured round has added exactly one <c>timeout</c>.
    /// </summary>
    /// <remarks>
    /// A round counts itself after it selects its members, so the round after the registrations can
    /// still hold one member. Each round after it selected both, so the test measures the first round
    /// with a number above that one. Earlier rounds have ended before the measured round starts,
    /// because rounds run one at a time, so their measurements are all before the baseline. The
    /// interval of 1 s gives a round bound of 750 ms, so the next round sends its first batch long
    /// before its own deadline. No sleep length decides the result.
    /// </remarks>
    [Fact]
    public void ARoundThatReachesItsDeadlineBeforeABatchCountsOnceAsATimeout()
    {
        using var recorder = new TelemetryRecorder();
        using var nextRoundStarted = new ManualResetEventSlim();
        using var release = new ManualResetEventSlim();
        var first = new Member("worker-a");
        var second = new Member("worker-b");
        var bound = Heartbeat.RoundBoundNanos(first.IntervalNanos);
        var armedAfter = long.MaxValue;
        var measuredRound = 0L;
        var nextRound = 0L;
        var baseline = -1;
        Heartbeat? heartbeat = null;
        using var dataSource = NpgsqlDataSource.Create("Host=127.0.0.1;Port=1");
        heartbeat = new Heartbeat(
            dataSource,
            (workerId, _) =>
            {
                var round = heartbeat!.RoundsStarted;
                if (round > Interlocked.Read(ref armedAfter))
                {
                    if (Interlocked.CompareExchange(ref measuredRound, round, 0) == 0)
                    {
                        // The first batch of the measured round. The round started before this call,
                        // so its deadline is at most one bound after the call. The batch returns only
                        // after that time, however long the host pauses the thread.
                        Volatile.Write(ref baseline, recorder.Of(RoundFailure).Count);
                        var entered = Monotonic.Now();
                        while (Monotonic.Now() - entered <= bound)
                        {
                            Thread.Sleep(1);
                        }
                    }
                    else if (Interlocked.CompareExchange(ref nextRound, round, 0) == 0)
                    {
                        nextRoundStarted.Set();
                        release.Wait(Patience);
                    }
                }

                var member = workerId == first.WorkerId ? first : second;
                return [new Row(new Dictionary<string, object?> { ["task_id"] = member.TaskId.ToString(), ["status"] = "accepted" })];
            },
            dedicated: true);
        var leaveFirst = heartbeat.Register(first);
        var leaveSecond = heartbeat.Register(second);
        Interlocked.Exchange(ref armedAfter, heartbeat.RoundsStarted + 1);
        IReadOnlyList<TelemetryRecorder.Measurement> points;
        try
        {
            Assert.True(nextRoundStarted.Wait(Patience, TestContext.Current.CancellationToken), "the round after the measured round never sent a statement");
            points = [.. recorder.Of(RoundFailure).Skip(Volatile.Read(ref baseline))];
        }
        finally
        {
            leaveFirst();
            leaveSecond();
            release.Set();
        }

        // The statement that the next round holds is its first, so the measured round sent only
        // its first batch.
        Assert.Equal(Interlocked.Read(ref measuredRound) + 1, Interlocked.Read(ref nextRound));
        var point = Assert.Single(points);
        Assert.Equal(1, point.Value);
        var tag = Assert.Single(point.Tags);
        Assert.Equal(Names.HeartbeatFailureReason, tag.Key);
        Assert.Equal("timeout", tag.Value);
        Assert.Empty(recorder.Of("workhorse.worker.heartbeat.failure"));
    }

    private sealed class Member(string workerId) : Heartbeat.IMember
    {
        public string WorkerId { get; } = workerId;

        public Guid TaskId { get; } = Guid.NewGuid();

        public long FenceToken => 1;

        public int LeaseMs => 60_000;

        public long IntervalNanos => Monotonic.Millis(1_000);

        public long LeaseEndsAt { get; } = Monotonic.Now() + Monotonic.Millis(60_000);

        public void Renew(long sentAt)
        {
        }

        public void Settle(string status)
        {
        }

        public void Fail(Exception error)
        {
        }
    }
}
