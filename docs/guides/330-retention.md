# Cleaning up old data without losing the audit trail

A busy queue produces an enormous amount of history. Every state change is an event, every
finished attempt is a row. Left alone, those tables become most of your database.

Retention deletes the old ones. Doing that safely is more subtle than a nightly `DELETE`.

Every worker runtime offers the same slow maintenance pass through `run_maintenance_v1`.
PostgreSQL orders statistics, partition preparation, retention, terminal cleanup, and registry
cleanup, while each task keeps its own due check and lock. A fleet that runs only Python or Go
therefore keeps the same evidence and partition guarantees as a TypeScript fleet.

## Windows are minimums, not deadlines

You configure how long to keep each category of data — finished jobs, outcomes, events,
attempts, schedule occurrences, statistics. Each defaults to a couple of weeks and can be
set independently. Setting one to null disables cleanup for that category entirely.

The important word is _minimum_. A two-week window means "don't delete anything younger
than two weeks". It does not mean everything older disappears promptly. Cleanup runs in
bounded batches, works a day at a time, and skips anything still referenced. Real retention
is always somewhat longer than configured, and that's by design — it errs toward keeping
evidence.

## Deleting by the day, not by the row

Events and attempts are stored in daily partitions. Cleanup mostly doesn't delete rows at
all: it drops whole days once every row in them has expired, which is close to free
regardless of how many rows the day held.

Dropping a table needs an exclusive lock, so the pass gives up after a moment rather than
queueing behind live traffic and stalling dispatch. It'll try again next time.

## The ordering rules

Three constraints stop cleanup from destroying its own evidence.

**A job outlives its history.** The job identity is the thing everything else points at, so
its window must be at least as long as every window that depends on it. Configure it shorter
and Workhorse rejects the configuration rather than letting you orphan an audit trail.

**Nothing is deleted before it's been summarised.** Statistics can only be rebuilt from raw
history, so cleanup won't pass the statistics watermark. See
[320-statistics.md](320-statistics.md).

**A job with descendants stays.** If a failed job was [redriven](340-redrive.md), it's the
parent of another job, and deleting it would break the lineage. It waits until the child is
gone too.

## Statistics are the exception

Summary rows are the one category _not_ bound by "keep the job at least as long". That's
intentional. A summary describes many jobs rather than pointing at one, so keeping a year of
aggregates after the underlying jobs are gone is a perfectly sensible configuration — often
the one you want.

## When it doesn't keep up

Cleanup is deliberately bounded: a limited number of jobs, partitions, and rows per pass. If
the incoming rate outruns it, tables grow. This shows up as retention lag in queue health
rather than as a stall, and the fix is usually a shorter window rather than a bigger batch.

Health also reports how many rows are sitting in the fallback partitions used when partition
maintenance falls behind, so that condition can't stay invisible.

## Don't delete jobs yourself

It's tempting to write your own `DELETE FROM job WHERE ...`. Don't. The cleanup functions
exist to enforce the ordering rules above, and raw SQL bypasses all of them — leaving
history that points at nothing and statistics that can never be rebuilt.

## Next

- [320-statistics.md](320-statistics.md) — the watermark that gates cleanup
- [340-redrive.md](340-redrive.md) — why some failed jobs stay longer
- [010-jobs-and-state.md](010-jobs-and-state.md) — which tables hold what

---

Exact windows, bounds, and health fields:
[`architecture.md`](../architecture.md#retention_policy).
