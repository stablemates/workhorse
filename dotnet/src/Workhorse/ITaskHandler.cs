namespace Workhorse;

/// <summary>
/// A handler of one task type, as a class. <c>Workhorse.Hosting</c> resolves each handler in a
/// scope of its own for each attempt.
/// </summary>
/// <typeparam name="TPayload">The payload type, with its type arguments. A JSON <c>null</c> payload
/// reaches a handler of a nullable type as <c>null</c>.</typeparam>
public interface ITaskHandler<TPayload>
{
    /// <summary>The task type that the handler runs.</summary>
    string TaskType { get; }

    /// <summary>
    /// Runs one attempt and returns its result, which the worker stores as JSON. An exception fails
    /// the attempt, and PostgreSQL retries or fails the task by its retry policy.
    /// </summary>
    Task<object?> HandleAsync(HandlerContext context, TPayload payload);
}
