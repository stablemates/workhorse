using Npgsql;
using Workhorse.Internal.Database;
using Workhorse.Internal.Runtime;
using static Workhorse.Tests.Testing.WorkerHarness;

namespace Workhorse.Tests;

/// <summary>The heartbeat's round rules, with statements that the test answers instead of PostgreSQL.</summary>
public sealed class HeartbeatTests
{
    [Fact]
    public async Task ALaterBatchDoesNotRenewALeaseWhoseWindowEndedDuringTheRound()
    {
        // Two workers give two batches. The first batch's statement ends the second member's local
        // lease window, as a slow statement would. The second batch must then not go out (SM-1445).
        var sent = new List<string>();
        var first = new Member("worker-a");
        var second = new Member("worker-b");
        using var dataSource = NpgsqlDataSource.Create("Host=127.0.0.1;Port=1");
        // The window ends only in a round that started after both registrations, so that round
        // selected both members and has two batches.
        var armedAfter = long.MaxValue;
        Heartbeat? heartbeat = null;
        heartbeat = new Heartbeat(dataSource, (workerId, leases) =>
        {
            lock (sent)
            {
                if (second.Ended)
                {
                    sent.Add(workerId);
                }
            }

            var member = workerId == first.WorkerId ? first : second;
            if (member == first && heartbeat!.RoundsStarted > Interlocked.Read(ref armedAfter))
            {
                second.EndWindow();
            }

            return [new Row(new Dictionary<string, object?> { ["task_id"] = member.TaskId.ToString(), ["status"] = "accepted" })];
        });
        var leaveFirst = heartbeat.Register(first);
        var leaveSecond = heartbeat.Register(second);
        // A round counts itself after its selection, so the round that counts next can have selected
        // before the second registration. Rounds run one at a time, so every round after that one
        // selected both members.
        Interlocked.Exchange(ref armedAfter, heartbeat.RoundsStarted + 1);
        try
        {
            await EventuallyAsync(() => second.Ended, "a round with both members ends the second window in its first batch");
            // The next round would send the second batch again if the first round had kept it.
            var rounds = heartbeat.RoundsStarted;
            await EventuallyAsync(() => heartbeat.RoundsStarted > rounds + 1, "two more rounds run");
        }
        finally
        {
            leaveFirst();
            leaveSecond();
        }

        lock (sent)
        {
            Assert.DoesNotContain(second.WorkerId, sent);
        }

        // A round before the arming can have renewed the second lease while its window was open.
        Assert.True(second.Ended);
    }

    private sealed class Member(string workerId) : Heartbeat.IMember
    {
        private long _leaseEndsAt = Monotonic.Now() + Monotonic.Millis(60_000);
        private int _renewals;
        private bool _ended;

        public string WorkerId { get; } = workerId;

        public Guid TaskId { get; } = Guid.NewGuid();

        public long FenceToken => 1;

        public int LeaseMs => 60_000;

        public long IntervalNanos => Monotonic.Millis(20);

        public long LeaseEndsAt => Interlocked.Read(ref _leaseEndsAt);

        public int Renewals => Volatile.Read(ref _renewals);

        public bool Ended => Volatile.Read(ref _ended);

        public void EndWindow()
        {
            Interlocked.Exchange(ref _leaseEndsAt, Monotonic.Now() - 1);
            Volatile.Write(ref _ended, true);
        }

        public void Renew(long sentAt) => Interlocked.Increment(ref _renewals);

        public void Settle(string status)
        {
        }

        public void Fail(Exception error)
        {
        }
    }
}
