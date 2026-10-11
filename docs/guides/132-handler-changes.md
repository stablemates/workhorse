# How do I change a handler while its tasks wait?

<!-- scenario-names: orders, orders-v2, order.ship, reserve, ship, payment-cleared, code-version, carrier-api -->

A task can wait for hours or days on a timer, a signal, or a human decision. During that time, a
deployment can replace the handler code. When the task resumes, the new code replays the checkpoints
that the old code stored. A replay is a later run of the handler for the same task. Workhorse
detects some changes, such as a changed absolute wait time. It does not detect a checkpoint that the
new code adds, removes, moves, or computes in a different way. Thus a task can complete with a wrong
result and no error. This guide gives two patterns that keep each task on the code that started it.

## See how a changed handler gives a wrong result

**Example.** The handler of `order.ship` reserves stock, waits for the payment, and then ships the
order. The new code removes the `reserve` checkpoint, because the warehouse now reserves the stock
in the same call that ships it.

1. At 0 h, the old code reserves one unit of stock in the `reserve` checkpoint.
2. The handler calls `ctx.waitForSignal("payment-cleared")`, and the task waits.
3. At 2 h, a deployment replaces the handler with the new code.
4. At 5 h, the payment clears, and a worker runs the new code from the first line.
5. The `ship` checkpoint has no stored result, so the new operation reserves a second unit.

The task succeeds, but the stock count is wrong by one unit. Workhorse finds each checkpoint by its
name. It does not compare the order or the set of names with the earlier run. Thus a new
checkpoint runs its operation in a task that started on the old code. A removed checkpoint keeps
its stored result, but no code reads it.

```ts
// Old code
await ctx.checkpoint("reserve", () => warehouse.reserve(payload.orderId));
await ctx.waitForSignal("payment-cleared");
await ctx.checkpoint("ship", () => warehouse.ship(payload.orderId));

// New code
await ctx.waitForSignal("payment-cleared");
await ctx.checkpoint("ship", () => warehouse.reserveAndShip(payload.orderId));
```

A changed absolute wait time, child request, or human-decision context is different, because
Workhorse detects it. A changed relative wait duration gives no error, and the first wake time
stays. Read [130-durable-waits.md](130-durable-waits.md) for these replay rules.

<details>
<summary>Reference: what a replay compares</summary>

| Change in the new code                                 | Result on replay                                     |
| ------------------------------------------------------ | ---------------------------------------------------- |
| A checkpoint name that the task has not stored         | The operation runs, and Workhorse stores its value   |
| A stored checkpoint name that the code no longer calls | The stored row stays, and nothing reads it           |
| Stored checkpoint names in a different order           | Each call returns its stored value                   |
| A stored checkpoint name with a new operation          | The stored value returns; the operation does not run |
| A changed relative wait duration                       | The first stored target stays                        |
| A changed absolute wait target                         | `WaitConflictError`                                  |
| A changed child request or child set                   | `ChildConflictError`                                 |
| A changed human-decision context                       | `HumanWaitConflictError`                             |

`HandlerContext.checkpoint(name, operation)` reads an existing value before it runs user code.
The primary key `(task_id, checkpoint_name)` makes each name immutable for the task.

