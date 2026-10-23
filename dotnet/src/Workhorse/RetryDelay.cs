namespace Workhorse;

/// <summary>
/// Chooses the retry delay of one failed attempt, or returns <c>null</c> to keep the task's retry
/// policy. The counterpart of Python's <c>retry_delay</c> (ADR 0072).
/// </summary>
/// <remarks>
/// A result must be from 0 through 2147483647 ms. The worker rounds it to the nearest millisecond,
/// half up. A negative result, or one that rounds above the limit, makes the failure settlement throw
/// <see cref="ArgumentOutOfRangeException"/> before <c>fail_v1</c>. The worker does not clamp it
/// (ADR 0111).
/// </remarks>
/// <param name="attempt">The attempt that failed, from 1.</param>
/// <param name="task">The claimed task.</param>
public delegate TimeSpan? RetryDelay(int attempt, ClaimedTask task);
