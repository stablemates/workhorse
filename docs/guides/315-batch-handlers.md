# How do I process several tasks together?

<!-- scenario-names: email, email.send -->

Some downstream systems accept many items in one call, for example a bulk email API or an insert of
many rows. A batch handler is a handler that gets several tasks of one type in one call. Thus, one
downstream call can serve several tasks.

Each task in the call keeps its own lease, fence token, retry budget, checkpoints, progress, and
cancellation. Register a batch handler with `Worker.handleBatch` in TypeScript, `Worker.handle_batch`
in Python, `Worker.HandleBatch` in Go, `Worker::handle_batch` in Rust, or `Worker#handle_batch` in
Ruby.

## Send several tasks to one handler call

**Example.** Your app sends a welcome email to each of 27 new users. The email provider accepts up
to 20 emails in one request. A worker serves the queue `email` with 32 slots. It registers a batch
handler for `email.send`, with a group size of 20 and a linger of 50 ms.

1. At 0 ms, the app enqueues 27 `email.send` tasks. Each task has one address.
2. The worker claims the 27 tasks. Each task gets its own lease and fence token, and fills one
   slot.
3. The first 20 tasks make a full group. The worker calls the handler at once with 20 items. The
   handler sends them to the provider in one request.
4. The other seven tasks make a partial group. The worker starts the linger when the first of them
   arrives.
5. At about 50 ms, the linger ends. The worker calls the handler with the seven tasks. A second
   provider request sends them.

Thus, 27 tasks need two provider requests, not 27.

A group is the set of tasks that the worker gives to one handler call. Each task in a group is a
member. The linger is the maximum time that a partial group waits for more members.

```ts
worker.handleBatch("email.send", { maxSize: 20, lingerMs: 50 }, async (items) => {
  const deliveries = await emailProvider.sendMany(items.map((item) => item.payload));
  return deliveries.map((delivery) =>
    delivery.error
      ? { status: "failed", error: delivery.error }
      : { status: "succeeded", result: { providerId: delivery.id } },
  );
});
```

`maxSize` sets the maximum size of a group. `lingerMs` sets the linger. The linger timer does not
use notifications. Thus, a partial group starts also when no notification arrives. The handler gets
the items in priority order. These options change how the worker makes a group. They do not change
the lifecycle of a task.

Each member fills one worker slot while it waits. Thus, the group size cannot be larger than the
`concurrency` of the worker.

Each SDK names the two options in its own way:

- TypeScript uses `BatchHandlerOptions.maxSize` and `BatchHandlerOptions.lingerMs`.
- Python uses the keyword arguments `max_size` and `linger_ms`.
- Go uses `MaxSize` and `Linger` in `BatchHandlerOptions`.
- Rust uses `max_size` and `linger` in `BatchOptions`.
- Ruby uses the keywords `max_size:` and `linger:`.

<details>
<summary>Reference: options</summary>

| SDK        | Method                                                       | Group size                              | Linger                                            |
| ---------- | ------------------------------------------------------------ | --------------------------------------- | ------------------------------------------------- |
| TypeScript | `Worker.handleBatch(type, options: BatchHandlerOptions, fn)` | `maxSize`: integer, 1 to 100            | `lingerMs`: integer, 0 to 60,000 ms               |
| Python     | `Worker.handle_batch(type, fn, *, max_size, linger_ms)`      | `max_size`: integer, 1 to 100           | `linger_ms`: integer, 0 to 60,000 ms              |
| Go         | `Worker.HandleBatch(taskType, options, fn)`                  | `BatchHandlerOptions.MaxSize`: 1 to 100 | `BatchHandlerOptions.Linger`: 0 to 60 s, whole ms |

Both options are required. The group size cannot exceed the `concurrency` of the worker
(`WorkerOptions.Concurrency` in Go). `AsyncWorker.handle_batch` takes the same limits as
`Worker.handle_batch`.

