# Workers: the processes that actually run your jobs

A worker is a loop. Ask the database for a job, run the handler, record the result, repeat.
Everything else in this guide is detail on top of that.

## Slots and concurrency

A worker has a fixed number of slots, set by `concurrency`. One slot runs one job. The
default is 1, and you can raise it.

Each pass, the worker fills whatever slots are free — one claim at a time, because each
claim is its own database operation. Once the slots are full, or the queue has nothing left,
it stops asking. Every running job gets its own heartbeat timer, its own abort signal, and
its own final write, so they don't interfere with each other.

Concurrency here is per worker. Two workers with concurrency 5 give you ten slots. There's
no global rate limit or fair-share budget across processes.

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

You _can_ co-host workers inside your web server, and for small apps that's fine. But
scaling them separately is the point: your queue depth and your HTTP traffic rarely need the
same number of machines.

## Shutting down cleanly

On `SIGINT` or `SIGTERM`, the process stops claiming new work immediately, then waits for
the jobs already running to finish. Connections close after the last one settles.

A few consequences worth knowing:

- A claim already in flight may still land after shutdown starts. That job gets drained
  properly, not abandoned.
- There's a deadline — around half a minute by default — after which the process exits
  anyway. A handler that ignores its abort signal doesn't get to block a deploy forever.
- A hard kill leaves jobs marked active. That's fine: their leases expire and
  [recovery](020-leases-and-fences.md) picks them up. Nothing is lost, it's just slower.
- Shutting down does **not** cancel jobs. It stops running them here so something else can.

## The worker registry

Each worker periodically writes a row saying it exists: its id, queue, concurrency, and how
many slots are busy. That's how a dashboard can show a fleet it doesn't host — process
memory can't answer "which workers are alive" once workers are deployed separately.

This registry is never read when claiming jobs, so it can't slow dispatch down.

A worker that's killed stops refreshing, is reported offline once its row goes stale, and is
eventually cleaned up. Slot counts are therefore a moment-ago snapshot, not a live read.

## Pausing

Two different things share the word "pause":

- **Local**: your code calls `pause()` on a worker object. Claims stop; running jobs finish.
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
- [220-schedules.md](220-schedules.md) — workers also evaluate cron

---

Exact registry columns, options, and lifecycle:
[`architecture.md`](../architecture.md#worker_registry).
