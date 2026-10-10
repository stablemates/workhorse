# How do I process several tasks together?

<!-- scenario-names: email, email.send -->

Some downstream systems accept several items in one call, such as a bulk email API or a multi-row
insert. A batch handler lets one handler call serve several tasks. Each task keeps its own lease and
durable identity while it waits for that shared call.

Use `Worker.handleBatch` in TypeScript. Go names this method `Worker.HandleBatch`, and Python names
it `Worker.handle_batch`.

## Seven emails, two provider calls

> **Example.** Your app sends a welcome email to each of seven new users. The email provider accepts
> up to five messages in one request. A worker serves the queue `email` with ten slots, and it
> registers a batch handler for `email.send` with a group size of five and a linger of 200 ms.
>
> 1. **At 0 ms the app enqueues seven tasks.** Each task is an ordinary `email.send` task with one
>    address. The producer cannot tell that a batch handler will run them.
> 2. **Shortly after, the worker claims all seven.** It claims through the normal claim path, so
>    each task gets its own lease and fence token and fills one slot.
> 3. **The first five claimed tasks form a full group.** The worker dispatches a full group at once.
>    It sorts the five by priority and calls the handler with five items. The handler sends them in
>    one provider request.
> 4. **The other two tasks form a partial group.** The worker holds them and starts the linger timer
>    when the first of them arrives.
> 5. **At about 200 ms the linger ends.** No more `email.send` tasks have arrived, so the worker
>    dispatches the partial group of two. A second provider request sends them.

Seven tasks produced two provider requests instead of seven.

```ts
await queue.enqueue("email.send", { to: "person@example.com" });
```

```ts
new Worker(queue, { concurrency: workerCapacity }).handleBatch(
  "email.send",
  {
    maxSize: batching.maxSize,
    lingerMs: batching.lingerMs,
  },
  async (items) => {
    const deliveries = await emailProvider.sendMany(items.map((item) => item.payload));
    return deliveries.map((delivery) =>
      delivery.error
        ? { status: "failed", error: delivery.error }
        : {
            status: "succeeded",
            result: { providerId: delivery.id },
          },
    );
  },
);
```

The worker forms each group inside its own process. A group never spans two worker processes, and
it holds tasks of one queue and one task type. `Queue.enqueueMany` writes several tasks in one
transaction, but it does not decide which tasks share a group.

`maxSize` caps the group. `lingerMs` lets a partial group wait briefly for peers. The linger timer
does not depend on notifications, so a partial group dispatches even when no notification arrives.
Items arrive in priority order.

Every member still fills one worker slot while it waits, so the group size cannot exceed the
worker's `concurrency`.

<details>
<summary>Reference: options and grouping</summary>

**Options**

| SDK        | Method                                                       | Group size                              | Linger                                            |
| ---------- | ------------------------------------------------------------ | --------------------------------------- | ------------------------------------------------- |
| TypeScript | `Worker.handleBatch(type, options: BatchHandlerOptions, fn)` | `maxSize`: integer, 1 to 100            | `lingerMs`: integer, 0 to 60,000 ms               |
| Python     | `Worker.handle_batch(type, fn, *, max_size, linger_ms)`      | `max_size`: integer, 1 to 100           | `linger_ms`: integer, 0 to 60,000 ms              |
| Go         | `Worker.HandleBatch(taskType, options, fn)`                  | `BatchHandlerOptions.MaxSize`: 1 to 100 | `BatchHandlerOptions.Linger`: 0 to 60 s, whole ms |

Both options are required. The group size cannot exceed the worker's `concurrency`
(`WorkerOptions.Concurrency` in Go). `AsyncWorker.handle_batch` takes the same limits as
`Worker.handle_batch`.

**Grouping**

1. Each claimed task joins the coordinator of its task type in this process.
2. A group holds one queue and one registered task type.
3. A full group dispatches immediately.
4. A partial group dispatches once its first member has waited `lingerMs`.
5. The coordinator orders members by priority, highest first, then by arrival order.

