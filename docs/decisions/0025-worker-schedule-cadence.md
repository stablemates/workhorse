# ADR 0025: Retain worker-owned schedule cadence

- **Status:** Accepted
- **Date:** 2026-08-12
- **Related:** [ADR 0003](0003-worker-owned-scheduler.md), [ADR 0004](0004-two-cadence-maintenance.md)

## Context

ADR 0003 moved recurring schedule evaluation from `pg_cron` into each `Worker`. PostgreSQL still
owns occurrence deduplication, but a worker's maintenance loop decides when to call
`fire_schedule_v1`.

This design removes an operational dependency, but it makes fire delay depend on the maintenance
cadence and event-loop load. We needed loaded measurements before deciding whether SQL should own
cadence again.

## Measurement

The `schedule-cadence-jitter` lifecycle scenario runs a real `Worker` with its default one-second
`maintenanceIntervalMs`. It synchronizes one every-second schedule, establishes a baseline
occurrence, and samples five later occurrences.

Four handler slots process a self-replenishing queue during the sample window. This keeps dispatch
and PostgreSQL traffic active while the separate maintenance loop evaluates the schedule. The
scenario reads `schedule_occurrence.fired_at - schedule_occurrence.occurrence_at`, then verifies that
every planned second owns one durable occurrence and one job.

The default-profile run completed 1,383 load jobs while it sampled five schedule fires. All six
scenario invariants passed on PostgreSQL 18.4 and Node.js 24.15.0.

| Metric                    | Result     |
| ------------------------- | ---------- |
| Maintenance interval      | 1,000 ms   |
| Fire delay p50            | 953.655 ms |
| Fire delay p95            | 965.518 ms |
| Worst observed fire delay | 965.518 ms |

The full report is
[`docs/benchmarks/results/2026-08-12-schedule-cadence-default.json`](../benchmarks/results/2026-08-12-schedule-cadence-default.json).
It records commit `f86828895f03dcec7214327efcbbb3b1f973279a` with a clean benchmark source tree.

This run measures one development machine and one process. It does not establish a production
latency objective or cover host suspension. It does answer the ownership question: sustained queue
work did not push any observed fire past one maintenance interval.

## Decision

Retain worker-owned recurring schedule cadence. PostgreSQL continues to own durable occurrence
deduplication through `fire_schedule_v1`, while `Worker` continues to own evaluation and catch-up.

The measured worst delay stayed within the configured maintenance interval under continuous load.
Moving cadence into SQL would restore the extension and control-plane costs rejected by ADR 0003
without evidence that process ownership misses the current contract.

Reopen this decision if the product requires a fire-delay objective below one maintenance interval.
Also reopen it if repeated controlled runs show longer delays under supported production load.

## Consequences

- Deployments keep the plain-PostgreSQL topology and do not require `pg_cron`.
- Schedule fire delay remains bounded by worker availability and maintenance cadence rather than a
  database timer.
- The lifecycle suite now preserves loaded cadence evidence through `schedule-cadence-jitter` and
  the `--schedule-samples` override.
- Operators that require tighter timing must lower `maintenanceIntervalMs` within its supported
  range and validate the resulting database load.