More detail: [Data model: `task_checkpoint`](../architecture/data-model.md#task_checkpoint), [Task lifecycle: Scheduling a timer wait](../architecture/lifecycle.md#scheduling-a-timer-wait), and [Schema and protocol: Durable replay conflicts](../architecture/schema-and-protocol.md#durable-replay-conflicts).

</details>

## Branch on a stored version for a small change

A version branch keeps the old and the new code in one handler. The first checkpoint stores the
version of the code that started the task. Each later run reads that stored version and follows
the same path.

**Example.** The `order.ship` handler stores its version in a `code-version` checkpoint.

1. At 0 h, a worker runs version 1. The `code-version` checkpoint stores `1`.
2. The task reserves stock and waits for `payment-cleared`.
3. At 2 h, a deployment replaces the handler with version 2.
4. At 5 h, a worker runs version 2. The `code-version` checkpoint returns the stored `1`, so the
   handler follows the version 1 path.
5. A new task gets `2` from the same checkpoint and follows the version 2 path.

Thus each task finishes on the path that started it. Make the version checkpoint the first call of
the handler, before any other checkpoint, effect, or wait. Keep the old path until each task that
started on it is terminal. Then remove the old path.

```ts
worker.handle("order.ship", async (payload: { orderId: string }, ctx) => {
  const version = await ctx.checkpoint("code-version", () => 2);
  if (version === 1) {
    await ctx.checkpoint("reserve", () => warehouse.reserve(payload.orderId));
    await ctx.waitForSignal("payment-cleared");
    return ctx.checkpoint("ship", () => warehouse.ship(payload.orderId));
  }
  await ctx.waitForSignal("payment-cleared");
  return ctx.checkpoint("ship", () => warehouse.reserveAndShip(payload.orderId));
});
```

Use a version branch for a change that you can write as a second path in the same handler. For a
large change, the two paths make the handler difficult to read. Then use a queue for each version.

<details>
<summary>Reference: version checkpoint</summary>

- `HandlerContext.checkpoint(name, operation)` returns the stored value when `name` exists. If it
  does not exist, it runs `operation` and stores its JSON result.
- The stored value is immutable. Equal repeated saves return the existing row. A different value
  conflicts.
- A checkpoint name holds 1 to 200 characters.

More detail: [Data model: `task_checkpoint`](../architecture/data-model.md#task_checkpoint).

</details>

## Add a version to a handler that has none

A task that started before you added the version checkpoint has no stored version. On its next
run, the version checkpoint runs its operation and stores the new version. Thus the task follows
the new path, which is the problem that the branch must prevent.

**Example.** Version 1 of `order.ship` has no `code-version` checkpoint.

1. At 0 h, a task stores `reserve` and waits on version 1.
2. At 2 h, a deployment adds `code-version` and the version 2 path.
3. At 5 h, version 2 runs the task. `ctx.getCheckpoint("reserve")` finds the stored row, so the
   operation of `code-version` returns `1`.
4. The handler stores `1` and follows the version 1 path.

Thus a checkpoint that only the old code writes tells you which code started the task. Use
`HandlerContext.getCheckpoint` for this test. It reads a stored checkpoint and runs no code. Read it
before the version checkpoint, so the test runs only one time for each task.

```ts
const startedOnVersion1 = (await ctx.getCheckpoint("reserve")) !== null;
const version = await ctx.checkpoint("code-version", () => (startedOnVersion1 ? 1 : 2));
```

Choose a checkpoint that the old code writes before its first wait. A task that waits always has
that checkpoint. But a task can stop after the operation of that checkpoint runs and before
Workhorse stores its result. That task looks new, so it follows the new path and can repeat the
work. Make the work of the new path safe to repeat, for example with an idempotency key at the
warehouse. To prevent this case in the future, put a version checkpoint in each handler from its
first deployment.

<details>
<summary>Reference: reading a stored checkpoint</summary>

| Call                                         | Result                                                  |
| -------------------------------------------- | ------------------------------------------------------- |
| `HandlerContext.getCheckpoint(name)`         | The stored checkpoint, or `null`. It runs no user code. |
| `HandlerContext.checkpoint(name, operation)` | The stored value, or the stored result of `operation`.  |

A checkpoint does not make external effects exactly once. A process can stop after an external
system commits and before the checkpoint transaction commits. Then no row exists for that name.

More detail: [Data model: `task_checkpoint`](../architecture/data-model.md#task_checkpoint).

</details>

## Move a large change to a new queue

A queue for each version keeps the old code running for the tasks that started on it. Workers of
version 2 serve a new queue only. Producers enqueue new tasks on the new queue. Workers of version
1 continue to serve the old queue until it is empty.

**Example.** Version 1 workers serve the queue `orders`. Version 2 of `order.ship` changes most of
the handler.

1. At 0 h, a deployment starts version 2 workers that serve only `orders-v2`.
2. The same deployment changes each producer to enqueue `order.ship` on `orders-v2`.
3. At 5 h, a payment clears for a task that waited on `orders`. A version 1 worker claims it and
   runs the old code.
4. A new task on `orders-v2` runs on a version 2 worker.
5. When `orders` has no live task, you stop the version 1 workers.

Thus each task runs on the code of its queue. A new queue needs no setup. A queue that has no
control row is full tier and is not paused. A worker names its queues in `WorkerOptions.queues`.

```ts
// Version 2 deployment
const worker = new Worker(queue, { queues: ["orders-v2"] });
worker.handle("order.ship", shipVersion2);

await queue.enqueue("order.ship", { orderId }, { queue: "orders-v2" });
```

A signal and a human decision find the task by its ID, not by its queue. Thus
`Queue.sendSignal` and `Queue.completeHumanWait` reach a task on either queue.

<details>
<summary>Reference: queues and workers</summary>

- `WorkerOptions.queues` takes one or more queue names. `WorkerOptions.queue` takes one name. A
  worker throws if it gets both.
- `worker_registry.queue_names` stores the queues that each worker claims.
- A queue without a `queue_control` row reports tier `full`. It is not paused.
- `send_signal_v1` and `complete_human_wait_v1` address the task by its ID and the wait name. They
  take no queue.

More detail: [Task lifecycle: Queue set](../architecture/lifecycle.md#queue-set), [Task lifecycle: Signal delivery](../architecture/lifecycle.md#signal-delivery), [Task lifecycle: Human decision suspension](../architecture/lifecycle.md#human-decision-suspension), [Data model: `worker_registry`](../architecture/data-model.md#worker_registry), [Data model: `queue_control` and `queue_purge_request`](../architecture/data-model.md#queue_control-and-queue_purge_request), and [Dashboard: Queues page](../architecture/dashboard.md#queues-page).

</details>

## Keep the old workers until the old queue is empty

The version 1 workers must stay until each task on `orders` is terminal. A task that waits on a
human decision can keep the queue busy for days.

**Example.** An operator stops the version 1 workers too early.

1. At 0 h, a task on `orders` waits for `payment-cleared`.
2. At 1 h, the operator stops the last version 1 worker.
3. At 5 h, the payment clears. Workhorse sets the task to `ready`.
4. No worker serves `orders`, so no worker claims the task. It stays `ready`.

Thus a stopped queue strands its tasks. Before you stop the version 1 workers, make sure that
`orders` has no live task. A live task is `blocked`, `scheduled`, `ready`, or `active`, and a
waiting task is one of these. The dashboard Queues page shows the `scheduled`, `ready`, and
`active` tasks of each queue. It does not count a `blocked` task, so also look for `blocked` tasks
on `orders`. If tasks remain, start a version 1 worker again.

A [redrive](340-redrive.md) has the same risk. A redrive makes a new task from a failed task, and
it copies the queue of the failed task. Thus a redrive of a task
from `orders` puts the new task on `orders`, and no worker claims it after you stop the version 1
workers.

<details>
<summary>Reference: stranded tasks and redrive</summary>

- A claim reads only the queues that the worker serves. A ready task on a queue that no worker
  serves stays ready.
- `redrive_v1` creates a fresh ready task. It copies the queue, the type, the payload, and the
  retry policy of the source task.
- `task_runtime.state` holds the live state: `blocked`, `scheduled`, `ready`, or `active`.
- `dashboard_queues_v1` returns the Queues page. Each queue row has `scheduled`, `ready`, and
  `active` counts and no `blocked` count.

More detail: [Data model: `task_runtime`](../architecture/data-model.md#task_runtime), [Data model: `redrive_v1`](../architecture/data-model.md#redrive_v1), and [Dashboard: Queues page](../architecture/dashboard.md#queues-page).

</details>

## Move each reference to the old queue name

Some settings name a queue. These settings do not follow the producers to the new queue. Change
each one in the same deployment.

**Example.** A concurrency policy limits `orders` to the capacity of the carrier API.

1. At 0 h, the policy of `orders` admits the full limit of active tasks.
2. The deployment gives `orders-v2` a policy with the same limit.
3. While the old tasks drain, both queues admit the full limit at the same time.
4. The carrier API gets two times the load that you planned for.

Thus a limit for each queue does not hold across two queues. Give the tasks of both queues one
[budget](240-concurrency-policies.md) named `carrier-api`. A budget is a named limit that tasks in
many queues share. A rate limit has the same problem and the same solution.

Change these settings too:

- A child request names its queue in its `queue` option. Give each child request of version 2 the
  new queue name. Read [170-child-tasks.md](170-child-tasks.md).
- A schedule definition names its queue in `task.queue`. Synchronize the new name with
  `Queue.syncSchedules`. Read [220-schedules.md](220-schedules.md).
- An enqueue idempotency key keeps its binding when the queue changes. But the queue is part of the
  stored request. If a client repeats a request with the new queue name while the key is active,
  Workhorse raises a conflict. Read [210-enqueue-idempotency.md](210-enqueue-idempotency.md).

<details>
<summary>Reference: settings that name a queue</summary>

| Setting                         | Key or field                                                                                |
| ------------------------------- | ------------------------------------------------------------------------------------------- |
| Concurrency policy              | `concurrency_policy`, primary key `queue_name`                                              |
| Rate limit policy               | `rate_limit_policy`, one row per `queue_name`                                               |
| Budget                          | `workhorse.budget`, keyed by `budget_name`, not queue                                       |
| Child request                   | the `queue` enqueue option of `runChild` and `runChildren`                                  |
| Schedule definition             | `schedule_definition.queue_name`                                                            |
| Enqueue idempotency binding     | primary key `(idempotency_scope, idempotency_key_hash)`                                     |
| Enqueue idempotency fingerprint | includes `queue`; a difference before `expires_at` raises `EnqueueIdempotencyConflictError` |

More detail: [Data model: `concurrency_policy`](../architecture/data-model.md#concurrency_policy), [Data model: `rate_limit_policy` and `rate_limit_bucket`](../architecture/data-model.md#rate_limit_policy-and-rate_limit_bucket), [Data model: `budget` and `budget_bucket`](../architecture/data-model.md#budget-and-budget_bucket), [Data model: `task_child`](../architecture/data-model.md#task_child), [Operations: Schedule definitions](../architecture/operations.md#schedule-definitions), and [Data model: Fingerprint and replay](../architecture/data-model.md#fingerprint-and-replay).

</details>

## Do not use a new task type on the same queue

A new task type on the old queue looks simpler, but it is weaker than a new queue. A claim does not
filter by task type. Thus a version 1 worker can claim a task that it has no handler for.

**Example.** Version 2 enqueues `order.ship-v2` on `orders`. Version 1 workers still serve
`orders`.

1. A version 1 worker claims an `order.ship-v2` task. It has no handler for that type.
2. The worker gives the task back to the queue. The attempt stays the same.
3. The worker backs off before it claims again. The task stays ready.
4. A version 2 worker claims the task and runs it.

Thus the task runs, but later than necessary. The worker logs `workhorse.handler.missing` for each
release. Each release uses a slot of an old worker. The time
for which an old worker held the task counts against the execution timeout of the task. A new queue
keeps the old workers away from the new tasks.

<details>
<summary>Reference: a claim without a handler</summary>

- A worker that claims a task of an unregistered type calls `release_owned_v1`.
- `release_owned_v1` sets the task to `ready` without a change to `current_attempt`. It adds the
  elapsed lease to `execution_used_ms` and appends a `released` event.
- If each claim of a pass had no handler, the pass counts as empty for the poll backoff.

More detail: [Task lifecycle: Owned release](../architecture/lifecycle.md#owned-release).

</details>

## Next

- [130-durable-waits.md](130-durable-waits.md) — learn how a task waits and replays
- [340-redrive.md](340-redrive.md) — redrive a failed task to its queue
- [240-concurrency-policies.md](240-concurrency-policies.md) — share one limit across queues
  with a budget

---

Exact checkpoint storage and replay rules:
[`architecture/data-model.md`](../architecture/data-model.md#task_checkpoint).
