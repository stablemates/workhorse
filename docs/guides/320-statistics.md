# Counting things without melting the database

The dashboard needs to answer questions like "how many jobs failed in the last hour?" This
guide explains why that's harder than it sounds, and how Workhorse does it.

## The problem

The obvious way is to count the raw event log every time someone asks. That works on day
one and gets slower every day, because the log only grows.

Worse, it's backwards: a dashboard that auto-refreshes would cost more the busier your
system is. Exactly when you most want to look at it, looking at it hurts most.

## Pre-computed minutes

So Workhorse keeps a running summary instead: one row per minute, per queue and job type.
Each row holds counts for that minute — how many were enqueued, succeeded, failed — plus
the last error seen, which is what lets a dashboard name a likely cause without touching the
history tables at all.

Two different things get counted, and they're kept separate on purpose:

- **Jobs** — a job that retried four times and then succeeded counts as _one_ success.
- **Attempts** — the same job contributes _five_ attempts.

Conflating those is how you end up with a "failure rate" over 100%.

## Filling them in

A background pass runs about once a minute, summarises the minutes that have fully elapsed,
and records how far it got. That marker is the **watermark**.

When you ask for a time window, Workhorse reads pre-computed rows below the watermark and
calculates the rest live. So a window is correct the instant a job runs — you never wait for
a rollup to see your own work. If the rollup falls behind, you get a longer live section and
a slower query, not a wrong answer.

Each pass also redoes the last few minutes. A transaction that commits its history row just
after its minute closed gets picked up by the rewrite instead of being lost, and running the
pass twice produces the same numbers rather than double counting.

## Why the watermark protects history

Here's the part that connects to cleanup. A summary row can only ever be rebuilt by
re-reading the raw history it came from. Delete the history first and those numbers are gone
permanently.

So retention is not allowed to delete anything the rollup hasn't summarised yet. A stuck
rollup makes history pile up rather than making data disappear — visible as growing lag on
the health page, annoying but fixable. The alternative would be a silent hole in your
numbers, which isn't.

## Cardinality

If your job types are generated rather than fixed — one per customer, say — the number of
summary rows could grow without limit. Beyond a threshold, extra combinations are folded
into a catch-all type within their own queue. You lose the per-type breakdown for the long
tail; you don't lose the totals, and the table stays bounded.

## Turning it off

Set the rollup interval to zero and every window is computed live from raw history. Correct,
slower, and history retention stops advancing. The interval is maintenance policy stored in the
database beside the other cleanup cadences, so zero opts out the whole fleet at once rather than
one process. Reasonable for a small deployment; not for a busy one — and the settings page will
say so while retention depends on the watermark.

## Next

- [330-retention.md](330-retention.md) — the cleanup this interlocks with
- [310-workers.md](310-workers.md) — who runs the rollup pass
- [010-jobs-and-state.md](010-jobs-and-state.md) — where the raw history lives

---

Exact measures, bucket definition, and health fields:
[`architecture.md`](../architecture.md#job_stat_bucket-and-job_stat_state).
