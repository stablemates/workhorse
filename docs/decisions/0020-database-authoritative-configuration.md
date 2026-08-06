# ADR 0020: The database is authoritative for policy, and application sync seeds rather than overwrites

- **Status:** Accepted
- **Date:** 2026-08-06
- **Related:** [ADR 0007](0007-automated-retention.md), [ADR 0011](0011-daily-retention-and-split-maintenance.md), [ADR 0019](0019-derived-rolling-statistics.md), [ADR 0018](0018-framework-neutral-dashboard-host.md)

## Context

Workhorse policy already lives in PostgreSQL: `retention_policy`, `maintenance_policy`, `queue_control`, `schedule_definition`, and the worker pause flag are all database-owned. That was a deliberate choice, and it is why a dashboard mounted in a process that runs no workers can still report and control a fleet.

But policy is _written_ by application code. `docs/operations.mdx` documents calling `syncRetentionPolicy()` and `syncMaintenancePolicy()` from application startup, and both functions overwrite unconditionally. So a database-owned setting is, in practice, owned by whatever the last deploy asserted.

That is fine while nothing else writes those rows. It stops being fine the moment an operator can. An operator who shortens retention during an incident would have the change silently reverted by the next deploy — no error, no audit trail, no indication anything happened. Config drift that reverts on deploy is among the hardest classes of operational bug to diagnose, because the system is correct at every instant and wrong across time.

There is also no surface that shows policy at all. Retention lag is visible, the values that produce it are not, and process-owned options such as `concurrency` and `leaseMs` are invisible to every operator surface. An operator cannot answer "what is this system configured to do" from the dashboard.

## Decision

The database is the authority for policy. Application sync seeds it; it does not assert it.

### `sync*Policy` becomes seed-if-absent

`syncRetentionPolicy()` and `syncMaintenancePolicy()` write only values that have never been set by an operator. An explicit opt-in — a `force` flag, or a separately named apply call — restores the current overwrite semantics for deployments that genuinely want their manifest to win.

This is a breaking change to a documented API, and it is being made now precisely because it is pre-1.0. After the first supported release the same change would strand every deployment that relied on the old behavior.

### Provenance is recorded per setting

Each policy value records whether it was last written by application sync or by an operator. Sync skips operator-set values; the settings surface shows which is which and offers an explicit "revert to application default" that clears the override.

Without provenance the rule "sync does not overwrite" degenerates into "sync never works after the first run," which is worse than what it replaces.

### The boundary stays where it is

The database owns what an operator must change without a deploy and what must be globally consistent across a fleet: retention windows, per-pass work limits, maintenance cadences, timezone, queue pause, worker pause, schedule enablement.

The process keeps what belongs to its own resources: `concurrency`, `leaseMs`, `heartbeatMs`, and the poll intervals. A worker on a large host and one on a small host should not be forced to share them, and a database round trip is the wrong way to learn how many handlers a process may run.

Two things currently sit on the wrong side of that line and move: the rolling-statistics cadence (`WorkerOptions.statisticsRollupIntervalMs`) is a global cadence and belongs in `maintenance_policy` beside the other three, and the rollup's `groupLimit` and `recomputeBuckets` are policy rather than per-process parameters.

### Process-owned settings are shown, not hidden

The settings surface displays process-owned options read-only, with their provenance. A page that presents itself as the system's configuration while silently omitting half of it is worse than no page: it invites an operator to conclude a setting does not exist.

## Consequences

- An operator change survives the next deploy. That is the entire point, and it is also the risk: a forgotten override outlives the person who made it, which is what the provenance display and the revert action exist to mitigate.
- Deployments that manage policy as infrastructure-as-code must opt into overwrite explicitly. This is a real migration cost for anyone already following the documented pattern.
- The settings surface can compute recommendations from measured state rather than restating defaults. The queue already knows its own enqueue rate, retention lag, rollup watermark, partition spill, and HOT-update ratios; the useful advice is derived from those, not from a table of suggested values.
- Editing retention is destructive and irreversible on the next pass, unlike pause, which is not. The surface must not present them identically: destructive changes require an impact preview computed from the same boundary queries health already runs.
- Policy edits reuse the existing operator-mutation contract — `operatorPolicy.supportedMutations` and the actor/reason/requestId/occurredAt audit context from ADR 0018 — rather than inventing a second authorization path.

## Non-goals

- Moving per-process resource options into the database. The boundary above is the decision, not a step toward erasing it.
- A general-purpose key/value settings store. Every policy value stays a typed, constrained column that PostgreSQL validates, exactly as retention and maintenance do today.
- Editing schedule _definitions_ from the dashboard. Definitions are typed application code synchronized by namespace; only their enablement is operator state.
- Runtime reconfiguration of a running worker's concurrency. That is a deployment change, and pausing already covers the incident case.