More detail: [Task lifecycle: Batch handlers](../architecture/lifecycle.md#batch-handlers) and [Schema and SQL protocol: Go batch handlers](../architecture/schema-and-protocol.md#go-batch-handlers).

</details>

## Enqueue ordinary tasks for a batch handler

A producer does not change for a batch handler. The app enqueues one ordinary task for each email.
The producer cannot see that a batch handler runs the task.

```ts
await queue.enqueue("email.send", { to: "person@example.com" });
```

The worker makes each group in its own process. A group never contains tasks from two worker
processes. It contains tasks of one queue and one task type. `Queue.enqueueMany` writes several tasks
in one transaction, but it does not decide which tasks share a group.

<details>
<summary>Reference: grouping</summary>

1. Each claimed task joins the coordinator of its task type in this process.
2. A group holds one queue and one registered task type.
3. A full group dispatches immediately.
4. A partial group dispatches when its first member has waited `lingerMs`.
5. The coordinator orders members by priority, highest first, then by arrival order.

More detail: [Task lifecycle: Batch handlers](../architecture/lifecycle.md#batch-handlers) and [Schema and SQL protocol: Go batch handlers](../architecture/schema-and-protocol.md#go-batch-handlers).

</details>

## Return one outcome for each member

The handler returns one outcome for each member, in the order of the items. Workhorse applies each
outcome to its own task.

**Example.** The first group has 20 members. The provider rejects one address and accepts the
other 19.

1. The handler returns 20 outcomes in the order of the items.
2. Nineteen outcomes are `succeeded`, with the provider's message ID. One outcome is `failed`, with the
   error from the provider.
3. Workhorse completes the 19 successful tasks. Each completion uses the fence token of its own
   task.
4. The failed task follows its own retry policy and attempt budget.

If the handler throws an error or returns a list that is not valid, Workhorse fails all 20
members. Each member still uses its own fence token and retry budget.

Each `BatchHandlerItem` holds the original payload and its own `BatchHandlerContext`. Thus,
checkpoints, progress, cancellation, and fence checks stay with the correct task. Cancellation,
timeouts, lost leases, and shutdown apply to each task separately. One member can be canceled or
lose its lease while the other members complete.

Each SDK gives outcomes and contexts its own shape. In each SDK, each member reports with its own
fence token.

- Python handlers return the same `succeeded` and `failed` statuses as mappings. A Python batch
  context reads and writes progress with `get_progress` and `set_progress`.
- Go handlers return `BatchSucceeded` or `BatchFailed` values in the order of the items. A Go batch
  context gives the standard cancellation context, checkpoints, and the latest progress value through
  `GetProgress` and `SetProgress`.
- Rust callbacks get `BatchItem` values. Each item has a payload and its own `BatchHandlerContext`. The
  callback returns one `BatchResult::Succeeded` or `BatchResult::Failed` for each item, in item
  order.
- Ruby blocks get `BatchHandlerItem` values. Each item has a payload and its own
  `BatchHandlerContext`. The block returns one hash for each item, in item order.

<details>
<summary>Reference: outcomes</summary>

**Outcomes.** The handler returns one outcome per item, in item order. In TypeScript each outcome is
a `BatchHandlerOutcome`.

| SDK        | Success                                         | Failure                                                          |
| ---------- | ----------------------------------------------- | ---------------------------------------------------------------- |
| TypeScript | `{ status: "succeeded", result }`               | `{ status: "failed", error }`                                    |
| Python     | Mapping with `status: "succeeded"` and `result` | Mapping with `status: "failed"` and an `Exception` under `error` |
| Go         | `BatchSucceeded{Result: value}`                 | `BatchFailed{Error: err}`                                        |
| Rust       | `BatchResult::Succeeded`                        | `BatchResult::Failed`                                            |
| Ruby       | `{status: :succeeded, result: value}`           | `{status: :failed, error: exception}`                            |

A failed outcome goes through the persisted retry policy and the remaining attempt budget of that
member.

**Failures of the whole batch.** These reject every member:

- TypeScript: a thrown error, a non-array return, a wrong outcome count, or an invalid outcome.
- Python: a raised exception, a non-sequence return, a wrong outcome count, or an invalid mapping.
- Go: a panic, a wrong outcome count, a nil outcome, or `BatchFailed` with a nil error.

The execution path of each member still submits the failure under its own fence.

More detail: [Task lifecycle: Batch handlers](../architecture/lifecycle.md#batch-handlers) and [Schema and SQL protocol: Go batch handlers](../architecture/schema-and-protocol.md#go-batch-handlers).

</details>

## Use an ordinary handler for a task that must wait

The handler call must return an outcome for each member. Thus, one member cannot stop alone and
continue later. `BatchHandlerContext` does not have the calls that make a task wait:

- [durable timer waits](130-durable-waits.md);
- [signals](135-signals.md), a wait until an outside system sends a payload;
- [human decisions](145-human-decisions.md), a wait until an operator answers;
- [child joins](170-child-tasks.md), a wait until child tasks finish.

If a task must wait, register an ordinary `Handler` for its task type.

<details>
<summary>Reference: the batch context</summary>

TypeScript `BatchHandlerContext` omits `sleep`, `sleepUntil`, `waitForSignal`, `waitForHuman`,
`runChild`, `runChildren`, and `runChildrenAll`. It keeps the task, the abort signal, checkpoint
reads and writes, wait reads, and progress reads and writes.

| SDK    | Context members                                                                        |
| ------ | -------------------------------------------------------------------------------------- |
| Python | `task`, `cancellation`, `get_checkpoint`, `checkpoint`, `get_progress`, `set_progress` |
| Go     | `Task`, the cancellation `Context`, `Checkpoint`, `GetProgress`, `SetProgress`         |

More detail: [Task lifecycle: Batch handlers](../architecture/lifecycle.md#batch-handlers) and [Schema and SQL protocol: Go batch handlers](../architecture/schema-and-protocol.md#go-batch-handlers).

</details>

## Expect policies to admit each member separately

PostgreSQL admits each task against the queue policies before the task joins a group. The group is
not one unit of admission.

**Example.** The queue `email` has a rate limit of three starts each second. Five `email.send` tasks
wait.

1. The worker claims. PostgreSQL admits three tasks. Two tasks wait for rate tokens.
2. The three admitted tasks make a partial group, so the group waits for the linger.
3. The linger ends. The worker calls the handler with three members.

Thus, priority, queue limits, concurrency limits, keyed limits, and rate limits can make a partial
group. Each admitted member keeps its lease and its share of policy capacity while it waits.

<details>
<summary>Reference: admission</summary>

PostgreSQL admits each member inside `claim_many_v1`, before the in-process grouping. Every admitted
member consumes:

- one worker slot;
- one queue or keyed active count;
- one queue rate token and one keyed rate token, when the matching policy applies.

Priority decides admission first. The sort of the coordinator only orders members already admitted.

The fenced transitions release the policy capacity of each member after completion, failure,
cancellation, expiry, or recovery. A stale fence rejects only its own member. `Worker.stop()` drains
admitted members and their heartbeats, and it starts no further claim.

More detail: [Task lifecycle: Batch admission](../architecture/lifecycle.md#batch-admission).

</details>

## Decide if a batch handler is useful

A batch handler saves work only in the downstream call. One bulk request replaces one request for
each task. The worker still claims each member, sends heartbeats for it, and completes it
separately. Thus, the queue does the same work as before.

If the downstream system has no bulk operation, use an ordinary `Handler`. It is simpler, and it has
no linger.

A batch handler also has costs:

- A partial group waits for its linger. Thus, a task can start later when traffic is low.
- If the shared handler call fails, all members of the group fail.
- A member cannot wait, so the batch context has no timers, signals, human waits, or child joins.

## Find a batch in the dashboard

Before each handler call, the worker records the group. Thus, an operator can see which tasks ran
together.

**Example.** The handler for the second group of seven throws an error, because the provider is not
available.

1. Before the call, the worker records the batch. Each of the seven members gets an event that names
   the batch and the other members.
2. The handler throws. The worker records a batch failure for the seven members.
3. Workhorse fails each member with its own fence token.
4. An operator opens one of the tasks. The task drawer shows that the task ran in a batch, and it
   links the six other members.
5. The drawer labels the failure as a failure of the whole batch. It does not guess from the seven
   separate errors.

If the worker cannot record the batch, the handler call still runs. A failure to record this
evidence never becomes a task failure.

<details>
<summary>Reference: batch evidence</summary>

**Dispatch.** The coordinator generates one batch UUID and calls
`record_batch_dispatch_v1(batch_id, task_ids, attempts, fence_tokens, worker_id)` before the
callback.

- The function accepts 1 to 100 unique task IDs with attempt and fence arrays of equal length.
- PostgreSQL checks every member against its `claimed` event, or, on a fast-tier queue that records
  no claims, against its active `fast_task_runtime` lease. Fast-tier batching needs no
  `recordClaims`.
- It appends one `batch_dispatched` event per member. The event records `batch_id`, the ordered
  `members` with `task_id` and `attempt`, `size`, `worker_id`, and the `fence_token` of the member.
- A retry with the same batch ID returns the original member count and appends nothing.

**Shared failure.** When the callback throws or returns an invalid outcome list, the worker calls
`record_batch_failure_v1` before it rejects the members. PostgreSQL appends one `batch_failed` event
per member.

**Dashboard.** `DashboardTaskDetail.batchExecutions` lists every retained `batch_dispatched` event
of the task. The drawer labels a batch-wide failure only when the task has a retained `batch_failed`
event for that batch.

**Logs.** `workhorse.handler.batch_dispatched` logs size, measured linger, full or partial, queue,
type, and worker. `workhorse.handler.batch_evidence_failed` warns when either evidence write fails.

More detail: [Task lifecycle: Batch evidence](../architecture/lifecycle.md#batch-evidence).

</details>

## Next

- [310-workers.md](310-workers.md) — the process that owns batch capacity
- [150-priority.md](150-priority.md) — how PostgreSQL orders members before batching
- [020-leases-and-fences.md](020-leases-and-fences.md) — why each member keeps separate ownership

---

Exact batch-handler limits and lifecycle rules:
[`architecture/lifecycle.md`](../architecture/lifecycle.md#worker-concurrency-and-lifecycle).
