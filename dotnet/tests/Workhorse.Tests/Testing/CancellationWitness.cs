using static Workhorse.Tests.Testing.WorkerHarness;

namespace Workhorse.Tests.Testing;

/// <summary>
/// A handler that waits for its cancellation, and records the reason that a token callback reads
/// and the reason that the handler reads when the cancellation reaches it.
/// </summary>
/// <remarks>
/// The handler does not dispose its registration. The token runs its callbacks in reverse order,
/// so the callback of <see cref="Task.Delay(int, CancellationToken)"/> runs first. Another
/// thread can then resume the handler before the token runs this callback. If that resumption
/// disposed the registration, the callback would never run (SM-1684).
/// </remarks>
internal sealed class CancellationWitness
{
    internal TaskCompletionSource Registered { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);

    private TaskCompletionSource<CancelReason?> Callback { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);

    private TaskCompletionSource<CancelReason?> Handler { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);

    internal async Task WaitForCancellationAsync(HandlerContext context)
    {
        // The reason is set before the token is cancelled, so a callback reads it.
        context.CancellationToken.Register(() => Callback.TrySetResult(context.CancelReason));
        Registered.SetResult();
        try
        {
            await Task.Delay(Timeout.Infinite, context.CancellationToken);
        }
        catch (OperationCanceledException)
        {
            Handler.TrySetResult(context.CancelReason);
            throw;
        }
    }

    /// <summary>Waits until the callback and the handler both read <paramref name="reason"/>.</summary>
    internal async Task AssertReasonAsync(CancelReason reason)
    {
        Assert.Equal(reason, await Callback.Task.WaitAsync(Patience, TestContext.Current.CancellationToken));
        Assert.Equal(reason, await Handler.Task.WaitAsync(Patience, TestContext.Current.CancellationToken));
    }
}
