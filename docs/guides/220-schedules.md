# Recurring tasks on a cron schedule

Some work runs on a clock: a nightly report, an hourly sync, a weekly cleanup. Workhorse
runs these from cron definitions stored and evaluated in PostgreSQL. Workers offer the cadence.

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
      schedule: nightlyCron,
      timezone: "America/New_York",
      catchupPolicy: "skip",
      task: { type: "generate-invoices", payload: {} },
    },
  ],
  { prune: true },
);
```

This is a desired-state call, like a database migration. Run it on deploy. Definitions you
list are created or updated; definitions you've dropped from the list get disabled.

Note _disabled_, not deleted. The old definition stays so the tasks it fired in the past
still have something to point at.

The **namespace** keeps one deployment's schedules separate from another's, so two services
sharing a database don't prune each other's definitions.

The `enabled` field belongs to deployment configuration. The dashboard's Pause action creates a
separate operator override, so later synchronization cannot resume the schedule. A paused schedule
stays paused when a deployment updates, removes, or re-adds its definition. Resume it explicitly
from the dashboard.

## Choosing what happens after a gap

Workhorse skips missed occurrences by default. A worker evaluates the current maintenance window,
then waits for the next occurrence. This prevents a schedule pause or worker outage from creating
a task backlog.

Set `catchupPolicy` to `latest` when one current task can replace the missed work. Set it to `all`
when every occurrence must create a task. The worker's catch-up limit bounds each `all` pass, and
later passes continue until the schedule catches up.

## Why it can't fire twice

Several workers are running. They all offer the same namespace when the schedule may be due.

Only one task is created. Each firing writes a durable key built from the namespace, the
schedule name, and the planned occurrence. The first worker to get there claims the key; the
others find it taken and receive no task id, because they didn't create the task.

You don't have to elect a leader or run exactly one scheduler. Any number of workers can
race and the outcome is one task.

TypeScript workers select definitions with `scheduleNamespaces`. Python workers use
`schedule_namespaces`, and Go workers use `WorkerOptions.ScheduleNamespaces`. Each worker asks
`fire_due_schedules_v2` to evaluate the namespaces it offers. PostgreSQL coordinates each
namespace, so different namespace sets can make progress independently.

Workers offer namespaces, not private copies of schedule definitions. PostgreSQL stores the current
definitions, so workers that offer the same namespace always evaluate the same desired state. The
dashboard shows how many live workers can evaluate each namespace.
Open an application schedule's run count to view tasks of that type in a new browser tab.

The dashboard also lists Workhorse maintenance beside application schedules. Maintenance runs
directly in PostgreSQL instead of creating a task. Its last-run value records that direct execution.
Expand a maintenance row to inspect recent outcomes, durations, affected rows, phase timings, and
errors. The row reports the retained total while the expanded history identifies its recent subset.
It also states that Workhorse samples successful task-changing ticks and records tick errors
immediately. Workhorse records every eligible slow-routine execution.

## Deploys don't cause duplicates either

Every definition carries a revision that increments when you change it. PostgreSQL reads that
revision while evaluating the namespace, then requires the same revision when it reserves the
occurrence. If a deployment changes or disables the definition between those operations, the fire
becomes a no-op.

## Things to know

- **Schedules only fire while a worker is running** with a matching namespace. When workers
  return, the definition's catch-up policy decides whether Workhorse skips, coalesces, or replays
  missed occurrences.
- **Firing waits for the next maintenance tick.** This is not a real-time scheduler.
- **PostgreSQL decides what time it is.** Worker clocks drift apart, so Workhorse asks the database
  for the evaluation instant. A worker running ahead fires nothing early, and a worker running
  behind moves no schedule backwards.
- **An occurrence another transaction holds is deferred, not skipped.** Workhorse leaves that
  occurrence and everything after it to the next tick. So a manual fire that rolls back loses
  nothing: the next tick creates the task the abandoned one didn't.
- **Store the intended IANA timezone** on each definition. UTC avoids clock changes. If local clocks
  skip a scheduled time, Workhorse fires after the clock advances. If clocks repeat a time,
  Workhorse fires its first occurrence only. If several fields land on one instant, Workhorse
  creates one occurrence.
- **Hashed fields stay stable across worker languages.** An `H` field spreads schedules to a
  repeatable offset, so TypeScript, Python, and Go workers agree on the same occurrence.
- **Cancelling one fired task doesn't disable the schedule.** The definition and the tasks it
  creates have separate lifecycles — tomorrow's occurrence still runs.

## Next

- [210-enqueue-idempotency.md](210-enqueue-idempotency.md) — the same deduplication idea
- [310-workers.md](310-workers.md) — which processes offer schedule namespaces
- [120-cancellation.md](120-cancellation.md) — cancelling a single occurrence

---

Exact reconciliation and revision-fencing rules:
[`architecture.md`](../architecture.md#declarative-schedules).
