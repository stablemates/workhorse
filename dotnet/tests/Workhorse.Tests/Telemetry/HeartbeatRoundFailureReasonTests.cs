using System.Net.Sockets;
using Npgsql;
using Workhorse.Internal.Runtime;
using Workhorse.Internal.Telemetry;

namespace Workhorse.Tests.Telemetry;

/// <summary>
/// The <c>workhorse.heartbeat.failure_reason</c> of a failed heartbeat round, with the rule of every
/// SDK (SM-1704).
/// </summary>
public sealed class HeartbeatRoundFailureReasonTests
{
    /// <summary>The failures, whether the round reached its deadline, and the reason.</summary>
    public static TheoryData<string, Exception, bool, string> Failures() => new()
    {
        { "a round lost at its bound", new RoundLostException(), true, "timeout" },
        { "a round that expired before its heartbeat", new RoundExpiredException("deadline"), false, "timeout" },
        { "a round with no connection before its deadline", new RoundDeadlineException("no connection"), false, "timeout" },
        { "a command timeout at the dedicated deadline", new NpgsqlException("Exception while reading from stream", new TimeoutException("timeout")), true, "timeout" },
        { "a timeout at the dedicated deadline", new TimeoutException("late"), true, "timeout" },
        { "statement_timeout", Postgres("57014"), false, "timeout" },
        { "an idle transaction timeout", new DatabaseException("idle", "25P03", Postgres("25P03")), false, "timeout" },
        { "a deadline before an I/O error", new AggregateException(new IOException("reset"), new RoundLostException()), false, "timeout" },
        { "a driver timeout before the dedicated deadline", new TimeoutException("early"), false, "connection" },
        { "a borrowing round's read timeout", new NpgsqlException("Exception while reading from stream", new TimeoutException("timeout")), false, "connection" },
        { "a borrowing round's connect timeout", new DatabaseException("connect", null, new NpgsqlException("Exception while connecting", new TimeoutException("timeout"))), false, "connection" },
        { "a borrowing round's pool wait", new DatabaseException("The connection pool has been exhausted", null, new NpgsqlException("The connection pool has been exhausted", new TimeoutException())), false, "connection" },
        { "a socket error", new SocketException((int)SocketError.ConnectionReset), false, "connection" },
        { "an end of stream", new EndOfStreamException(), false, "connection" },
        { "a wrapped I/O error", new DatabaseException("failed", null, new NpgsqlException("Exception while writing to stream", new IOException("broken pipe"))), false, "connection" },
        { "SQLSTATE class 08", Postgres("08006"), false, "connection" },
        { "a server shutdown", new DatabaseException("terminating connection", "57P01", Postgres("57P01")), false, "connection" },
        { "an aggregate member", new AggregateException(new InvalidOperationException("first"), new SocketException((int)SocketError.ConnectionRefused)), false, "connection" },
        { "another SQLSTATE", new DatabaseException("deadlock detected", "40P01", Postgres("40P01")), false, "database" },
        { "a wrapped SQLSTATE", new InvalidOperationException("failed", Postgres("23505")), true, "database" },
        { "an error without a SQLSTATE", new InvalidOperationException("unexpected"), true, "other" },
        { "a cancel without a SQLSTATE", new OperationCanceledException(), false, "other" },
        { "a driver error without a cause", new NpgsqlException("unexpected"), false, "other" },
    };

    [Theory]
    [MemberData(nameof(Failures))]
    public void ReportsTheReasonOfAFailure(string name, Exception error, bool deadlineReached, string reason)
    {
        Assert.NotEmpty(name);
        Assert.Equal(reason, WorkerTelemetry.HeartbeatRoundFailureReason(error, deadlineReached));
    }

    [Fact]
    public void TheWalkReadsEachExceptionOnceAndStopsAtItsLimit()
    {
        Exception deep = new InvalidOperationException("bottom", new SocketException((int)SocketError.ConnectionReset));
        for (var depth = 0; depth < 20; depth++)
        {
            deep = new InvalidOperationException($"level {depth}", deep);
        }

        // The socket error is deeper than the walk reads.
        Assert.Equal("other", WorkerTelemetry.HeartbeatRoundFailureReason(deep, deadlineReached: false));

        var first = new InvalidOperationException("first");
        var aggregate = new AggregateException(first, first);
        Assert.Equal("other", WorkerTelemetry.HeartbeatRoundFailureReason(aggregate, deadlineReached: false));
    }

    private static PostgresException Postgres(string sqlState) => new("injected", "ERROR", "ERROR", sqlState);
}
