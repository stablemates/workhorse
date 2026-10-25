using System.Diagnostics;

namespace Workhorse.Tests;

/// <summary>
/// SM-1688: the worker waits for an expiry on the monotonic clock. A step of the wall clock does
/// not change the time between two expiry requests.
/// </summary>
public sealed class WorkerExpirationClockTests
{
    [Fact]
    public async Task AWallClockThatStepsBackDoesNotDelayTheRetryAfterNotDue()
    {
        var expirationAt = DateTimeOffset.UtcNow;
        var wallClock = new SteppingWallClock(expirationAt, TimeSpan.FromMinutes(-10));
        var answers = new Queue<string?>(["not_due", "not_due", "deadline_exceeded"]);
        var asks = 0;
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(30));
        var watch = Stopwatch.StartNew();

        await Worker.AskForExpirationAsync(
            expirationAt,
            wallClock,
            () =>
            {
                asks++;
                return Task.FromResult(answers.Dequeue());
            },
            timeout.Token);

        // The retries wait 5 ms and 10 ms. A wait on the wall clock would take 10 minutes for each step.
        Assert.Equal(3, asks);
        Assert.True(watch.Elapsed < TimeSpan.FromSeconds(10), $"the retries took {watch.Elapsed}");
    }

    [Fact]
    public async Task AWallClockThatStepsForwardDoesNotEndTheRetryWaitEarly()
    {
        var expirationAt = DateTimeOffset.UtcNow;
        var wallClock = new SteppingWallClock(expirationAt, TimeSpan.FromMinutes(10));
        var answers = new Queue<string?>(["not_due", "deadline_exceeded"]);
        long? firstAsk = null;
        long? secondAsk = null;

        await Worker.AskForExpirationAsync(
            expirationAt,
            wallClock,
            () =>
            {
                if (firstAsk is null)
                {
                    firstAsk = Stopwatch.GetTimestamp();
                }
                else
                {
                    secondAsk = Stopwatch.GetTimestamp();
                }

                return Task.FromResult(answers.Dequeue());
            },
            CancellationToken.None);

        // The retry waits its full 5 ms on the monotonic clock.
        Assert.NotNull(secondAsk);
        Assert.True(
            Stopwatch.GetElapsedTime(firstAsk!.Value, secondAsk.Value) >= TimeSpan.FromMilliseconds(4),
            $"the retry came after {Stopwatch.GetElapsedTime(firstAsk.Value, secondAsk.Value)}");
    }

    [Fact]
    public async Task TheFirstRequestWaitsForTheExpiry()
    {
        var now = DateTimeOffset.UtcNow;
        var wallClock = new SteppingWallClock(now, TimeSpan.Zero);
        var watch = Stopwatch.StartNew();
        TimeSpan? askedAfter = null;

        await Worker.AskForExpirationAsync(
            now.AddMilliseconds(50),
            wallClock,
            () =>
            {
                askedAfter = watch.Elapsed;
                return Task.FromResult<string?>("deadline_exceeded");
            },
            CancellationToken.None);

        Assert.NotNull(askedAfter);
        Assert.True(askedAfter >= TimeSpan.FromMilliseconds(45), $"the first request came after {askedAfter}");
    }

    [Fact]
    public async Task TheStopOfTheAttemptEndsTheWaitForAFutureExpiry()
    {
        var now = DateTimeOffset.UtcNow;
        var asks = 0;
        using var stopped = new CancellationTokenSource(TimeSpan.FromMilliseconds(50));

        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => Worker.AskForExpirationAsync(
            now.AddDays(3),
            new SteppingWallClock(now, TimeSpan.Zero),
            () =>
            {
                asks++;
                return Task.FromResult<string?>("deadline_exceeded");
            },
            stopped.Token));

        Assert.Equal(0, asks);
    }

    [Fact]
    public async Task AnExpiryFarInThePastIsDueAtOnce()
    {
        // The span from 2026 to 2400 saturates the nanosecond count. The wait must not wrap it to a
        // future due time.
        var expirationAt = new DateTimeOffset(2026, 10, 24, 0, 0, 0, TimeSpan.Zero);
        var wallClock = new SteppingWallClock(new DateTimeOffset(2400, 1, 1, 0, 0, 0, TimeSpan.Zero), TimeSpan.Zero);
        var asks = 0;
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(30));

        await Worker.AskForExpirationAsync(
            expirationAt,
            wallClock,
            () =>
            {
                asks++;
                return Task.FromResult<string?>("deadline_exceeded");
            },
            timeout.Token);

        Assert.Equal(1, asks);
    }

    /// <summary>A wall clock that moves by <c>step</c> on each read after the first one.</summary>
    private sealed class SteppingWallClock(DateTimeOffset start, TimeSpan step) : TimeProvider
    {
        private DateTimeOffset _now = start - step;

        public override DateTimeOffset GetUtcNow() => _now += step;
    }
}
