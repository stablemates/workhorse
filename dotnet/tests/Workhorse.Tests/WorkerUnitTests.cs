using System.Reflection;
using System.Reflection.Emit;
using System.Text.Json;
using Workhorse.Internal;
using Workhorse.Internal.Runtime;
using Workhorse.Tests.Testing;

namespace Workhorse.Tests;

/// <summary>The worker's rules that need no database.</summary>
public sealed class WorkerUnitTests
{
    private sealed class PaymentDeclinedException(string message) : Exception(message);

    private sealed class GenericException<T>(string message) : Exception(message);

    [Fact]
    public void TheEnvelopeNameIsTheTypeNameWithoutArity()
    {
        Assert.Equal("PaymentDeclinedException", FailureEnvelope.Name(new PaymentDeclinedException("x")));
        Assert.Equal("GenericException", FailureEnvelope.Name(new GenericException<int>("x")));
    }

    [Fact]
    public void AWrappedReplayConflictIsFoundAndNamesTheEnvelope()
    {
        var conflict = new ConflictException("checkpoint", "saved");
        var wrapped = new InvalidOperationException("wrapped", new AggregateException(conflict, new TimeoutException()));
        Assert.Same(conflict, FailureEnvelope.ReplayConflict(wrapped));

        using var envelope = JsonDocument.Parse(FailureEnvelope.Write(wrapped, redact: false));
        Assert.Equal("ConflictException", envelope.RootElement.GetProperty("name").GetString());
        Assert.Equal("wrapped", envelope.RootElement.GetProperty("message").GetString());
    }

    [Fact]
    public void TheConflictWalkReadsOnlyTheFirstInnerExceptionAndStopsAtItsBound()
    {
        // An aggregate is read through its first inner exception, as the JVM reads one cause.
        Assert.Null(FailureEnvelope.ReplayConflict(new AggregateException(new TimeoutException(), new ConflictException("sleep", "saved"))));

        Exception deep = new ConflictException("sleep", "saved");
        for (var depth = 1; depth < FailureEnvelope.CauseDepth; depth++)
        {
            deep = new InvalidOperationException("wrapper", deep);
        }

        Assert.NotNull(FailureEnvelope.ReplayConflict(deep));
        Assert.Null(FailureEnvelope.ReplayConflict(new InvalidOperationException("wrapper", deep)));
        Assert.Null(FailureEnvelope.ReplayConflict(new InvalidOperationException("plain", new TimeoutException())));
    }

    [Fact]
    public void ACompilerGeneratedNameRecordsTheCSharpGenericName()
    {
        var generic = Repository.Json("protocol/v1/failures.json").GetProperty("envelope").GetProperty("genericName").GetProperty("csharp").GetString();
        Assert.Equal(FailureEnvelope.GenericName, generic);

        var module = AssemblyBuilder.DefineDynamicAssembly(new AssemblyName("Generated"), AssemblyBuilderAccess.Run).DefineDynamicModule("Generated");
        var type = module.DefineType("<Handler>d__1", TypeAttributes.Public | TypeAttributes.Class, typeof(Exception)).CreateType();
        var error = (Exception)Activator.CreateInstance(type)!;
        Assert.Equal(generic, FailureEnvelope.Name(error));
    }

    [Fact]
    public void EveryNameAvoidsTheForbiddenCharacters()
    {
        var forbidden = Repository.Json("protocol/v1/failures.json").GetProperty("envelope").GetProperty("forbiddenNameCharacters")
            .EnumerateArray().Select(character => character.GetString()!).ToList();
        foreach (var error in new Exception[] { new PaymentDeclinedException("x"), new GenericException<string>("x"), new InvalidOperationException() })
        {
            var name = FailureEnvelope.Name(error);
            Assert.DoesNotContain(forbidden, name.Contains);
        }
    }

    [Fact]
    public void ARedactedEnvelopeHoldsOnlyTheRedactedFields()
    {
        var redacted = Repository.Json("protocol/v1/failures.json").GetProperty("envelope").GetProperty("redacted");
        using var envelope = JsonDocument.Parse(FailureEnvelope.Write(new PaymentDeclinedException("card declined"), redact: true));

        Assert.Equal(redacted.GetProperty("name").GetString(), envelope.RootElement.GetProperty("name").GetString());
        Assert.Equal(redacted.GetProperty("message").GetString(), envelope.RootElement.GetProperty("message").GetString());
        Assert.False(envelope.RootElement.TryGetProperty("stack", out _));
    }

    [Fact]
    public void TheEnvelopeReplacesWhatJsonbCannotStore()
    {
        Assert.Equal("a�b�c😀", FailureEnvelope.Storable("a\0b\uD800c😀"));
        using var envelope = JsonDocument.Parse(FailureEnvelope.Write(new PaymentDeclinedException("nul\0here"), redact: false));
        Assert.Equal("nul�here", envelope.RootElement.GetProperty("message").GetString());
    }

    [Theory]
    [InlineData(10_000, 7_500)]
    [InlineData(1_000, 750)]
    [InlineData(100, 75)]
    [InlineData(60, 50)]
    [InlineData(40, 40)]
    [InlineData(1, 1)]
    public void TheRoundBoundFollowsTheSharedFormula(long intervalMs, long boundMs) =>
        Assert.Equal(Monotonic.Millis(boundMs), Heartbeat.RoundBoundNanos(Monotonic.Millis(intervalMs)));

