# ADR 0110: Export maintenance freshness and retention lag from the metrics observer

- **Status:** Accepted
- **Date:** 2026-10-23
- **Related:** [ADR 0024](0024-metrics-instrument-lifecycle.md),
  [ADR 0048](0048-extract-typescript-opentelemetry-adapter.md),
  [ADR 0054](0054-define-what-1-0-0-promises.md)
- **Issue:** SM-1674 (OPS-07)

## Context

PostgreSQL records when each maintenance routine last completed, in `maintenance_state` and
`task_stat_state`. `queue_health_v1` computes the retention lag of each history category and
compares it with a budget. No OpenTelemetry metric exports these values.

The `workhorse.maintenance.*` counters and histograms record only when a routine runs. Thus a
routine that stops running records nothing, and an alert on those instruments cannot fire. A
project review of 2026-10-22 found this gap.

ADR 0054 makes every telemetry name a public contract and lets a release add a name. These are the
first maintenance freshness names and the first `workhorse.retention.*` names, so this record states
them.

## Decision

**`WorkhorseMetricsObserver` records five synchronous gauges from database state.**

| Name                                    | Unit | Attribute                       | Value                                              |
| --------------------------------------- | ---- | ------------------------------- | -------------------------------------------------- |
| `workhorse.maintenance.routine.age`     | `s`  | `workhorse.maintenance.routine` | Time since the routine last completed              |
| `workhorse.maintenance.routine.overdue` | `s`  | `workhorse.maintenance.routine` | Time past the next due time, or 0                  |
| `workhorse.retention.lag`               | `s`  | `workhorse.retention.category`  | The retention lag that `queue_health_v1` computes  |
| `workhorse.retention.lag_budget`        | `s`  | `workhorse.retention.category`  | The queue health budget for that lag               |
| `workhorse.retention.enabled`           | `1`  | `workhorse.retention.category`  | 1 when the category has a retention window, else 0 |

The attribute values are the existing names:

- `workhorse.maintenance.routine` is a `maintenance_state.routine_name` value (`tick`,
  `history_partitions`, `history_retention`, `terminal_storage`) or `statistics_rollup`.
- `workhorse.retention.category` is a `category` value of the `retention-lag` health reason
  (`taskIdentity`, `terminalOutcome`, `taskEvents`, `attemptHistory`, `scheduleOccurrences`,
  `statistics`).

The units are seconds, as for `workhorse.queue.oldest_ready.age`, the other time gauge of the
observer.

**The cardinality is fixed at 28 series for each database.** Five routines have two gauges each,
and six categories have three gauges each. No queue, worker, or task value becomes an attribute.

**The observer computes each value from stored times and the database clock.** A routine that
stops running, or that fails each run, keeps its stored completion time. Its age therefore grows
at each collection, with no new phase error. Each due time follows the gate of the routine's
scheduler, so the overdue time is more than 0 only when the scheduler would run the routine.

A synchronous gauge keeps its last value until something records again. If the observer stops
collecting while its process runs, the age stays the same. If the process exits, the series have no
data. An alert on a tick age that has no data or does not change detects both cases.

**The observer reads these values on a slower interval.** The `maintenance_observer` statement in
`protocol/v1/manifest.json` calls `queue_health_v1`, which scans the retention boundaries. The
observer runs it every `maintenanceIntervalMs`, 60,000 by default, and the queue and worker
queries every `intervalMs`. The statement reads `maintenance_state`, `maintenance_policy`,
`retention_policy`, and `task_stat_state` directly. Their columns that the statement names are
therefore part of `protocol/v1/governed-surface.json`.

**The scope is TypeScript only.** `WorkhorseMetricsObserver` is a TypeScript class, and ADR 0048
places the OpenTelemetry adapter in TypeScript. The other SDKs record no observer gauges.

## Consequences

An operator can alert on a routine that stops running, and can tell an overdue routine from a
disabled retention category. `docs/architecture/telemetry.md` gives the alert examples.

A renamed gauge, attribute, or attribute value, or a changed unit, is breaking under ADR 0054.

For `scheduleOccurrences`, the health reason also waits until the daily history pass is due. The
gauge can therefore pass its budget for up to one day before the health reason appears.

## Rejected alternatives

**Run the maintenance query on the queue interval.** `queue_health_v1` costs more than the queue
query, and maintenance state changes on a scale of minutes.

**Add a SQL function that computes only the maintenance values.** That needs a migration, and it
duplicates the retention lag rules of `queue_health_v1`, which then could drift apart.

**Record the gauges in every SDK.** No other SDK has an observer, and one observer for each
database is sufficient.
