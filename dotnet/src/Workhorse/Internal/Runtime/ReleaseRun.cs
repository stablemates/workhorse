namespace Workhorse.Internal.Runtime;

/// <summary>What the run loop does after a claim that ran no handler.</summary>
internal enum ReleaseRunStep
{
    /// <summary>The run continues: the loop claims again at once.</summary>
    ClaimAgain,

    /// <summary>The loop starts a release wait, which a notification does not end.</summary>
    ReleaseWait,

    /// <summary>The loop starts an empty wait, which a notification newer than the claim ends.</summary>
    EmptyWait,
}

/// <summary>
/// The release run of the continuous loop: the claims in a row that released every task they
/// claimed, and the ids of those tasks (ADR 0126). A release gives the task a new place behind the
/// other ready tasks of its priority, so each claim of the run reaches the next task. A claim that
/// ran a handler, an empty claim, or a release wait ends the run. The worker calls it under its
/// state lock.
/// </summary>
internal sealed class ReleaseRun
{
    /// <summary>The claims of a run before the loop starts a release wait.</summary>
    internal const int Limit = 10;

    private readonly HashSet<Guid> _tasks = [];

    /// <summary>The claims of the current run.</summary>
    internal int Claims { get; private set; }

    /// <summary>
    /// Records a claim that ran no handler and returns what the loop does next. <paramref
    /// name="released"/> holds the tasks of the claim, which the worker releases. Only the
    /// continuous loop claims again: a single pass ends at its first such claim.
    /// </summary>
    internal ReleaseRunStep Settle(IReadOnlyCollection<Guid> released, bool continuous)
    {
        // An empty claim inside a run can find only the tasks whose release is still in flight. It
        // starts the release wait too, so the notification of that release does not end the wait.
        var releasing = released.Count > 0 || Claims > 0;
        if (released.Count > 0 && continuous)
        {
            // A task that comes back, or a long run, starts the release wait: claiming again then
            // would spin on a task no handler here can run.
            var repeated = false;
            foreach (var id in released)
            {
                repeated |= !_tasks.Add(id);
            }

            Claims++;
            if (!repeated && Claims < Limit)
            {
                return ReleaseRunStep.ClaimAgain;
            }
        }

        End();
        return releasing ? ReleaseRunStep.ReleaseWait : ReleaseRunStep.EmptyWait;
    }

    /// <summary>Ends the run, after a claim that ran a handler.</summary>
    internal void End()
    {
        Claims = 0;
        _tasks.Clear();
    }
}
