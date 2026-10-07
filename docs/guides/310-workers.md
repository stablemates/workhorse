# How does a worker run my tasks?

<!-- scenario-names: invoice.render, worker_pool, prepare_delivery, deliver, mailer-1, email, billing -->

A worker is a loop. It asks the database for a task, runs the handler, records the result, and
repeats. Everything else in this guide is detail on top of that loop.

## One worker, eight slots

A worker named `mailer-1` serves two queues, `email` and `billing`. Its `concurrency` is 8, so it
has eight slots. One slot runs one task.

1. **At start** all eight slots are free. The worker sends one claim to `email` for eight tasks.
   PostgreSQL returns eight. Every slot is now busy, and each task holds its own lease.
2. **A moment later** one email task finishes, and one slot frees up. No claim is out, so the worker
   sends a claim for one task. The worker rotates across its queues, so this claim goes to `billing`.
3. **While that claim is still out** two more email tasks finish. Two slots are free beyond the one
   the first claim reserved. That is enough for a second claim, so the worker sends one to `email`
   for two tasks. Two claims are now in flight.
4. **Throughout**, one heartbeat timer renews every running lease in a single batch.

A busy worker does not wait for one claim to return before it sends the next. When enough slots free
up, it sends another claim while the first is still out. That keeps slots full without one round
trip per task.

The worker never claims more tasks than it has free slots, because each claimed task holds a lease.
It stops asking when its slots are full or the queue has nothing left. PostgreSQL still checks every
task in a claim on its own, so ordering and admission policies apply to each one.

In TypeScript, Python, and Go, a task stays in the heartbeat batch after its handler returns, until
its final write is done. A Rust task leaves the batch when its handler returns. Every task still has
its own abort signal and final write, so cancellation and settlement stay independent.

Concurrency here is per worker. More workers add more slots. Use a
[concurrency policy](240-concurrency-policies.md) when the fleet must share one durable budget.

<details>
<summary>Reference: slots and claims</summary>

**`concurrency`**

| SDK        | Option                      | Range    | Default |
| ---------- | --------------------------- | -------- | ------- |
| TypeScript | `WorkerOptions.concurrency` | 1 to 100 | 1       |
| Python     | `concurrency`               | 1 to 100 | 1       |
| Go         | `WorkerOptions.Concurrency` | 1 to 100 | 1       |

**Claim rules.** Each claim calls `claim_many_v1` for a number of slots. A claim in flight reserves
its limit, so free slots are `concurrency` minus running handlers minus reserved slots.

1. With no claim in flight, any free slot starts a claim for all free slots.
2. With a claim in flight, another starts only when free slots reach `ceil(concurrency / 4)`. At
   most four claims are therefore in flight.
3. The queue cursor advances after every claim attempt.
4. Tasks that a claim returns after `stop`, `pause`, or an error still run, because each holds a
   lease.

The shared runtime fixture pins, at concurrency 8, the claim limits 8, 1, and 2 with two claims in
flight.

**Heartbeats.** One round per worker sends every active lease through `heartbeat_many_v1`. Rounds
never overlap.

