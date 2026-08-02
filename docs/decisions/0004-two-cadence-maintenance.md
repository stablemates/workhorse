# ADR 0004: Two-cadence maintenance split (tick and housekeeping)

- **Status:** Superseded by [ADR 0011](0011-daily-retention-and-split-maintenance.md)
- **Date:** 2026-07-29
- **Amends:** [ADR 0003: Worker-owned in-process scheduling and maintenance](0003-worker-owned-scheduler.md)

## Context

ADR 0003 moved scheduling and maintenance into the worker but kept a single entry point: `maintain_v1` bundled due-job promotion, expired-lease recovery, history-partition replenishment, and schedule-occurrence pruning under one advisory lock, one cadence, and one rolled-up result row.

That boundary coupled work with very different characteristics:

- **Cadence mismatch.** Promotion and recovery need a roughly one-second cadence to bound dispatch and recovery latency. Partition replenishment is a daily concern with a four-week buffer, and occurrence pruning has a 30-day window. Running the slow phases every second wasted per-pass checks and deletes on the hot path.
- **Lock starvation.** With one `workhorse:maintenance` try-lock, a slow pruning or partition pass held the lock while every other worker no-opped, so promotion drift was bounded by the slowest phase rather than by `promote_v1` itself.
- **Failure coupling.** All phases shared one transaction. A pruning error or partition DDL failure rolled back that pass's promotion and recovery, and partition creation took DDL locks inside the transaction dispatch latency depends on.
- **Opaque observability.** One rolled-up row could not attribute latency or failures to a phase.

Ecosystem precedent separates these concerns: good_job splits cron from cleanup, and pg-boss runs maintenance and monitoring on separate loops. Oban goes further with per-concern plugins (Lifeline, Pruner, Cron), each with its own interval.

## Decision

Split maintenance by cadence and failure domain into exactly two versioned SQL entry points. Orchestration stays in SQL so every client gets identical semantics; the finer Oban-style per-phase scheduling was rejected as configuration surface without isolation benefit, because promotion and recovery share cadence, cost profile, relation, and failure domain.

1. **`tick_v1(p_promote_limit, p_recover_limit)`** runs the dispatch-latency-critical phases: bounded due promotion and bounded expired-lease recovery. It takes the transaction-scoped advisory lock `workhorse:tick`; concurrent callers return immediately with `skipped_lock = true`. Workers call it at most once per `maintenanceIntervalMs` (default one second), together with in-process schedule evaluation.
2. **`housekeep_v1(p_occurrence_retention_days, p_occurrence_prune_limit)`** runs the slow phases: history-partition horizon replenishment and bounded schedule-occurrence pruning. It takes the separate advisory lock `workhorse:housekeeping`, so slow housekeeping can never starve the tick. Workers call it at most once per `housekeepingIntervalMs` (default 60 seconds).
3. **Per-phase telemetry.** Both functions return one row per phase: `(phase, rows_affected, duration_ms, skipped_lock, error)`. Phases run inside exception subtransactions, so a partition-repair failure is reported in its `error` column while occurrence pruning still completes, and vice versa.
4. **TypeScript surface.** `Queue.tick()` and `Queue.housekeep()` are thin wrappers over the SQL functions. `WorkerOptions` gains `housekeepingIntervalMs` and an `onMaintenance` telemetry callback; `worker.maintenanceTelemetry()` exposes the latest per-loop, per-phase results. `maintain_v1` and `Queue.maintain()` are removed rather than deprecated because the protocol has no external consumers yet.

## Consequences

### Positive

- Promotion and recovery cadence is now independent of housekeeping cost; a 10,000-row prune cannot delay dispatch.
- Separate advisory locks isolate contention: tick contention is bounded by two cheap `SKIP LOCKED` updates.
- Phase failures are isolated and attributable. Operators see which phase failed, how long each phase took, and whether a pass was skipped by lock contention.
- Two knobs (`maintenanceIntervalMs`, `housekeepingIntervalMs`) keep operator configuration small while matching the two genuinely distinct cadences.
- The primitives (`promote_v1`, `recover_expired_v1`, `create_history_week_v1`, `prune_schedule_occurrences_v1`) remain composable for external schedulers or CLIs.

### Negative

- Two loops and two locks are more moving parts than one call, and the worker now manages two timers.
- Removing `maintain_v1` is a breaking SQL-surface change, acceptable only because no external consumers exist.
- Phase errors are returned as data rather than raised, so callers that ignore telemetry can miss persistent housekeeping failures. The worker's `onMaintenance` callback and `maintenanceTelemetry()` exist to counter this.

## Rejected alternatives

### Keep the single `maintain_v1`

Simplest for operators, but the cadence mismatch, lock starvation, and failure coupling above are structural, not tuning issues.

### Oban-style per-phase scheduling (four functions, four intervals, four locks)

Promotion and recovery both want the same one-second cadence, are both cheap bounded updates on `job_runtime`, and share every failure mode, so separating them doubles hot-path round trips and locks for no isolation gain. Splitting housekeeping further (partitions daily, pruning hourly) adds misconfigurable knobs while partition repair is already a cheap no-op check in the common case.

### TypeScript-owned orchestration

Encoding phase ordering and policy in a `Queue`-level orchestrator would move protocol semantics out of the versioned SQL layer, forcing future non-TypeScript clients to reimplement them. TypeScript methods remain thin delegates.

## Validation

Acceptance requires live PostgreSQL tests for: tick and housekeeping mutual exclusion under concurrent callers with `skipped_lock` reporting, per-phase telemetry row shape and duration accounting, phase-failure isolation (a failing partition repair leaves pruning committed and reported), independent cadence behavior in the worker loop, and unchanged promotion/recovery/pruning/partition semantics relative to the former `maintain_v1`.
