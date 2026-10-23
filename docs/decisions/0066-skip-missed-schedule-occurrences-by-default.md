# ADR 0066: Skip missed schedule occurrences by default

- **Status:** Accepted
- **Date:** 2026-09-14
- **Amends:** [ADR 0038](0038-evaluate-cron-occurrences-in-postgresql.md)

## Context

The original schedule evaluator treated every occurrence after the last fired occurrence as due.
A catch-up limit bounded each maintenance pass, but later passes continued through the backlog.
After a schedule pause or worker outage, this could enqueue old tasks that no longer had value.

The fired occurrence history cannot record skipped occurrences. Retention can also delete that
history, so it cannot be the schedule's durable evaluation position.

## Decision

Each schedule definition stores a catch-up policy and a durable `last_evaluated_at` position.
`skip` is the default. It evaluates only the current maintenance window and advances the position
to the evaluation time, so older occurrences do not become tasks.

Applications can select `latest` to enqueue the most recent missed occurrence. They can select
`all` to enqueue every missed occurrence in batches bounded by the worker's catch-up limit.

`fire_due_schedules_v2` receives the worker's maintenance interval as the current evaluation
window. `sync_schedule_definitions_v2` stores the policy. `set_schedule_paused_v1` advances a
`skip` schedule when an operator resumes it. The version 1 schedule functions remain available for
clients that use SQL protocol 1 during a rolling upgrade.

## Consequences

- A schedule does not create a backlog unless its definition selects `latest` or `all`.
- Schedule occurrence retention cannot cause old work to replay because evaluation has its own
  durable position.
- A worker that uses SQL protocol 1 keeps the old catch-up behavior until that worker is upgraded.
- Schema migration 2 initializes existing definitions at the migration time, so the upgrade does
  not enqueue an existing backlog.

## Amendment: `skip` fires within a supported delay (2026-10-23)

The Decision section first said that `skip` evaluates only the current maintenance window. This
amendment supersedes that sentence.

A worker waits one maintenance interval after its schedule pass ends. Thus the gap between two
passes is always longer than one interval, and an occurrence in the extra time never fired
(SM-1644). From schema version 82, `skip` continues from `last_evaluated_at`, as `latest` and `all`
do. It fires each occurrence that is not older than the supported delay,
`GREATEST(60 seconds, 2 × evaluation_window_ms)`. It skips only older occurrences, and it records
each skip in `last_skipped_at`, `last_skipped_count`, and `last_skipped_through` on the definition
row. The count stops at 10,000.

`fire_due_schedules_v2` keeps its signature and its result shape. The worker still supplies its
maintenance interval as the evaluation window. A pause or an outage longer than the supported delay
still does not make a backlog.
