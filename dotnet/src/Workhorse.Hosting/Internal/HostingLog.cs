using Microsoft.Extensions.Logging;

namespace Workhorse.Hosting.Internal;

/// <summary>The log events of the hosting package.</summary>
internal static partial class HostingLog
{
    [LoggerMessage(EventName = "workhorse.hosting.worker_failed", Level = LogLevel.Error,
        Message = "The hosted Workhorse worker failed; the process exit code is now 1")]
    internal static partial void WorkerFailed(ILogger logger, Exception error);

    [LoggerMessage(EventName = "workhorse.hosting.worker_ended", Level = LogLevel.Error,
        Message = "The hosted Workhorse worker stopped without a stop request; the process exit code is now 1")]
    internal static partial void WorkerEnded(ILogger logger);

    [LoggerMessage(EventName = "workhorse.hosting.shutdown_timeout", Level = LogLevel.Warning,
        Message = "HostOptions.ShutdownTimeout {ShutdownTimeout} is less than the worker's ShutdownGrace {ShutdownGrace} plus the unwind window {UnwindWindow}; the host can stop the worker before it drains")]
    internal static partial void ShutdownTimeoutShort(ILogger logger, TimeSpan shutdownTimeout, TimeSpan shutdownGrace, TimeSpan unwindWindow);

    [LoggerMessage(EventName = "workhorse.hosting.no_worker", Level = LogLevel.Warning,
        Message = "Workhorse handlers are registered, but no worker is; call AddWorkhorseWorker in the process that must run them")]
    internal static partial void HandlersWithoutWorker(ILogger logger);
}
