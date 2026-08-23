# ADR 0036: Keep slow maintenance orchestration in PostgreSQL

- **Status:** Accepted
- **Date:** 2026-08-22
- **Amends:** [ADR 0011](0011-daily-retention-and-split-maintenance.md)
- **Reaffirms:** [ADR 0004](0004-two-cadence-maintenance.md)

## Context

ADR 0011 gave each slow maintenance task its own cadence, advisory lock, and persisted due state.
TypeScript still owned the order for calling those tasks.

Go and Python called only `tick_v1` from their worker loops.
Fleets without a TypeScript worker never rolled up statistics, replenished partitions, retired history, or pruned terminal storage and worker registrations.

ADR 0004 requires SQL to own orchestration so every client gets identical semantics.
The language-local sequence violated that boundary and made TypeScript an undeclared operational dependency.

## Decision

`run_maintenance_v1(p_now)` is the one worker entry point for slow maintenance.
It calls `rollup_stats_v1`, `prepare_history_partitions_v1`, `retain_history_v1`, `prune_terminal_storage_v1`, then `prune_worker_registry_v1`.

Statistics run first because retention stops at the rollup watermark.
The same pass can summarize raw history before it removes history that has become safe.

Each existing function keeps its due check and transaction advisory lock.
`run_maintenance_v1` does not merge slow work into `tick_v1`, so slow cleanup cannot delay promotion or recovery.

Each existing maintenance function keeps its phase-level exception isolation and telemetry.
An unexpected top-level failure from the first four functions still rejects the pass.
Worker registry pruning is last and uses the existing automatic one-minute stale window.
The orchestrator catches only its failure.

TypeScript, Python, and Go workers call the orchestrator.
Language code may record or present phase telemetry, but it does not choose the sequence.

## Consequences

Any supported worker fleet now performs complete housekeeping without a TypeScript process.
Adding another language requires one stable SQL call instead of reproducing the task graph.

Workers still offer cheap calls more often than most tasks are due.
PostgreSQL owns eligibility, so more callers do not multiply completed work.

The orchestrator adds a protocol function that clients must pin and test.
The shared SQL scenario verifies its phase order in TypeScript, Python, and Go.

## Validation

Acceptance requires the shared protocol scenario and one worker-level participation test in every supported language.
The schema check must also prove the generated clean-install artifact contains the function.
