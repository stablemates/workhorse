using Npgsql;
using Workhorse.Internal;
using Workhorse.Internal.Database;
using Workhorse.Internal.Runtime;

namespace Workhorse;

public sealed partial class Worker
{
    /// <summary>
    /// Registers a batch handler of <paramref name="taskType"/>. Each claimed task waits up to
    /// <see cref="BatchOptions.Linger"/> for other tasks of its queue, and at most
    /// <see cref="BatchOptions.MaxSize"/> run in one call. Once the worker stops, a batch waits only
    /// for tasks that it already claimed. Every task still holds its own lease and settles on its
    /// own. Registering a task type again replaces its handler or batch handler.
    /// </summary>
    /// <typeparam name="TPayload">The payload type, with its type arguments. The worker decodes each
    /// payload as this type, so a batch handler of <c>List&lt;Order&gt;</c> receives orders.</typeparam>
    /// <exception cref="ArgumentOutOfRangeException"><see cref="BatchOptions.MaxSize"/> exceeds <see cref="Concurrency"/>.</exception>
    /// <exception cref="InvalidOperationException">The worker has already run.</exception>
    public void HandleBatch<TPayload>(
        string taskType,
        BatchOptions options,
        Func<IReadOnlyList<BatchHandlerItem<TPayload>>, CancellationToken, Task<IReadOnlyList<BatchHandlerOutcome>>> handler)
    {
        ArgumentNullException.ThrowIfNull(options);
        ArgumentNullException.ThrowIfNull(handler);
        if (options.MaxSize > Concurrency)
        {
            throw new ArgumentOutOfRangeException(nameof(options), "MaxSize must not exceed the worker's concurrency");
        }

        var coordinator = new BatchCoordinator(
            new BatchHost(this),
            taskType,
            options,
            (members, token) => handler([.. members.Select(member => new BatchHandlerItem<TPayload>((TPayload)member.Payload!, member.Context))], token));
        // Each member decodes its own payload, so a payload that does not decode fails only its task.
        Register(taskType, (context, payload) => coordinator.RunAsync(context, () => Decode<TPayload>(payload)), coordinator);
    }

    /// <summary>Registers <paramref name="handler"/> for its <see cref="IBatchHandler{TPayload}.TaskType"/>.</summary>
    /// <exception cref="ArgumentOutOfRangeException"><see cref="BatchOptions.MaxSize"/> exceeds <see cref="Concurrency"/>.</exception>
    /// <exception cref="InvalidOperationException">The worker has already run.</exception>
    public void HandleBatch<TPayload>(IBatchHandler<TPayload> handler, BatchOptions options)
    {
        ArgumentNullException.ThrowIfNull(handler);
        HandleBatch<TPayload>(handler.TaskType, options, handler.HandleAsync);
    }

    /// <summary>Wakes the lingering members of every batch handler, because the worker drains.</summary>
    private void FlushBatches()
    {
        List<BatchCoordinator> coordinators;
        lock (_handlers)
        {
            coordinators = [.. _handlers.Values.Select(registration => registration.Batch).OfType<BatchCoordinator>()];
        }

        foreach (var coordinator in coordinators)
        {
            coordinator.Flush();
        }
    }

    /// <summary>Tells the coordinator of the task's type that the attempt of <paramref name="task"/> ended.</summary>
    private void LeaveBatch(ClaimedTask task)
    {
        BatchCoordinator? coordinator;
        lock (_handlers)
        {
            coordinator = _handlers.TryGetValue(task.Type, out var registration) ? registration.Batch : null;
        }

        coordinator?.Leave(task);
    }

    /// <summary>What a batch coordinator reads from and writes through its worker.</summary>
    private sealed class BatchHost(Worker worker) : BatchCoordinator.IHost
    {
        public bool Draining => worker._draining;

        /// <summary>The stop-path token of the run that admitted a task (ADR 0107, "Cancellation and statements").</summary>
        private CancellationToken StopToken(Guid taskId) =>
            worker._active.Keys.FirstOrDefault(task => task.Task.Id == taskId)?.Run.StopPath.Token ?? CancellationToken.None;

        public long ClaimOrder(ClaimedTask task) => worker._claimOrder.TryGetValue((task.Id, task.FenceToken), out var order) ? order : long.MaxValue;

        public bool ArrivalsComplete(string taskType, string queue, IReadOnlySet<(Guid TaskId, long FenceToken)> entered) =>
            worker._draining && !worker._active.Keys.Any(task =>
                task.Task.Type == taskType && task.Task.Queue == queue && !entered.Contains((task.Task.Id, task.Task.FenceToken)));

        public bool Abandoned(ClaimedTask task) =>
            worker._active.Keys.FirstOrDefault(active => active.Task.Id == task.Id && active.Task.FenceToken == task.FenceToken) is not { Abandoned: false };

        public void BatchDispatched(string taskType, IReadOnlyList<ClaimedTask> tasks, bool full, long lingerMs) =>
            WorkerLog.BatchDispatched(worker._logger, tasks.Count, taskType, tasks[0].Queue, full, lingerMs);

        public async Task RecordEvidenceAsync(bool failure, Guid batchId, string taskType, IReadOnlyList<ClaimedTask> tasks, bool full)
        {
            var statement = failure ? SqlCatalogue.RecordBatchFailureV1 : SqlCatalogue.RecordBatchDispatchV1;
            try
            {
                // The evidence uses the run's stop-path token, never a handler's token (ADR 0107).
                var token = StopToken(tasks[0].Id);
                await using var connection = await DataSources.OpenAsync(worker._dataSource, token).ConfigureAwait(false);
                var rows = await Sql.FencedRowsAsync(
                        connection,
                        statement,
                        () =>
                        [
                            Parameters.Uuid(batchId),
                            Parameters.UuidArray([.. tasks.Select(task => task.Id)]),
                            Parameters.IntegerArray([.. tasks.Select(task => task.Attempt)]),
                            Parameters.BigintArray([.. tasks.Select(task => task.FenceToken)]),
                            Parameters.Text(worker.WorkerId),
                        ],
                        token)
                    .ConfigureAwait(false);
                if (rows.Count != 1 || rows[0].Long("recorded") != tasks.Count)
                {
                    throw new WorkhorseException("PostgreSQL did not record every batch member");
                }
            }
            catch (Exception error) when (error is WorkhorseException or NpgsqlException or TimeoutException or OperationCanceledException)
            {
                // The evidence must not decide the members' outcomes.
                WorkerLog.BatchEvidenceFailed(worker._logger, tasks.Count, taskType, failure ? "failure" : "dispatch", error);
            }
        }
    }
}