    [Fact]
    public void ABusyRetryWaitsBetweenOneAndTwoBases()
    {
        for (var round = 0; round < 100; round++)
        {
            Assert.InRange(Heartbeat.BusyRetryDelayNanos(Monotonic.Millis(10_000)), Monotonic.Millis(100), Monotonic.Millis(200));
            Assert.InRange(Heartbeat.BusyRetryDelayNanos(Monotonic.Millis(400)), Monotonic.Millis(50), Monotonic.Millis(100));
        }

        Assert.Equal(Monotonic.Millis(20), Heartbeat.BusyRetryMinNanos);
    }

    // fail_v1 takes an integer, so the override range ends at 2147483647 ms (SM-1668 PAR-06).
    [Theory]
    [InlineData(2_147_483_647L * TimeSpan.TicksPerMillisecond, 2_147_483_647)]
    [InlineData(2_147_483_647L * TimeSpan.TicksPerMillisecond + 4_999, 2_147_483_647)]
    [InlineData(0L, 0)]
    [InlineData(5_000L, 1)]
    [InlineData(14_000L, 1)]
    [InlineData(15_000L, 2)]
    [InlineData(25_000L, 3)]
    public void ARetryDelayRoundsHalfUpToMilliseconds(long ticks, int milliseconds) =>
        Assert.Equal(milliseconds, Worker.RetryDelayMilliseconds(TimeSpan.FromTicks(ticks)));

    [Theory]
    [InlineData(2_147_483_648L * TimeSpan.TicksPerMillisecond)]
    [InlineData(2_147_483_647L * TimeSpan.TicksPerMillisecond + 5_000)]
    [InlineData(-TimeSpan.TicksPerMillisecond)]
    [InlineData(-1L)]
    [InlineData(long.MaxValue)]
    public void ARetryDelayOutsideTheSqlIntegerRangeIsRefused(long ticks) =>
        Assert.Throws<ArgumentOutOfRangeException>(() => Worker.RetryDelayMilliseconds(TimeSpan.FromTicks(ticks)));

    [Fact]
    public void TheOptionDefaultsAreTheAdr0072Values()
    {
        var options = new WorkerOptions();
        Assert.Equal(["default"], options.Queues);
        Assert.Equal(1, options.Concurrency);
        Assert.Equal(TimeSpan.FromSeconds(30), options.Lease);
        Assert.Null(options.Heartbeat);
        Assert.Null(options.PollInterval);
        Assert.Equal(TimeSpan.FromSeconds(1), options.MaintenanceInterval);
        Assert.Equal(TimeSpan.FromSeconds(60), options.MaintenanceRoutineInterval);
        Assert.Equal(TimeSpan.FromSeconds(5), options.RegistryInterval);
        Assert.Equal(100, options.ScheduleCatchupLimit);
        Assert.Equal(TimeSpan.FromSeconds(25), options.ShutdownGrace);
        Assert.Null(options.RetryDelay);
    }

    [Theory]
    [InlineData(1, 1)]
    [InlineData(7, 1)]
    [InlineData(8, 2)]
    [InlineData(17, 3)]
    [InlineData(100, 8)]
    public void TheDefaultCohortsFollowTheSharedRule(int concurrency, int cohorts) =>
        Assert.Equal(cohorts, Worker.DefaultCohorts(concurrency, null));

    [Fact]
    public void TheRegistryReceivesTheCSharpLanguageAndTheTrainVersion()
    {
        Assert.Equal("csharp", Worker.RegistrySdk.Language);
        Assert.Equal(SdkVersion.Current, Worker.RegistrySdk.Version);
        Assert.False(string.IsNullOrEmpty(SdkVersion.Current));
    }

    [Fact]
    public void AnOwnershipWindowThatEndedIsNeverRenewed()
    {
        var ownership = new Ownership(Monotonic.Now() - Monotonic.Millis(2_000), Monotonic.Millis(1_000));

        // The answer of a round arrives after the window ended: it renews nothing and ends the attempt.
        Assert.True(ownership.Renew(Monotonic.Now()));
        Assert.False(ownership.Renew(Monotonic.Now()));
        Assert.Equal(0, ownership.LeaseRemaining(Monotonic.Now()));
        Assert.False(ownership.Lapse());
    }

    [Fact]
    public void TheReasonIsSetBeforeTheTokenIsCancelled()
    {
        var cancellation = new TaskCancellation();
        CancelReason? seen = null;
        using var registration = cancellation.Token.Register(() => seen = cancellation.Reason);

        Assert.True(cancellation.Cancel(CancelReason.LeaseLost));
        Assert.False(cancellation.Cancel(CancelReason.Shutdown));
        Assert.Equal(CancelReason.LeaseLost, cancellation.Reason);
        Assert.True(cancellation.Token.IsCancellationRequested);
        SpinWait.SpinUntil(() => seen is not null, TimeSpan.FromSeconds(10));
        Assert.Equal(CancelReason.LeaseLost, seen);
    }
}
