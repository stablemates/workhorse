# ADR 0038: Evaluate cron occurrences in PostgreSQL

- **Status:** Accepted
- **Date:** 2026-08-22
- **Amends:** [ADR 0003](0003-worker-owned-scheduler.md)
- **Related:** [ADR 0025](0025-worker-schedule-cadence.md)

## Context

ADR 0003 removed `pg_cron` and put occurrence evaluation in each worker runtime. TypeScript,
Python, and Go then used different parser libraries with different macros, special day fields, and
daylight-saving behavior. Shared fixtures exposed part of the drift, but every SDK still carried a
second source of cron semantics.

The database already owns definitions, revision fences, occurrence keys, and enqueue. It can
evaluate a declarative expression without owning a timer or background process.

## Decision

PostgreSQL owns deterministic occurrence evaluation through `cron_occurrences_v1`. The function
implements the dialect in `protocol/v1/cron.md`, reads each definition's persisted IANA timezone,
and returns bounded occurrences after the last durable key. `sync_schedule_definitions_v1`
validates both the expression and timezone before it changes desired state.

`fire_due_schedules_v1` lists matching definitions, evaluates them, reserves occurrence keys, and
enqueues due jobs in one call. Workers retain cadence ownership: after winning the existing
maintenance tick, a worker offers its namespaces and current time to this function. No database
extension, timer, daemon, or second control plane is added.

The TypeScript, Python, and Go cron libraries are removed. Their worker loops call the same SQL
function, so a language runtime cannot reinterpret a stored definition.

## Consequences

- Every SDK shares one cron dialect, timezone rule, and catch-up implementation.
- Schedule firing uses one database round trip per maintenance pass instead of one aggregate plus
  one call per occurrence.
- PostgreSQL does more deterministic CPU work during a schedule pass, bounded by the catch-up limit
  and search horizon.
- ADR 0003 point 2 changes from in-process parsing to worker-triggered database evaluation.
- ADR 0025 remains in force because workers still decide when evaluation runs. Its extension and
  control-plane concern applies to cadence, not to a plain function in the `workhorse` schema.
