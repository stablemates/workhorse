namespace Workhorse;

/// <summary>
/// A batch handler of one task type, as a class. The counterpart of the block that Ruby's
/// <c>Worker#handle_batch</c> takes and of the JVM's <c>BatchHandler</c>.
/// </summary>
/// <remarks>
/// <para>
/// The worker calls the handler with one <see cref="BatchHandlerItem{TPayload}"/> for each task,
/// highest priority first and then in claim order. The handler returns one
/// <see cref="BatchHandlerOutcome"/> for each item, in the same order. Each task still holds its own
/// lease and settles on its own, so one failed member does not fail the others.
/// </para>
/// <para>
/// If the handler throws, every member of the batch fails with the exception. If it returns
/// <c>null</c>, a list of the wrong length, or a <c>null</c> element, every member fails with a
/// <see cref="WorkhorseException"/> that names the problem.
/// </para>
/// </remarks>
/// <typeparam name="TPayload">The payload type, with its type arguments. A JSON <c>null</c> payload
/// reaches a handler of a nullable type as <c>null</c>.</typeparam>
public interface IBatchHandler<TPayload>
{
    /// <summary>The task type that the handler runs.</summary>
    string TaskType { get; }

    /// <summary>
    /// Runs one batch and returns one outcome for each item, in item order.
    /// </summary>
    /// <param name="items">The members of the batch, each with its payload and its own context.</param>
    /// <param name="cancellationToken">
    /// Cancelled when the worker cancelled the token of every member, for example at the end of the
    /// shutdown grace. Each member's own token is on its context.
    /// </param>
    Task<IReadOnlyList<BatchHandlerOutcome>> HandleAsync(IReadOnlyList<BatchHandlerItem<TPayload>> items, CancellationToken cancellationToken);
}

/// <summary>One member of a batch: its payload and its own context. The counterpart of Ruby's <c>BatchHandlerItem</c>.</summary>
/// <typeparam name="TPayload">The payload type.</typeparam>
public sealed record BatchHandlerItem<TPayload>
{
    internal BatchHandlerItem(TPayload payload, BatchHandlerContext context)
    {
        Payload = payload;
        Context = context;
    }

    /// <summary>The payload, decoded as <typeparamref name="TPayload"/> with its type arguments.</summary>
    public TPayload Payload { get; }

    /// <summary>The member's own context.</summary>
    public BatchHandlerContext Context { get; }
}

/// <summary>
/// The outcome of one batch member: <see cref="BatchSucceeded"/> or <see cref="BatchFailed"/>. A batch
/// handler returns one for each item.
/// </summary>
/// <remarks>
/// Only the SDK derives from this class, so the family is closed. A caller-defined outcome would reach
/// the worker as an outcome that it does not know.
/// </remarks>
public abstract class BatchHandlerOutcome
{
    private protected BatchHandlerOutcome()
    {
    }
}

/// <summary>Completes one batch member with a result.</summary>
public sealed class BatchSucceeded : BatchHandlerOutcome
{
    /// <summary>Completes the member with <paramref name="result"/>, or with the JSON value <c>null</c> for <c>null</c>.</summary>
    public BatchSucceeded(object? result) => Result = result;

    /// <summary>The member's result, or <c>null</c> for the JSON value <c>null</c>.</summary>
    public object? Result { get; }
}

/// <summary>Fails one batch member's attempt. PostgreSQL then retries or fails the task by its retry policy.</summary>
public sealed class BatchFailed : BatchHandlerOutcome
{
    /// <summary>Fails the member with <paramref name="error"/>.</summary>
    /// <exception cref="ArgumentNullException"><paramref name="error"/> is <c>null</c>.</exception>
    public BatchFailed(Exception error)
    {
        ArgumentNullException.ThrowIfNull(error);
        Error = error;
    }

    /// <summary>The member's error.</summary>
    public Exception Error { get; }
}

/// <summary>
/// What a batch handler receives for one member: the claimed task, its cancellation token, and the
/// cause of a cancellation. The counterpart of Ruby's <c>BatchHandlerContext</c>.
/// </summary>
/// <remarks>
/// <para>
/// Each call reads or writes only the durable state of this member, and each write carries the
/// member's own fence token. So a retry replays its checkpoints whatever batch it lands in. Each call
/// goes to the member's own <see cref="HandlerContext"/>, with the same rules.
/// </para>
/// <para>
/// The context has no member that suspends a task or creates a child, because one handler call runs
/// every member (ADR 0030). A member on a fast-tier queue has no durable execution state (ADR 0077),
/// so <see cref="CheckpointAsync{T}(string, Func{CancellationToken, Task{T}})"/> and
/// <see cref="SetProgressAsync{T}(T)"/> throw <see cref="FastTierUnsupportedException"/> before any
/// write. Only the SDK creates the context, so it can gain members without a breaking change.
/// </para>
/// </remarks>
public sealed class BatchHandlerContext
{
    private readonly HandlerContext _context;

    internal BatchHandlerContext(HandlerContext context) => _context = context;

    /// <summary>The member's task.</summary>
    public ClaimedTask Task => _context.Task;

    /// <summary>The member's cancellation token. The worker sets <see cref="CancelReason"/> before it cancels the token.</summary>
    public CancellationToken CancellationToken => _context.CancellationToken;

    /// <summary>Why the worker cancelled <see cref="CancellationToken"/>, or <c>null</c> before that.</summary>
    public CancelReason? CancelReason => _context.CancelReason;

    /// <summary>The task group operations of this member.</summary>
    public TaskGroupContext TaskGroup => _context.TaskGroup;

    /// <summary>The checkpoint <paramref name="name"/> that this member saved, or <c>null</c>.</summary>
    public Task<TaskCheckpoint?> GetCheckpointAsync(string name) => _context.GetCheckpointAsync(name);

    /// <summary>As <see cref="HandlerContext.CheckpointAsync{T}(string, Func{CancellationToken, Task{T}})"/>, for this member.</summary>
    public Task<T> CheckpointAsync<T>(string name, Func<CancellationToken, Task<T>> operation) =>
        _context.CheckpointAsync(name, operation);

    /// <summary>As <see cref="HandlerContext.CheckpointAsync{T}(string, CheckpointOptions, Func{CancellationToken, Task{T}})"/>, for this member.</summary>
    public Task<T> CheckpointAsync<T>(string name, CheckpointOptions options, Func<CancellationToken, Task<T>> operation) =>
        _context.CheckpointAsync(name, options, operation);

    /// <summary>The progress that this member reported last, or <c>null</c>.</summary>
    public Task<TaskProgress?> GetProgressAsync() => _context.GetProgressAsync();

    /// <summary>As <see cref="HandlerContext.SetProgressAsync{T}(T)"/>, for this member.</summary>
    public Task<TaskProgress> SetProgressAsync<T>(T progress) => _context.SetProgressAsync(progress);
}
