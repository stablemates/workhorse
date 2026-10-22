namespace Workhorse;

/// <summary>The durable lifecycle state of a task in PostgreSQL.</summary>
public enum TaskState
{
    /// <summary>The task waits for a prerequisite task.</summary>
    Blocked,

    /// <summary>The task waits for its run time.</summary>
    Scheduled,

    /// <summary>The task can be claimed.</summary>
    Ready,

    /// <summary>A worker holds the task.</summary>
    Active,

    /// <summary>The task succeeded.</summary>
    Succeeded,

    /// <summary>The task failed.</summary>
    Failed,

    /// <summary>The task was canceled.</summary>
    Canceled,
}

/// <summary>What a dependent task does when one of its prerequisite tasks ends.</summary>
public enum DependencyPolicy
{
    /// <summary>The dependent task can run.</summary>
    Release,

    /// <summary>The dependent task is canceled.</summary>
    Cancel,

    /// <summary>The dependent task fails.</summary>
    Fail,
}
