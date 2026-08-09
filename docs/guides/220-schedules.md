# Recurring jobs on a cron schedule

Some work runs on a clock: a nightly report, an hourly sync, a weekly cleanup. Workhorse
runs these from cron definitions stored in your database, evaluated by your workers.

There is no separate scheduler process to deploy or keep alive.

## Declaring schedules

You don't create schedules one at a time. You declare the full set you want and Workhorse
makes the database match:

```ts
await queue.syncSchedules(
  "billing", // namespace
  [
    {
      name: "nightly-invoice-run",
      schedule: "0 2 * * *",
      job: { type: "generate-invoices", payload: {} },
    },
  ],
  { prune: true },
);
```

This is a desired-state call, like a database migration. Run it on deploy. Definitions you
list are created or updated; definitions you've dropped from the list get disabled.

Note _disabled_, not deleted. The old definition stays so the jobs it fired in the past
still have something to point at.

The **namespace** keeps one deployment's schedules separate from another's, so two services
sharing a database don't prune each other's definitions.

## Why it can't fire twice

Ten workers are running. All ten know the schedule. At 02:00 all ten notice it's due.

Only one job is created. Each firing writes a durable key built from the namespace, the
schedule name, and the occurrence second. The first worker to get there claims the key; the
others find it taken and get back the id of the job that already exists.

You don't have to elect a leader or run exactly one scheduler. Any number of workers can
race and the outcome is one job.

## Deploys don't cause duplicates either

Every definition carries a revision that increments when you change it. A worker that loaded
the old definition passes the old revision when it fires, and a firing with a stale revision
does nothing.

So during a rolling deploy, an old worker that still has yesterday's cron expression in
memory can't fire yesterday's schedule. It just becomes a no-op.

## Things to know

- **Schedules only fire while a worker is running** with a matching namespace. Nothing fires
  if the whole fleet is down; when workers come back, catch-up is bounded rather than
  replaying every missed occurrence.
- **Precision is about a second**, and firing waits for the next maintenance tick. This is
  not a real-time scheduler.
- **Use UTC** for cron expressions unless you have a specific reason not to. Daylight saving
  makes local-time schedules ambiguous twice a year.
- **Cancelling one fired job doesn't disable the schedule.** The definition and the jobs it
  creates have separate lifecycles — tomorrow's occurrence still runs.

## Next

- [210-enqueue-idempotency.md](210-enqueue-idempotency.md) — the same deduplication idea
- [310-workers.md](310-workers.md) — who actually evaluates the cron expressions
- [120-cancellation.md](120-cancellation.md) — cancelling a single occurrence

---

Exact reconciliation and revision-fencing rules:
[`architecture.md`](../architecture.md#declarative-schedules).