More detail: [Task lifecycle: Dispatch loop](../architecture/lifecycle.md#dispatch-loop) and [Task lifecycle: Worker options](../architecture/lifecycle.md#worker-options).

</details>

## Choosing queues

`mailer-1` serves `email` and `billing` under one identity and one slot budget. Suppose `email`
always has work waiting, and one `billing` task arrives.

1. **The worker claims from `email`.** The queue cursor then moves on.
2. **Its next claim goes to `billing`.** The `billing` task gets a slot even though `email` never
   empties.

The worker rotates across its configured queues, so work in one queue does not disappear behind a
continuously busy sibling. The Python example builds this worker as an `AsyncWorker`. Its handler
uses a checkpoint, which [Cancelling a Python async handler](#cancelling-a-python-async-handler)
explains. The TypeScript example shows only the queue option.

```python
async def deliver(payload, context):
    prepared = await context.checkpoint("prepare", prepare_delivery)
    return await send_message(payload, prepared)

async with asyncpg.create_pool(database_url) as worker_pool:
    worker = AsyncWorker.from_asyncpg(worker_pool, queues=("email", "billing"))
    worker.handle("email.send", deliver)
    await worker.run()
```

```ts
const worker = new Worker(queue, {
  queues: ["email", "billing"],
});
```

Use `queue` for one name or `queues` for several. If you omit both, the worker uses the queue
client's default. A [batch handler](315-batch-handlers.md) still receives tasks from only one queue
at a time.

A worker discovers each queue's [tier](305-fast-tier.md) on its own, so a fast-tier queue needs no
worker option. On the fast tier, a busy worker in any language splits its slots into
[cohorts](305-fast-tier.md#workers-need-no-configuration) that complete separately.

<details>
<summary>Reference: queue set</summary>

- `WorkerOptions.queues` takes one or more non-empty queue names. Duplicates collapse to one entry,
  in first-occurrence order.
- `WorkerOptions.queue` takes a single name.
- Supplying both throws. Python raises `ValueError`.
- Omitting both uses `WorkerQueueApi.defaultQueue`.

One worker identity, pause state, and `concurrency` budget cover the whole queue set.

More detail: [Task lifecycle: Queue set](../architecture/lifecycle.md#queue-set).

</details>

## Tasks this worker cannot run

A claim does not filter by task type. So a worker can be handed a task whose type it has no handler
for. That is normal during a deploy that replaces workers one at a time.

1. **Release 2 starts.** One new worker runs it, and it enqueues the new type `invoice.render`.
2. **An old worker claims that task.** It runs release 1, which has no handler for `invoice.render`.
3. **The old worker hands the claim straight back.** Workhorse returns the task to its queue as
   `ready`. The attempt count stays the same.
4. **The new worker claims the task** and runs it as attempt 1.

Failing the task instead would spend an attempt on a worker that never ran anything. A task allowed
a single attempt would then be dead-lettered without ever running.

The hand-back is fenced like every other owned write. A worker whose lease PostgreSQL no longer
recognizes cannot return a task that another worker is already running.

A pass that only handed claims back counts as an empty one. The worker then waits before asking
again. So a type that no deployed worker handles is re-checked on the polling cadence, not in a loop.

<details>
<summary>Reference: owned release</summary>

`release_owned_v1(task, worker, fence)` locks the matching unexpired active row. Then:

- it answers `cancel_requested` when a cancellation is pending;
- it delegates to `expire_owned_v1` when `deadline_at` or `attempt_timeout_at` has passed;
- it answers `stale` when PostgreSQL no longer recognizes the fence.

Otherwise it:

1. Sets the row to `ready` with a new `sequence`. `current_attempt` does not change.
2. Clears `worker_id`, `fence_token`, `acquired_at`, `heartbeat_at`, `expires_at`, `wait_name`,
   `attempt_timeout_at`, and `error`.
3. Adds the time the lease was held to `execution_used_ms`.
4. Notifies `workhorse_tasks`.
5. Appends a `released` event with `worker_id` and `fence_token`.

It writes no `attempt_history` row, because the attempt is not closed. A claim counts as empty when
it returns no row, or only rows it released.

More detail: [Task lifecycle: Owned release](../architecture/lifecycle.md#owned-release).

</details>

## Waiting without constant polling

`mailer-1` has finished every task, and both queues are empty.

1. **The worker goes idle.** It listens for `workhorse_tasks` notifications.
2. **An app commits an enqueue to `email`.** PostgreSQL sends a notification naming `email`.
3. **The worker wakes.** Its last claim found nothing, so it waits a small random delay, then claims.
   The delay keeps one enqueue from making every idle process query at the same instant.
4. **Suppose the listener's connection had dropped** and the notification was lost. The worker still
   checks on its fallback poll, so the task waits a little longer but is not stranded.

The notification is only a hint. Database state stays authoritative: a missing notification can
delay a claim, but it cannot strand a task. After a dropped listener, the worker reconnects.

A busy worker skips the random delay and claims at once. A dependency release notifies on every
completion, so the delay would otherwise slow every claim. Without a listener, consecutive empty
checks back off to a cap and reset as soon as a claim succeeds.

Each worker receives only its own queues' wake hints. Promotion, a regular background pass that moves
due tasks to `ready`, notifies each affected queue separately, and so does recovery. Work on one
queue therefore does not wake workers assigned to another. A notification wakes dispatch without
changing the cadence of maintenance or registration.

TypeScript, Go, and Ruby workers that share a database pool also share one listener connection. A
Python or Rust worker holds its own.

<details>
<summary>Reference: polling cadence</summary>

| Case                                          | Wait                                       |
| --------------------------------------------- | ------------------------------------------ |
| Listener connected (`run()`)                  | 5,000 ms fallback poll, ±10% jitter        |
| Notification after an empty claim             | Random delay of 0 to 50 ms before claiming |
| Notification after a claim that found work    | No delay                                   |
| Explicit `pollMs` (`poll_ms`, `PollInterval`) | Replaces the fallback base                 |
| No listener, consecutive empty waits          | Doubles up to a 5,000 ms cap, ±10% jitter  |
| No listener, starting wait                    | 250 ms                                     |
| TypeScript `runOnce()`                        | 250 ms; never opens a listener             |

- A payload naming a configured queue, or `*`, wakes the worker.
- `promote_v1`, `run_task_now_v1`, `recover_expired_v1`, `sync_concurrency_policies_v1`, and
  `sync_rate_limit_policies_v1` notify once per affected queue.
- A failed listener reconnects after exponential delays from 100 ms to 5,000 ms, and every reconnect
  wakes its subscribers.
- A pool with a capacity of 1 stays polling-only. Go `WorkerOptions.PollingOnly` turns the listener
  off for a transaction-mode pooler.

More detail: [Operations and CLI: Polling cadence](../architecture/operations.md#polling-cadence) and [Operations and CLI: Task notifications](../architecture/operations.md#task-notifications).

</details>

## Python workers and their pool

In the example, the app opens `worker_pool` and hands it to the worker.

1. **During the run**, the worker borrows a pool connection for each claim and lifecycle statement
   and returns it afterwards.
2. **For the whole run**, it also
   [reserves its own heartbeat and listener connections](390-connection-pooling.md#how-do-i-budget-connections)
   from that pool. Size the pool for them.
3. **When `run` returns**, the worker leaves the pool open. The `async with` block then closes it.

Your code creates the pool and owns it. Close it only after `run` returns, because the worker never
closes the pool it was given.

Python supplies the same core loop through the synchronous `Worker` and the asynchronous
`AsyncWorker`. Both rotate across queues, bound concurrent slots, and drain active work after `stop`.
Each claimed task renews its lease and delivers ownership signals through its context's cancellation
token. Both workers can listen for notifications and offer recurring namespaces for PostgreSQL to
evaluate. Python's `handle_batch` follows the grouping contract in
[315-batch-handlers.md](315-batch-handlers.md).

`AsyncWorker.from_psycopg` takes a Psycopg `AsyncConnectionPool`, and `AsyncWorker.from_asyncpg`
takes an asyncpg `Pool`. Its handlers and durable context methods are awaitable.

<details>
<summary>Reference: async worker pool</summary>

| Factory                    | Pool                          |
| -------------------------- | ----------------------------- |
| `AsyncWorker.from_psycopg` | Psycopg `AsyncConnectionPool` |
| `AsyncWorker.from_asyncpg` | asyncpg `Pool`                |

- The worker borrows one connection per statement and returns it afterwards.
- Unless `shared_heartbeats` is set, it reserves one pool connection for heartbeat rounds for the
  whole run.
- The listener holds another pool connection while it listens.
- Psycopg connections must use `autocommit=True`. Otherwise the worker raises `ValueError`.
- `AsyncWorker` never closes the pool it was given.

More detail: [Schema and SQL protocol: Pool connections](../architecture/schema-and-protocol.md#pool-connections).

</details>

## Cancelling a Python async handler

The handler `deliver` from the example calls `context.checkpoint("prepare", prepare_delivery)`.
Something cancels the asyncio task that awaits the checkpoint.

1. **If the cancellation arrives while `prepare_delivery` still runs**, the checkpoint cancels the
   operation and waits for its cleanup. Nothing is saved, so a later attempt runs
   `prepare_delivery` again.
2. **If the cancellation arrives after `prepare_delivery` returned**, its save may already be under
   way. The worker waits for that save instead of undoing it. The handler sees `CancelledError`, and
   a later attempt replays the saved value without calling `prepare_delivery`.

A cancelled await therefore never proves that no checkpoint exists. It also does not undo the
operation's effects on other systems.

The operation runs in a copy of the handler's context. It sees the handler's context variables and
current OpenTelemetry span.

Cancelling the task that awaits `AsyncWorker.run()` or `run_once()` asks the worker to drain. A
repeated cancellation does not cut that drain short. The call re-raises `CancelledError` only after
active handlers finish and the notification connection is released. Keep the pool and event loop open
until then. Task cancellation is not the process runner's second signal, which exits without
waiting.

<details>
<summary>Reference: checkpoint cancellation</summary>

**Before the operation returns**

- `checkpoint` stops the tracked task before `operation` is called, or cancels it while it runs.
- It waits for the task's cleanup.
- If `operation` absorbs the cancellation and returns a value, the tracked task raises
  `asyncio.CancelledError` instead.
- No row is stored in `workhorse.task_checkpoint`.

**After the operation returns**

- The core sends `save_checkpoint_v1`, and `_await_bridge_call` waits for that call before it
  re-raises.
- The row may commit. A later attempt replays its value.
- `save_checkpoint_v1` checks the worker, fence, lease expiry, deadline, attempt timeout, and
  `cancel_requested_at`. Asyncio cancellation is not one of its conditions.

**Context.** `checkpoint` copies the caller's `contextvars` context, and the tracked task runs in
that copy. Changes inside `operation` stay inside it.

More detail: [Schema and SQL protocol: Cancelling a checkpoint](../architecture/schema-and-protocol.md#cancelling-a-checkpoint).

</details>

## Running workers in their own process

Worker `mailer-1` runs in its own process, separate from the web app.

1. **At 09:00** HTTP traffic triples. The operator scales the web app to six processes and leaves
   the worker process as it is.
2. **At 09:30** the `email` queue backs up. The operator starts a second worker process. The web app
   does not change.
3. **At 10:00** a deploy restarts the worker process. The web app keeps serving requests while the
   new worker process starts.

The recommended deployment is a dedicated worker process, separate from your web app. The process
owns its database connections, its workers, signal handling, and shutdown.

Keep workers outside your web server, because queue depth and HTTP traffic rarely need the same
number of processes. A worker can then restart without taking down web ingress.

<details>
<summary>Reference: process entry points</summary>

| SDK        | Entry point                                                                       |
| ---------- | --------------------------------------------------------------------------------- |
| TypeScript | `defineWorkerProcess()`, then `runWorkerProcess()` or `workhorse worker --config` |
| TypeScript | `startWorkerProcess()`, without global signal handling                            |
| Python     | `run_worker_process(worker, *, shutdown_timeout_ms, force_exit)`                  |
| Go         | A context from `signal.NotifyContext`, passed to `Worker.Run`                     |
| Rust       | `run_worker_process(&worker)`                                                     |

The optional TypeScript probe listener reports liveness while running or draining. It reports
readiness only while the process accepts claims.

More detail: [Operations and CLI: Worker process lifecycle](../architecture/operations.md#worker-process-lifecycle).

</details>

## Shutting down cleanly

A deploy sends `SIGTERM` to a TypeScript worker process that runs three tasks.

1. **At 0 s** the process stops claiming new work at once. The three tasks keep running, and their
   leases keep renewing.
2. **At 4 s** two tasks finish and write their results.
3. **The third handler ignores its abort signal** and keeps going.
4. **At the drain deadline** the process exits anyway. The third task is still marked active, so its
   lease expires and [recovery](020-leases-and-fences.md) gives it to another worker.

If all three had finished before the deadline, connections would close after the last one settled.

A few consequences are worth knowing:

- A claim already in flight may still land after shutdown starts. The worker drains that task
  properly rather than abandoning it.
- The drain deadline is configurable. A handler that ignores its abort signal does not get to block a
  deploy forever.
- A hard kill leaves tasks marked active. That is fine: their leases expire and recovery picks them
  up. Nothing is lost; it is just slower.
- Shutting down does **not** cancel tasks. It stops running them here, so something else can.

Python processes get the same boundary by passing their configured `Worker` to
`run_worker_process`. Keep the connection context outside that call, so it closes after the drain.

<details>
<summary>Reference: shutdown deadline</summary>

| SDK        | Option                                 | Default   | Range             |
| ---------- | -------------------------------------- | --------- | ----------------- |
| TypeScript | `shutdownTimeoutMs`                    | 25,000 ms | 1 to 3,600,000 ms |
| Python     | `shutdown_timeout_ms`                  | 25,000 ms | 1 to 3,600,000 ms |
| Go         | `WorkerOptions.ShutdownGracePeriod`    | 25,000 ms | Positive whole ms |
| Rust       | `WorkerOptions::shutdown_grace_period` | 25 s      | —                 |

**TypeScript process exits**

| Event                          | Exit                                                             |
| ------------------------------ | ---------------------------------------------------------------- |
| Second signal                  | Conventional signal code                                         |
| Missed deadline                | Code 1                                                           |
| Unexpected worker-loop failure | Stops sibling workers, applies the same drain, fails the process |

Python's second signal calls `force_exit` with 128 plus the signal number: 130 for `SIGINT`, 143 for
`SIGTERM`. A missed deadline calls `force_exit(1)`.

The first signal marks readiness false and calls `stop()` on every worker. Active handlers and their
heartbeat batch continue. Process termination never writes a durable task cancellation.

More detail: [Operations and CLI: Shutdown deadline and failure](../architecture/operations.md#shutdown-deadline-and-failure) and [Schema and SQL protocol: Python worker processes](../architecture/schema-and-protocol.md#python-worker-processes).

</details>

## Shutdown in Go and Rust

A Go worker runs two tasks when its `Run` context ends. One claim is still in flight.

1. **The grace period starts at once.** It starts when `Run` stops, before `Run` waits for the claim.
2. **The claim returns in time.** Its task still runs.
3. **One handler ignores its cancellation.** At the deadline, `Run` cancels it and gives it a short
   window to unwind.
4. **`Run` returns `ErrShutdownIncomplete`.** The handler still runs inside the process, but its
   lease stops renewing. Recovery can rerun the task elsewhere.

`Run` returning is not the process exiting. Go applications pass a context from
`signal.NotifyContext` to `Worker.Run`. The grace period also starts when a lifecycle error stops
the run. The deadline bounds every shutdown step, including a claim still in flight. A claim the
deadline cuts short may hold a lease it never returned, and that lease expires so recovery picks the
task up. A handler cancelled at the deadline does not turn a clean shutdown into an error. When that
handler returns an error, the worker hands its task back to the queue without charging an attempt. A
handler panic fails that attempt, while the worker stays alive to serve later tasks.

A Rust worker starts its grace period as soon as `Worker::run` observes its shutdown future. The same
deadline bounds a claim in flight and the registry update that marks the worker draining. A short
cleanup window after it bounds deregistration and the release of the heartbeat connection. A locked
registry row or a stalled heartbeat cannot hold `run`.

<details>
<summary>Reference: Go shutdown grace period</summary>

When `ShutdownGracePeriod` expires, `Run` acts in this order:

1. It cancels every handler still executing.
2. It allows 250 ms for those handlers to unwind.
3. It stops renewing the leases of whatever still runs.
4. It returns an error matching `ErrShutdownIncomplete`, naming how many it abandoned.

- The deadline cancels an in-flight claim, a fused completion claim, and the draining registration
  refresh.
- `deregister_worker_v1` then gets at most 1,000 ms.
- After the deadline, the drain does not report an execution error that matches `context.Canceled`.
- A handler that returns an error after its cancellation charges no attempt. `release_owned_v1`
  returns its task to the queue, and a failed release leaves the task to lease recovery.
- A handler panic becomes a `HandlerPanicError` and fails that attempt.

More detail: [Schema and SQL protocol: Shutdown grace period](../architecture/schema-and-protocol.md#shutdown-grace-period).

</details>

<details>
<summary>Reference: Rust shutdown</summary>

- The deadline is fixed when the dispatcher observes `shutdown`. Claims in flight, the draining
  `register_worker_v1` refresh, and running handlers all spend from it.
- A claim still pending at the deadline is dropped. Any task it claimed stays leased until recovery.
- Handlers still running when grace ends see `CancelReason::Shutdown` and get 250 ms to unwind.
- A handler that returns an error after that cancellation charges no attempt. `release_owned_v1`
  returns its task to the queue. A panic still fails the attempt.
- `run` abandons any that outlive that window and returns `Error::ShutdownIncomplete`.
- The cleanup window covers stopping the registry loop and listener, `deregister_worker_v1`, and the
  heartbeat connection release. It ends 1 s after the later of the deadline and the end of the drain.

More detail: [Schema and SQL protocol: Shutdown](../architecture/schema-and-protocol.md#shutdown) and [Schema and SQL protocol: Cleanup window](../architecture/schema-and-protocol.md#cleanup-window).

</details>

## The worker registry

A deploy replaces workers one at a time, so for a while two builds run at once. One worker behaves
differently, and an operator wants to know why.

1. **Every few seconds, each worker writes its registry row.** The row holds its id, queues, schedule
   namespaces, concurrency, and how many slots are busy.
2. **The row also says what the worker is**: which client library it runs, at which version, and
   which protocol it speaks.
3. **The operator opens the Workers page.** The odd worker still reports the old version.

That is how a dashboard can show a fleet it does not host. Process memory cannot answer "which
workers are alive" once workers are deployed separately. TypeScript, Python, Go, Rust, and Ruby
workers all write this row. An older worker may report none of the three identity fields. The
registry then records that it reported nothing, rather than guessing.

The namespace list answers a different question from the queue list. Queues control which tasks a
worker can claim. Schedule namespaces control which recurring definitions it can evaluate.

`claim_v1` never reads this registry, so the registry cannot slow dispatch down.

A worker that dies stops refreshing, and the dashboard reports it offline once its row goes stale.
Automatic maintenance eventually removes that row. Slot counts are therefore a recent snapshot, not
a live read.

Registration failures do not stop dispatch. A worker keeps the last remote pause it received, so a
temporary database error cannot silently resume claims that an operator stopped.

<details>
<summary>Reference: registration</summary>

`register_worker_v1` publishes these values in one round trip and returns the `paused` flag:

- `queue_names`, `schedule_namespaces`, `concurrency`, and `lease_ms`;
- `heartbeat_ms`, `poll_ms`, `maintenance_interval_ms`, and `maintenance_routine_poll_ms`;
- `registry_interval_ms`, `active_slots`, and `draining`;
- `client_protocol_version`, `sdk_language`, and `sdk_version`.

| SDK        | Refresh interval                   | Default | Opt-out                           |
| ---------- | ---------------------------------- | ------- | --------------------------------- |
| TypeScript | `WorkerOptions.registryIntervalMs` | 5 s     | `0`                               |
| Python     | `registry_interval_ms`             | 5 s     | `0`                               |
| Go         | `WorkerOptions.RegistryInterval`   | 5 s     | `WorkerOptions.DisableRegistry`   |
| Rust       | `WorkerOptions::registry_interval` | 5 s     | `WorkerOptions::disable_registry` |
| Ruby       | `registry_interval:`               | 5 s     | `disable_registry: true`          |

**Client identity.** All three fields are nullable. Each SDK stamps its own `sdk_language`
(`typescript`, `python`, `go`, `rust`, `ruby`) and package version. A refresh overwrites all three.

**Removal.** Graceful shutdown calls `deregister_worker_v1`. `run_maintenance_v1` calls
`prune_worker_registry_v1` with a one-minute maximum age.

More detail: [Data model: `worker_registry`](../architecture/data-model.md#worker_registry).

</details>

## Pausing

An operator pauses `mailer-1` from the dashboard while a downstream service is under repair.

1. **The pause is stored in the database**, on the worker's registry row.
2. **On its next registry refresh** the worker reads the pause and stops claiming. Its running tasks
   finish.
3. **The worker's own code calls `Worker.resume`.** The operator pause stays in force.
4. **The process restarts** after a deploy. The new process starts fresh and unpaused.

Two different things share the word "pause":

- **Local.** TypeScript and Python code can call `Worker.pause`. Claims stop, and running tasks
  finish.
- **Operator.** Someone pauses the worker from the dashboard, or runs `admin pause-worker` in the
  [terminal](380-admin-cli-and-tui.md). That is stored in the database, and the worker picks it up
  on its next refresh.

The split matters. A worker cannot clear an operator pause by calling `Worker.resume`. Otherwise
pausing a fleet from a dashboard would be undone by the fleet itself. But an operator pause lasts
only as long as that process does.

Pause is cooperative, like [cancellation](120-cancellation.md). Tasks already running run to
completion. If you need work to stop _durably_, pause the queue, not the worker.

<details>
<summary>Reference: operator pause</summary>

- `admin pause-worker` and `admin resume-worker` write `worker_registry.paused` through
  `Admin.setWorkerPaused`. An unregistered worker id exits 1 with `is not registered`.
- `set_worker_paused_v1` validates `paused_by` (1 to 200 characters), `paused_reason` (1 to 2,000
  characters), and the request ID (1 to 512 UTF-8 bytes).
- Each worker start announces a fresh `instance_id`. `register_worker_v1` keeps the pause only while
  that instance keeps refreshing. A new instance of the same worker id clears it.
- A worker may not write `paused`, and an operator may not write the runtime columns.

More detail: [Data model: Pause scope](../architecture/data-model.md#pause-scope), [Data model: Pause ownership](../architecture/data-model.md#pause-ownership), and [Operations and CLI: Worker pause](../architecture/operations.md#worker-pause).

</details>

## Next

- [020-leases-and-fences.md](020-leases-and-fences.md) — what happens when a worker dies
- [120-cancellation.md](120-cancellation.md) — the other cooperative stop
- [240-concurrency-policies.md](240-concurrency-policies.md) — limit dispatch across workers

---

Exact registry columns, options, and lifecycle:
[`architecture/data-model.md`](../architecture/data-model.md#worker_registry).
