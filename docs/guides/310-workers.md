# Workers: the processes that actually run your jobs

A worker is a loop. Ask the database for a job, run the handler, record the result, repeat.
Everything else in this guide is detail on top of that.

Python supplies the same core loop through synchronous `Worker` and asynchronous `AsyncWorker`.
Both rotate across queues, bound concurrent slots, and drain active work after `stop`. Each claimed
job renews its lease and delivers ownership signals through its context cancellation token.
Both workers can open a dedicated notification connection and offer recurring namespaces for
PostgreSQL to evaluate.
`AsyncWorker` uses native Psycopg or asyncpg connections, while its handlers and durable context
methods are awaitable. TypeScript, Python, and Go workers all participate in the worker registry.
Python's `handle_batch` follows the grouping contract in
[315-batch-handlers.md](315-batch-handlers.md).

```python
worker = AsyncWorker.from_asyncpg(connection, queues=("email", "billing"))

async def deliver(payload, context):
    prepared = await context.checkpoint("prepare", prepare_delivery)
    return await send_message(payload, prepared)

worker.handle("email.send", deliver)
await worker.run()
```

## Slots and concurrency

A worker has a fixed number of slots, set by `concurrency`. One slot runs one job. By
default a worker runs one job at a time, and you can raise it.

Each pass, the worker fills whatever slots are free — one claim at a time, because each
claim is its own database operation. Once the slots are full, or the queue has nothing left,
it stops asking. Every running job gets its own heartbeat timer, its own abort signal, and
its own final write, so they don't interfere with each other.

Concurrency here is per worker. More workers add more process slots. Use a
[concurrency policy](240-concurrency-policies.md) when the fleet must share one durable budget.

## Choosing queues

A worker can serve several queues under one identity and one slot budget. It rotates across the
configured names, so work waiting in one queue does not disappear behind a continuously busy sibling.

```ts
const worker = new Worker(queue, {
  queues: ["email", "billing"],
});
```

Use `queue` for one name or `queues` for several. If you omit both, the worker uses the queue
client's default. A batch callback still receives jobs from only one queue at a time.

## Waiting without constant polling

An idle worker listens for `workhorse_jobs`, so a committed enqueue can wake it immediately.
Workers that share a database pool also share the listener connection, while each worker receives
only its queue's wake hints. Promotion and recovery can wake every worker because either may make
work claimable across queues.

The notification is only a hint. If PostgreSQL drops the listener or a message is missed, the
worker reconnects and still checks through `pollMs`. This keeps the database state authoritative:
a missing notification can delay a claim, but it cannot strand the job.

## Running workers in their own process

The recommended deployment is a dedicated worker process, separate from your web app. The
process owns its database connections, its workers, signal handling, and shutdown.

Keep workers outside your web server because queue depth and HTTP traffic rarely need the same
number of processes. This also lets a worker restart without taking down web ingress.

## Shutting down cleanly

On `SIGINT` or `SIGTERM`, the process stops claiming new work immediately, then waits for
the jobs already running to finish. Connections close after the last one settles.

Python processes get the same boundary by passing their configured `Worker` to
`run_worker_process`. Keep the connection context outside that call so it closes after the drain.

Go applications pass a context from `signal.NotifyContext` to `Worker.Run`. A handler panic fails
that attempt, while the worker stays alive to serve later jobs.

A few consequences worth knowing:

- A claim already in flight may still land after shutdown starts. That job gets drained
  properly, not abandoned.
- There's a configurable drain deadline after which the process exits anyway. A handler
  that ignores its abort signal doesn't get to block a deploy forever.
- A hard kill leaves jobs marked active. That's fine: their leases expire and
  [recovery](020-leases-and-fences.md) picks them up. Nothing is lost, it's just slower.
- Shutting down does **not** cancel jobs. It stops running them here so something else can.

## The worker registry

Each worker periodically writes a row saying it exists: its id, queues, concurrency, and how
many slots are busy. That's how a dashboard can show a fleet it doesn't host — process
memory can't answer "which workers are alive" once workers are deployed separately.

This registry is never read when claiming jobs, so it can't slow dispatch down.

A worker that's killed stops refreshing and is reported offline once its row goes stale. Automatic
maintenance eventually cleans up that row. Slot counts are therefore a moment-ago snapshot, not a
live read.

Registration failures do not stop dispatch. A worker keeps the last remote pause it received, so a
temporary database error cannot silently resume claims that an operator stopped.

## Pausing

Two different things share the word "pause":

- **Local**: TypeScript and Python code can call `pause()` on a worker object. Claims stop; running
  jobs finish.
- **Operator**: someone clicks pause in the dashboard. That's stored in the database, and
  the worker picks it up on its next refresh.

The split matters. A worker cannot clear an operator pause by calling `resume()` — otherwise
pausing a fleet from a dashboard would be undone by the fleet itself. But an operator pause
only lasts as long as that process does: restart the worker and it starts fresh, unpaused.

Pause is cooperative, like cancellation. Jobs already running run to completion. If you need
work to stop _durably_, pause the queue, not the worker.

## Next

- [020-leases-and-fences.md](020-leases-and-fences.md) — what happens when a worker dies
- [120-cancellation.md](120-cancellation.md) — the other cooperative stop
- [240-concurrency-policies.md](240-concurrency-policies.md) — limit dispatch across workers

---

Exact registry columns, options, and lifecycle:
[`architecture.md`](../architecture.md#worker_registry).
