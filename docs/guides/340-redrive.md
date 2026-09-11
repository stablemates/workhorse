# Redrive: running a failed task again

A task used up all its attempts and gave up. Later you discover the API it was calling had
been down for an hour. The task would work fine now.

Redriving is an operator saying: make me a fresh copy of this task and run it.
TypeScript and Go application code make that request through `Admin`. Python uses `Admin` or
`AsyncAdmin`. Each operator client stays separate from the application-shaped `Queue` client.
An operator without a terminal asks for the same thing from the dashboard, in the listing that
shows the failed tasks, one task or one filtered batch at a time.

## Dead letters

When a task exhausts its retries it isn't deleted — it becomes a failed outcome
with its error attached. Most queues call this the dead letter queue. In Workhorse it's just
the set of failed tasks, and you can page through it oldest-first to see what's accumulated.

That listing uses a cold failure index outside the ready scan. Dead-letter growth therefore does
not enlarge the dispatch indexes, although database load and storage health can still affect both
paths.

## A new task, not a resurrection

Redriving does **not** restart the old task. It creates a brand new one, and records a link
between the two.

The new task copies what defines the work: queue, type, payload, tags, attempt budget, retry
policy, execution timeout. It deliberately does not copy the wreckage — no checkpoints, no
waits, no attempt count, no old error, and not the original deadline either. A deadline that
already passed would make the copy fail instantly, which is never what you meant.

Dependency edges, child lineage, signal deliveries, and human decisions stay with the old identity.
See [dependencies](160-task-dependencies.md), [children](170-child-tasks.md),
[signals](135-signals.md), and [human decisions](145-human-decisions.md) for those lifecycles.

So the new task starts genuinely clean, and the old one stays untouched as evidence. Its
error stays readable until [retention](330-retention.md) retires it.

## Why a link and not a copy

Every redriven task records where it came from. This lets you walk back through repeated
redrives and inspect the original failure. [Retention](330-retention.md) preserves that
lineage while a descendant remains.

## Clicking twice

Every redrive request carries an id. Repeat the same request and you get back the task that
already exists, rather than a second copy. An impatient operator clicking twice doesn't run
the work twice.

Sending the _same_ request id with a different reason or a different person attached is
treated as a conflict, not a duplicate — those are two different claims about what happened,
and silently keeping one would lose an audit record.

## Bulk redrive

You can redrive a page of failed tasks at once, oldest first, with a cursor so you can work
through a backlog in chunks without redoing what you've already done. There's a dry-run mode
that tells you what _would_ happen and writes nothing — worth using before you replay a
large backlog into a service that may still be unhealthy.

## Attribution is not permission

The person and reason recorded on a redrive are for the audit trail. Workhorse does not
check whether they were allowed to do it. That check belongs in your application, before you
call redrive.

## Next

- [110-retries.md](110-retries.md) — the automatic attempts that happen first
- [330-retention.md](330-retention.md) — how long a failed task sticks around
- [010-tasks-and-state.md](010-tasks-and-state.md) — why the failed task is still there at all

---

Exact lineage columns, copy rules, and conflict shape:
[`architecture.md`](../architecture.md#task_redrive).
