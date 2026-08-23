# Redrive: running a failed job again

A job used up all its attempts and gave up. Later you discover the API it was calling had
been down for an hour. The job would work fine now.

Redriving is an operator saying: make me a fresh copy of this job and run it.
TypeScript application code makes that request through `Admin`, which is separate from the
application-shaped `Queue` client.

## Dead letters

When a job exhausts its retries it isn't deleted — it becomes a permanent failed outcome
with its error attached. Most queues call this the dead letter queue. In Workhorse it's just
the set of failed jobs, and you can page through it oldest-first to see what's accumulated.

That listing is deliberately kept off the dispatch path, so however many dead letters pile
up, claiming jobs stays exactly as fast.

## A new job, not a resurrection

Redriving does **not** restart the old job. It creates a brand new one, and records a link
between the two.

The new job copies what defines the work: queue, type, payload, tags, attempt budget, retry
policy, execution timeout. It deliberately does not copy the wreckage — no checkpoints, no
waits, no attempt count, no old error, and not the original deadline either. A deadline that
already passed would make the copy fail instantly, which is never what you meant.

Dependency edges, child lineage, signal deliveries, and human decisions stay with the old identity.
See [dependencies](160-job-dependencies.md), [children](170-child-jobs.md),
[signals](135-signals.md), and [human decisions](145-human-decisions.md) for those lifecycles.

So the new job starts genuinely clean, and the old one stays untouched as evidence. Its
error is still there to read next month.

## Why a link and not a copy

Every redriven job records where it came from. This means you can ask "where did this job
come from?" and walk back through the chain — useful when a job has been redriven three
times and you want to see the original failure.

Retention respects that chain: a failed job with a descendant won't be cleaned up while the
descendant exists, so the trail doesn't develop holes.

## Clicking twice

Every redrive request carries an id. Repeat the same request and you get back the job that
already exists, rather than a second copy. An impatient operator clicking twice doesn't run
the work twice.

Sending the _same_ request id with a different reason or a different person attached is
treated as a conflict, not a duplicate — those are two different claims about what happened,
and silently keeping one would lose an audit record.

## Bulk redrive

You can redrive a page of failed jobs at once, oldest first, with a cursor so you can work
through a backlog in chunks without redoing what you've already done. There's a dry-run mode
that tells you what _would_ happen and writes nothing — worth using before you replay a few
thousand jobs into a service that may still be unhealthy.

## Attribution is not permission

The person and reason recorded on a redrive are for the audit trail. Workhorse does not
check whether they were allowed to do it. That check belongs in your application, before you
call redrive.

## Next

- [110-retries.md](110-retries.md) — the automatic attempts that happen first
- [330-retention.md](330-retention.md) — how long a failed job sticks around
- [010-jobs-and-state.md](010-jobs-and-state.md) — why the failed job is still there at all

---

Exact lineage columns, copy rules, and conflict shape:
[`architecture.md`](../architecture.md#job_redrive).
