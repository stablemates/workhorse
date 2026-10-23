using System.Text.Json;
using Workhorse.Internal.Runtime;

namespace Workhorse;

/// <summary>
/// What a handler receives with its payload: the claimed task, its cancellation token, the cause of
/// a cancellation, and the durable methods (ADR 0107, "Durable context"). The counterpart of Ruby's
/// <c>HandlerContext</c>.
/// </summary>
/// <remarks>
/// <para>
/// Every durable write carries the fence token of the attempt, so a write from an attempt that lost
/// its lease throws <see cref="LeaseLostException"/>. A durable write after the worker cancelled
/// <see cref="CancellationToken"/> throws <see cref="CancelledException"/>. Concurrent calls that
/// share one name share one request.
/// </para>
/// <para>
/// A durable method takes no <see cref="System.Threading.CancellationToken"/>. Its statement runs to
/// its end also when the worker cancels the handler, so a cancellation cannot cut a durable write in
/// the middle. Only the operation of a checkpoint receives the token of the handler.
/// </para>
/// <para>
/// A durable wait that is not done, and a child join whose children have not finished, suspend the
/// handler. PostgreSQL releases the task, and the worker starts the handler again from its entry
/// when the task resumes. The call sets <see cref="CancelReason"/> to
/// <see cref="Workhorse.CancelReason.Suspended"/>, cancels the token, and throws an
/// <see cref="OperationCanceledException"/>, so <c>finally</c> blocks and <c>using</c> declarations
/// run. A handler that catches that exception and returns still suspends, and the worker ignores its
/// result.
/// </para>
/// <para>
/// A task on a fast-tier queue has no durable execution state (ADR 0077). Each durable call that
/// would write it throws <see cref="FastTierUnsupportedException"/> before any write.
/// </para>
/// <para>Only the SDK derives from this class, so it can gain members without a breaking change.</para>
/// </remarks>
public abstract class HandlerContext
{
    private readonly TaskCancellation _cancellation;

    private protected HandlerContext(ClaimedTask task, TaskCancellation cancellation)
    {
        Task = task;
        _cancellation = cancellation;
    }

    /// <summary>The task that the handler runs.</summary>
    public ClaimedTask Task { get; }

    /// <summary>
    /// The token that the worker cancels when the attempt must stop. The worker sets
    /// <see cref="CancelReason"/> before it cancels the token.
    /// </summary>
    public CancellationToken CancellationToken => _cancellation.Token;

    /// <summary>Why the worker cancelled <see cref="CancellationToken"/>, or <c>null</c> before that.</summary>
    public CancelReason? CancelReason => _cancellation.Reason;

    /// <summary>The task group operations of this activation.</summary>
    public abstract TaskGroupContext TaskGroup { get; }

    internal TaskCancellation Cancellation => _cancellation;

    /// <summary>The checkpoint <paramref name="name"/> that this task saved, or <c>null</c>.</summary>
    public Task<TaskCheckpoint?> GetCheckpointAsync(string name) => GetCheckpointCoreAsync(name);

    /// <summary>
    /// Returns the value that the checkpoint <paramref name="name"/> saved. The call runs
    /// <paramref name="operation"/> to produce and save the value only when no such checkpoint
    /// exists. The value can be <c>null</c>, and a checkpoint stores and replays it.
    /// </summary>
    /// <remarks>
    /// The operation receives <see cref="CancellationToken"/>. An exception from the operation
    /// passes through unchanged, and the checkpoint saves nothing.
    /// </remarks>
    /// <param name="name">The checkpoint name, of 1 to 200 characters.</param>
    /// <param name="operation">Produces the value.</param>
    public Task<T> CheckpointAsync<T>(string name, Func<CancellationToken, Task<T>> operation) =>
        CheckpointCoreAsync(name, null, operation);

    /// <summary>
    /// Like <see cref="CheckpointAsync{T}(string, Func{CancellationToken, Task{T}})"/>, with an input.
    /// The checkpoint also stores the fingerprint of the input, as
    /// <see cref="Checkpoints.InputFingerprint{T}(T, JsonSerializerOptions?)"/> computes it with the
    /// JSON options of the worker. If the stored checkpoint, or an overlapping call with the same
    /// name, has the fingerprint of a different input, the call throws
    /// <see cref="CheckpointInputConflictException"/>, and the operation does not run. If either side
    /// has no input, the call compares nothing.
    /// </summary>
    public Task<T> CheckpointAsync<T>(string name, CheckpointOptions options, Func<CancellationToken, Task<T>> operation)
    {
        ArgumentNullException.ThrowIfNull(options);
        return CheckpointCoreAsync(name, options, operation);
    }

    /// <summary>
    /// Suspends the attempt for <paramref name="duration"/> under the durable timer
    /// <paramref name="name"/>. Returns at once when the timer elapsed in an earlier attempt.
    /// Relative sleeps under one name share the first write, whatever their durations.
    /// </summary>
    /// <param name="name">The timer name, of 1 to 200 characters.</param>
    /// <param name="duration">From 1 millisecond to 365 days.</param>
    public Task SleepAsync(string name, TimeSpan duration) => SleepCoreAsync(name, duration, null);

