namespace Workhorse;

/// <summary>
/// Chooses the retry delay of one failed attempt, or returns <c>null</c> to keep the task's retry
/// policy. The counterpart of Python's <c>retry_delay</c> (ADR 0072).
/// </summary>
/// <param name="attempt">The attempt that failed, from 1.</param>
/// <param name="task">The claimed task.</param>
public delegate TimeSpan? RetryDelay(int attempt, ClaimedTask task);
