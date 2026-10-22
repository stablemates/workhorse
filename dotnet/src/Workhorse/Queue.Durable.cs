using System.Text.Json.Nodes;
using Npgsql;
using Workhorse.Internal;
using Workhorse.Internal.Contracts;
using Workhorse.Internal.Database;
using Workhorse.Internal.Json;

namespace Workhorse;

/// <summary>The requests that the durable context of a worker sends through the queue code.</summary>
public sealed partial class Queue
{
    /// <summary>A queue for the durable context of a worker, with the codec of that worker.</summary>
    internal Queue(NpgsqlDataSource dataSource, JsonCodec codec)
    {
        _dataSource = DataSources.Require(dataSource, nameof(dataSource));
        _shared = new Shared("default", codec);
    }

    /// <summary>
    /// The contract version and the queue that a stored child was created under. A <c>null</c>
    /// version stamps no contract.
    /// </summary>
    internal sealed record ChildVersion(string? Version, string? Queue);

    /// <summary>
    /// Adds <paramref name="requests"/> to the group of <paramref name="task"/>, a running member
    /// task, under its fenced lease. A request with no queue goes to the queue of
    /// <paramref name="task"/>, as in the other SDKs. The counterpart of Ruby's
    /// <c>Queue#add_to_task_group_as_member</c>.
    /// </summary>
    internal async Task<IReadOnlyList<EnqueueResult>> AddToTaskGroupAsMemberAsync(
        ClaimedTask task, string workerId, IReadOnlyList<EnqueueRequest> requests, CancellationToken cancellationToken)
    {
        var pending = Prepare(requests, "task group add");
        ValidateGroupAdd(pending);
        var routed = pending
            .Select(request => string.IsNullOrEmpty(request.Options.Queue) ? request with { Options = request.Options with { Queue = task.Queue } } : request)
            .ToList();
        SerializeRequests(routed);
        var link = await FindTaskGroupAsync(task.Id, cancellationToken).ConfigureAwait(false);
        if (link is not { Role: TaskGroupRole.Member })
        {
            throw new ArgumentException($"Task {task.Id} is not a member of a task group", nameof(requests));
        }

        if (routed.Count == 0)
        {
            return [];
        }

        return await RunAsync(
            async call =>
            {
                var rows = await SubmitAsync(
                    call,
                    routed,
                    document => Sql.RowsAsync(
                        call.Connection,
                        SqlCatalogue.AddTaskGroupMembersV1,
                        [Parameters.Uuid(link.Group.Id), Parameters.Json(document), Parameters.Uuid(task.Id), Parameters.Text(workerId), Parameters.Bigint(task.FenceToken)],
                        cancellationToken),
                    cancellationToken).ConfigureAwait(false);
                return EnqueueResults(rows, routed.Count);
            },
            cancellationToken).ConfigureAwait(false);
    }

    /// <summary>
    /// The <c>create_child_v2</c> request for one child of <paramref name="parent"/>. The
    /// counterpart of Ruby's <c>Queue#serialize_child_request</c>.
    /// </summary>
    /// <remarks>
    /// A child inherits the trace context of <paramref name="parent"/>, and takes no coalescing or
    /// dependency option. A request with no queue runs on the stored queue of the child, or else on
    /// the queue of <paramref name="parent"/>. A contracted child carries the contract that
    /// PostgreSQL holds now, because a child write has no stale-contract retry. A
    /// <paramref name="stored"/> child stamps the version that it was created under instead.
    /// <paramref name="contracts"/> keeps those loads for one child set.
    /// </remarks>
    internal async Task<JsonObject> SerializeChildRequestAsync(
        NpgsqlConnection connection,
        ClaimedTask parent,
        string taskType,
        string payload,
        EnqueueOptions options,
        Dictionary<string, PayloadContract?> contracts,
        ChildVersion? stored,
        CancellationToken cancellationToken)
    {
        var input = ChildInput(parent, taskType, payload, options, stored);
        var key = stored is null ? $"current:{taskType}" : $"stored:{taskType}:{stored.Version}";
        if (!contracts.TryGetValue(key, out var contract))
        {
            if (stored is not null)
            {
                contract = stored.Version is { } version
                    ? await ContractStore.LoadAsync(connection, taskType, version, cancellationToken).ConfigureAwait(false)
                    : null;
            }
            else
            {
                contract = await ContractStore.LoadAsync(connection, taskType, null, cancellationToken).ConfigureAwait(false);
                _shared.Remember(taskType, contract);
            }

            contracts[key] = contract;
        }

        StampContract(input, taskType, contract);
        return input;
    }

    /// <summary>
    /// The child request before the contract stamp. It runs no statement, so the durable context
    /// also calls it to check the options before any statement.
    /// </summary>
    /// <exception cref="ArgumentException">An option is invalid for a child task.</exception>
    internal JsonObject ChildInput(ClaimedTask parent, string taskType, string payload, EnqueueOptions options, ChildVersion? stored)
    {
        if (options.Idempotency is not null || options.Debounce is not null || options.Throttle is not null || options.Dependencies is not null)
        {
            throw new ArgumentException("Child tasks cannot use coalescing or dependency enqueue options");
        }

        var input = TaskInput(taskType, payload, options.Queue, options.Priority ?? 0, options.ConcurrencyKey, options.MaxAttempts, options.RetryPolicy);
        if (string.IsNullOrEmpty(options.Queue))
        {
            input["queue"] = stored?.Queue ?? parent.Queue;
        }

        input["deadline"] = options.Deadline is { } deadline ? Values.Timestamp(deadline) : null;
        input["budget"] = OptionalBytes(options.Budget, MaxNameBytes, "budget");
        var timeout = options.ExecutionTimeout is { } executionTimeout ? Values.Milliseconds(executionTimeout, "execution timeout", 0, MaxDurationMs) : 0;
        input["executionTimeoutMs"] = timeout == 0 ? null : timeout;
        input["prerequisiteTaskId"] = null;
        input["dependencies"] = null;
        input["tags"] = Tags(options.Tags);
        if (parent.TraceContext is { } traceContext)
        {
            input["traceContext"] = JsonNode.Parse(traceContext.GetRawText());
        }

        if (options.RunAt is { } runAt)
        {
            input["runAt"] = Values.Timestamp(runAt);
        }

        return input;
    }
}
