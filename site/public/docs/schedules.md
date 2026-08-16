# Schedules

> Synchronize named cron definitions during deployment and let any matching worker fire them safely.

Some work runs on a clock: a nightly report, an hourly sync, a weekly cleanup. The usual costs are
a separate scheduler process to deploy and keep alive, and a duplicate-firing problem the moment
you run more than one of them. Workhorse has neither. Schedules are cron definitions stored in
PostgreSQL, declared by your deployment, and evaluated by the workers you already run — any number
of which can race on the same occurrence and still create exactly one job.

## Synchronize the namespace

Call `queue.syncSchedules` during deployment with every definition the namespace should contain.
It is a desired-state call, like a migration: definitions you list are created or updated, and
with pruning enabled — the default — definitions you dropped from the list are disabled.

```ts
await queue.syncSchedules("billing-production", [
  {
    name: "invoice-run",
    schedule: "0 2 * * *",
    job: {
      type: "invoice.generate",
      queue: "billing",
      payload: { scope: "due" },
      maxAttempts: 5,
    },
  },
]);
```

Disabled, not deleted: the old definition stays, so jobs it fired in the past still have something
to point at.

Each `ScheduleDefinition` names the occurrence (`name`, `schedule`, optional `enabled`) and
describes the job every occurrence creates — its `type`, `payload`, and optionally `queue`,
`concurrencyKey`, `maxAttempts`, and `retryPolicy`.

The namespace keeps one service's schedules apart from another's, so two deployments sharing a
database cannot prune each other's definitions. Cron validation happens before the write; one
invalid expression fails the call rather than leaving a partial deployment. Pass
`{ prune: false }` only when you deliberately want an additive update — the normal deployment path
supplies the complete namespace so code remains the owner of intent.

## Let workers evaluate schedules

There is no scheduler process and no PostgreSQL extension. A `Worker` evaluates the namespaces
listed in `WorkerOptions.scheduleNamespaces` as part of its normal maintenance cadence.

```ts
const worker = new Worker(queue, {
  scheduleNamespaces: ["billing-production"],
});
```

A worker with an empty list fires nothing. Point at least one worker at each namespace you
synchronize, or its schedules sit idle.

## Why competing workers create one job

Ten workers all notice the 02:00 occurrence is due. Each firing writes a durable key built from
the namespace, schedule name, and planned occurrence time. The first worker claims the key; every
other call converges on the job that already exists. No leader election, no single scheduler — any
number of workers can race and the outcome is one job.

Rolling deployments are covered the same way. Every definition carries a revision that increments
on change. A worker still holding yesterday's definition passes the old revision when it fires,
and PostgreSQL turns that stale call into a no-op — an old worker cannot fire yesterday's cron
expression during a deploy.

If the whole fleet is down, nothing fires. When workers return, catch-up is bounded rather than
replaying every missed occurrence. Schedules provide durable recurring work, not hard real-time
alarms; prefer UTC cron expressions, since daylight saving makes local-time schedules ambiguous
twice a year.

## What happens after firing

The occurrence creates an ordinary job with the definition's queue, payload, attempt budget, and
retry policy. From there the usual rules apply — at-least-once delivery, retries, cancellation.
Canceling one fired job does not disable its definition; tomorrow's occurrence still runs. Disable
future occurrences through the next synchronization.

Three related calls round out the API:

- `queue.schedules(namespaces)` reads stored definitions and their last occurrence, for operator
  tools.
- `queue.runTaskNow(jobId)` releases one scheduled job immediately — useful for "run it now"
  buttons on a fired-but-delayed occurrence.
- `queue.fireSchedule(namespace, name, revision, occurrenceAt)` exposes the revision-fenced firing
  operation itself, for tests and controlled integrations.

## Next

- [Workers](/docs/workers) — run the process that evaluates namespaces
- [Retries](/docs/retries) — control failures of each fired job
- [Cancellation](/docs/cancellation) — stop one occurrence without changing the schedule

---

Exact reconciliation, cron, revision, and occurrence semantics:
[architecture reference](https://github.com/stablemates/workhorse/blob/main/docs/architecture.md#declarative-schedules).
