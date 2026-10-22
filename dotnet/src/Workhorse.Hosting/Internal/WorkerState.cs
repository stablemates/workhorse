namespace Workhorse.Hosting.Internal;

/// <summary>The phase of the hosted worker, which the health check reads.</summary>
internal enum WorkerPhase
{
    /// <summary>The host has not started the worker.</summary>
    New,

    /// <summary>The worker runs.</summary>
    Running,

    /// <summary>The worker drained after a stop request.</summary>
    Stopped,

    /// <summary>The run threw, or ended without a stop request.</summary>
    Failed,

    /// <summary>The shutdown grace elapsed with handlers still running.</summary>
    Abandoned,
}

/// <summary>The state of the hosted worker. The worker service writes it, and the health check reads it.</summary>
internal sealed class WorkerState
{
    private volatile Worker? _worker;
    private volatile Exception? _failure;
    private volatile int _phase;

    internal Worker? Worker => _worker;

    internal WorkerPhase Phase => (WorkerPhase)_phase;

    internal Exception? Failure => _failure;

    internal void Started(Worker worker)
    {
        _worker = worker;
        _phase = (int)WorkerPhase.Running;
    }

    internal void Ended(bool stopRequested) => _phase = (int)(stopRequested ? WorkerPhase.Stopped : WorkerPhase.Failed);

    internal void Faulted(Exception failure)
    {
        _failure = failure;
        _phase = (int)(failure is ShutdownIncompleteException ? WorkerPhase.Abandoned : WorkerPhase.Failed);
    }
}