More detail: [Task lifecycle: Batch handlers](../architecture/lifecycle.md#batch-handlers) and [Schema and SQL protocol: Go batch handlers](../architecture/schema-and-protocol.md#go-batch-handlers).

</details>

## Each member keeps its own outcome

Go back to the first group of five. The provider rejects one address and accepts the other four.

1. **The handler returns five outcomes in item order.** Four say `succeeded` with the provider's
   message ID. One says `failed` with the provider's error.
2. **Each member settles under its own fence.** Workhorse completes the four successful tasks. The
   failed task goes through its own retry policy and attempt budget.
3. **Suppose instead the handler throws.** Then Workhorse submits that failure for all five members.
   Each member still uses its own fence and retry budget.

Each `BatchHandlerItem` carries the original payload and its own `BatchHandlerContext`. Checkpoints,
progress, cancellation, and fencing therefore stay attached to the correct task. Cancellation,
timeouts, lost leases, and shutdown remain per-task decisions. One member can be canceled or lose its
fence while its peers complete normally.

The shared callback owes every member an outcome, so one member cannot suspend and replay on its own.
`BatchHandlerContext` therefore omits the boundaries where a task pauses and resumes later:
[durable timer waits](130-durable-waits.md), [signals](135-signals.md) (a pause until an outside
system delivers a payload), [human decisions](145-human-decisions.md) (a pause until an operator
answers), and [child joins](170-child-tasks.md) (a pause until child tasks finish). Use an ordinary
`Handler` when a task needs those boundaries.

Python handlers return the same statuses as mappings. Python batch contexts read and write progress
through `get_progress` and `set_progress`. Go handlers return `BatchSucceeded` or `BatchFailed`
values. Go batch contexts expose cancellation, checkpoints, and latest-value progress through
`GetProgress` and `SetProgress`. In every SDK, each member reports through its own fence.

<details>
<summary>Reference: outcomes and the batch context</summary>

**Outcomes.** The handler returns one outcome per item, in item order. In TypeScript each outcome is
a `BatchHandlerOutcome`.

| SDK        | Success                                         | Failure                                                          |
| ---------- | ----------------------------------------------- | ---------------------------------------------------------------- |
| TypeScript | `{ status: "succeeded", result }`               | `{ status: "failed", error }`                                    |
| Python     | Mapping with `status: "succeeded"` and `result` | Mapping with `status: "failed"` and an `Exception` under `error` |
| Go         | `BatchSucceeded{Result: value}`                 | `BatchFailed{Error: err}`                                        |

A failed outcome goes through that member's persisted retry policy and remaining attempt budget.

**Failures of the whole batch.** These reject every member:

- TypeScript: a thrown error, a non-array return, a wrong outcome count, or an invalid outcome.
- Python: a raised exception, a non-sequence return, a wrong outcome count, or an invalid mapping.
- Go: a panic, a wrong outcome count, a nil outcome, or `BatchFailed` with a nil error.

Each member's execution path still submits the failure under its own fence.

**Batch context.** TypeScript `BatchHandlerContext` omits `sleep`, `sleepUntil`, `waitForSignal`,
`waitForHuman`, `runChild`, and `runChildren`. It keeps the task, the abort signal, checkpoint reads
and writes, wait reads, and progress reads and writes.

| SDK    | Context members                                                                        |
| ------ | -------------------------------------------------------------------------------------- |
| Python | `task`, `cancellation`, `get_checkpoint`, `checkpoint`, `get_progress`, `set_progress` |
| Go     | `Task`, the cancellation `Context`, `Checkpoint`, `GetProgress`, `SetProgress`         |

More detail: [Task lifecycle: Batch handlers](../architecture/lifecycle.md#batch-handlers).

</details>

## Policies admit each member, not the batch

The queue `email` has a rate limit that admits three starts per second. Five `email.send` tasks
are waiting.

1. **The worker claims.** PostgreSQL admits three tasks and leaves two waiting for rate tokens.
2. **Three members reach the coordinator.** That is a partial group, so it waits for its linger.
3. **The linger ends.** The worker dispatches a group of three.

Workhorse admits each task against the queue's policies before it enters the group. The batch is not
one admission unit. Priority, queue limits, keyed limits, and rate limits can therefore leave a
partial batch waiting for its linger. Each admitted member holds its lease and its share of policy
capacity while it waits.

<details>
<summary>Reference: admission</summary>

PostgreSQL admits each member inside `claim_many_v1`, before the in-process grouping. Every admitted
member consumes:

- one worker slot;
- one queue or keyed active count;
- one queue rate token and one keyed rate token, when the matching policy applies.

Priority decides admission first. The coordinator's sort only orders members already admitted.

The fenced transitions release each member's policy capacity after completion, failure,
cancellation, expiry, or recovery. A stale fence rejects only its own member. `Worker.stop()` drains
admitted members and their heartbeats, and it starts no further claim.

More detail: [Task lifecycle: Batch admission](../architecture/lifecycle.md#batch-admission).

</details>

## When batching pays off

The saving lives in the handler's downstream call: one bulk request replaces one request per task.
The worker still claims, heartbeats, and completes every member separately, so the queue itself does
no less work. If the downstream system has no bulk operation, an ordinary `Handler` is simpler and
avoids the linger wait.

Batching also has costs:

- A partial group waits for its linger, so a task can start later when traffic is light.
- A shared callback failure fails every member.
- A member cannot suspend, because the shared callback owes every member an outcome.

## What the dashboard shows

The handler for the second group of two throws, because the provider is unreachable.

1. **Before the call, Workhorse records the batch.** Each of the two members gets an event that names
   the batch and its peers.
2. **The callback throws.** Workhorse records a batch failure for both members, then fails each one
   under its own fence.
3. **An operator opens one of the tasks.** The task drawer shows that the task ran in a batch and
   links its peer. It labels the failure as batch-wide, instead of guessing from the two individual
   errors.

Workhorse records each shared invocation before the callback starts. If that record cannot be
written, the callback still runs. A failure to record evidence never becomes a task failure.

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
  `members` with `task_id` and `attempt`, `size`, `worker_id`, and the member's `fence_token`.
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
