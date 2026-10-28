using System.Text.Json;
using Microsoft.Extensions.Logging;

namespace Workhorse;

/// <summary>
/// The settings of a <see cref="Worker"/>. The defaults are the ADR 0072 values.
/// </summary>
/// <remarks>
/// The properties are settable, so the configuration binder of <c>Workhorse.Hosting</c> can fill
/// them. The worker copies and validates the options in its constructor, so a later change to this
/// object has no effect on a worker.
/// </remarks>
public sealed class WorkerOptions
{
    /// <summary>The queues that the worker claims from, in claim order. The default is <c>default</c>.</summary>
    public IList<string> Queues { get; set; } = ["default"];

    /// <summary>
    /// The worker's ID in the fleet registry. The default is the host name, the process ID, and a
    /// random suffix.
    /// </summary>
    public string? WorkerId { get; set; }

    /// <summary>The most tasks that the worker runs at once, from 1 to 100. The default is 1.</summary>
    public int Concurrency { get; set; } = 1;

    /// <summary>
    /// The number of slot cohorts for the fast task tier (ADR 0076), from 1 to
    /// <see cref="Concurrency"/>. The default, 0, chooses one cohort below concurrency 8, and one
    /// for each 8 slots from 2 to 8 otherwise. On a pooled data source, the worker then caps that
    /// default at the spare connections of the pool. The spare connections are <c>Max Pool Size</c>,
    /// minus 1 for the listener when the worker listens, minus 1 for the heartbeat connection. The
    /// cap is never below 1. An explicit value is never capped.
    /// </summary>
    public int Cohorts { get; set; }

    /// <summary>The lease that each claim and renewal grants, from 100 ms to 1 day. The default is 30 s.</summary>
    public TimeSpan Lease { get; set; } = TimeSpan.FromSeconds(30);

    /// <summary>The interval between lease renewals. The default is <c>max(100 ms, Lease / 3)</c>.</summary>
    public TimeSpan? Heartbeat { get; set; }

    /// <summary>
    /// The claim poll interval. The default is 5 s while the worker listens for notifications, and
    /// 250 ms with an exponential backoff to 5 s while it polls.
    /// </summary>
    public TimeSpan? PollInterval { get; set; }

    /// <summary>Whether the worker polls only and opens no notification listener.</summary>
    public bool PollingOnly { get; set; }

    /// <summary>The interval between maintenance ticks. The default is 1 s.</summary>
    public TimeSpan MaintenanceInterval { get; set; } = TimeSpan.FromSeconds(1);

    /// <summary>The interval between offers of the maintenance routines. The default is 60 s.</summary>
    public TimeSpan MaintenanceRoutineInterval { get; set; } = TimeSpan.FromSeconds(60);

    /// <summary>The interval between worker registry writes. The default is 5 s.</summary>
    public TimeSpan RegistryInterval { get; set; } = TimeSpan.FromSeconds(5);

    /// <summary>Whether the worker writes no registry row. A worker without a row cannot be paused remotely.</summary>
    public bool DisableRegistry { get; set; }

    /// <summary>The schedule namespaces whose due occurrences this worker fires. The default is none.</summary>
    public IList<string> ScheduleNamespaces { get; set; } = [];

    /// <summary>The most missed occurrences that one schedule fires at once, from 1 to 10,000. The default is 100.</summary>
    public int ScheduleCatchupLimit { get; set; } = 100;

    /// <summary>
    /// How long a stopping worker waits for its running handlers, from 0 to 1 day. The default is
    /// 25 s.
    /// </summary>
    public TimeSpan ShutdownGrace { get; set; } = TimeSpan.FromSeconds(25);

    /// <summary>Chooses the retry delay of a failed attempt. The default is unset.</summary>
    public RetryDelay? RetryDelay { get; set; }

    /// <summary>
    /// The JSON options of payloads and results. The default is <see cref="JsonSerializerDefaults.Web"/>
    /// with strict number handling.
    /// </summary>
    public JsonSerializerOptions? Json { get; set; }

    /// <summary>The logger factory of the worker. The default logs nothing.</summary>
    public ILoggerFactory? LoggerFactory { get; set; }
}