    /// <summary>
    /// Suspends the attempt until <paramref name="time"/> under the durable timer
    /// <paramref name="name"/>. Returns at once when that time passed in an earlier attempt.
    /// </summary>
    /// <param name="name">The timer name, of 1 to 200 characters.</param>
    /// <param name="time">At most 365 days in the future.</param>
    /// <remarks>
    /// C# converts a <see cref="DateTime"/> to a <see cref="DateTimeOffset"/> implicitly. If the
    /// <see cref="DateTime.Kind"/> is <see cref="DateTimeKind.Local"/> or
    /// <see cref="DateTimeKind.Unspecified"/>, the conversion uses the offset of the host. Pass a
    /// <see cref="DateTimeOffset"/>, or a <see cref="DateTime"/> of kind
    /// <see cref="DateTimeKind.Utc"/>.
    /// </remarks>
    public Task SleepUntilAsync(string name, DateTimeOffset time) => SleepCoreAsync(name, null, time);

    /// <summary>
    /// Returns the payload of the signal <paramref name="name"/>. The call suspends the attempt
    /// until a signal arrives.
    /// </summary>
    /// <param name="name">The signal name, of 1 to 200 characters without surrounding whitespace.</param>
    /// <param name="timeout">From 1 millisecond to 7 days, or <c>null</c> for the default of 7 days. A task
    /// deadline that comes first ends the wait at that deadline.</param>
    /// <exception cref="AlreadyWaitingException">The task waits for another external event.</exception>
    public Task<T> WaitForSignalAsync<T>(string name, TimeSpan? timeout) => WaitForSignalCoreAsync<T>(name, timeout);

    /// <summary>
    /// Returns the decision that a person recorded for the wait <paramref name="name"/>. The call
    /// suspends the attempt until a decision arrives.
    /// </summary>
    /// <param name="name">The wait name, of 1 to 200 characters without surrounding whitespace.</param>
    /// <param name="context">The JSON value that the person sees, of at most 65,536 bytes of JSON.</param>
    /// <param name="timeout">From 1 millisecond to 7 days, or <c>null</c> for the default of 7 days. A task
    /// deadline that comes first ends the wait at that deadline.</param>
    /// <exception cref="AlreadyWaitingException">The task waits for another external event.</exception>
    public Task<T> WaitForHumanAsync<TContext, T>(string name, TContext context, TimeSpan? timeout) =>
        WaitForHumanCoreAsync<TContext, T>(name, context, timeout);

    /// <summary>
    /// Returns the result of the child task <paramref name="name"/>. The call creates the child and
    /// suspends the attempt until the child succeeds. A child that fails or is canceled fails the
    /// join.
    /// </summary>
    /// <param name="name">The child name, of 1 to 200 characters.</param>
    /// <param name="taskType">The task type of the child.</param>
    /// <param name="payload">The payload of the child.</param>
    /// <param name="options">The enqueue options, without idempotency, debounce, throttle, or
    /// dependencies. A child with no queue runs on the queue of this task.</param>
    public Task<T> RunChildAsync<TPayload, T>(string name, string taskType, TPayload payload, EnqueueOptions options)
    {
        ArgumentNullException.ThrowIfNull(options);
        return RunChildCoreAsync<TPayload, T>(name, taskType, payload, options);
    }

    /// <summary>
    /// Creates at most 100 children together, and returns the outcome of each one by child name once
    /// all of them settle.
    /// </summary>
    public Task<IReadOnlyDictionary<string, ChildOutcome>> RunChildrenAsync(IReadOnlyList<ChildRequest> children) =>
        RunChildrenCoreAsync(children);

    /// <summary>
    /// Creates at most 100 children together, and returns the result of each one by child name once
    /// all of them succeed.
    /// </summary>
    public Task<IReadOnlyDictionary<string, JsonElement>> RunChildrenAllAsync(IReadOnlyList<ChildRequest> children) =>
        RunChildrenAllCoreAsync(children);

    /// <summary>The progress that this task reported last, or <c>null</c>.</summary>
    public Task<TaskProgress?> GetProgressAsync() => GetProgressCoreAsync();

    /// <summary>
    /// Stores <paramref name="progress"/>, a JSON value, and returns the stored progress. When writes
    /// overlap, <see cref="GetProgressAsync"/> keeps the highest revision that PostgreSQL
    /// acknowledged, whatever order they return in.
    /// </summary>
    /// <exception cref="ProgressRateLimitedException">The task reports progress too often.</exception>
    public Task<TaskProgress> SetProgressAsync<T>(T progress) => SetProgressCoreAsync(progress);

    private protected abstract Task<TaskCheckpoint?> GetCheckpointCoreAsync(string name);

    private protected abstract Task<T> CheckpointCoreAsync<T>(string name, CheckpointOptions? options, Func<CancellationToken, Task<T>> operation);

    private protected abstract Task SleepCoreAsync(string name, TimeSpan? duration, DateTimeOffset? time);

    private protected abstract Task<T> WaitForSignalCoreAsync<T>(string name, TimeSpan? timeout);

    private protected abstract Task<T> WaitForHumanCoreAsync<TContext, T>(string name, TContext context, TimeSpan? timeout);

    private protected abstract Task<T> RunChildCoreAsync<TPayload, T>(string name, string taskType, TPayload payload, EnqueueOptions options);

    private protected abstract Task<IReadOnlyDictionary<string, ChildOutcome>> RunChildrenCoreAsync(IReadOnlyList<ChildRequest> children);

    private protected abstract Task<IReadOnlyDictionary<string, JsonElement>> RunChildrenAllCoreAsync(IReadOnlyList<ChildRequest> children);

    private protected abstract Task<TaskProgress?> GetProgressCoreAsync();

    private protected abstract Task<TaskProgress> SetProgressCoreAsync<T>(T progress);
}
