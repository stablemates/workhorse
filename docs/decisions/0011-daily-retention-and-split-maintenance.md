# ADR 0011: Daily retention and split scheduled maintenance

- **Status:** Accepted
- **Date:** 2026-08-02
- **Supersedes:** [ADR 0004](0004-two-cadence-maintenance.md)
- **Amends:** [ADR 0007](0007-automated-retention.md)

## Context

Weekly history partitions and one monolithic housekeeping call mismatched the intended operating model. A configurable 14-day hot-history window makes daily partitions useful for precise rolling retention, while a four-week future horizon and minute-by-minute execution are unnecessary. Partition preparation, history retirement, and terminal cleanup also have different useful cadences and failure domains.

Removing reverse foreign keys from partitioned history avoids PostgreSQL parent-deletion probes across every child partition, but removes the database's automatic protection against orphan history. Terminal cleanup therefore needs an explicit correctness interlock rather than a best-effort absence query.

The project is preproduction. There are no supported live schemas to migrate, so schema version 12 may replace the clean-install contract without compatibility wrappers or data migration.

## Decision

### Daily UTC history

`job_event` and `attempt_history` use UTC-daily range partitions with default fallbacks. Clean installation and `prepare_history_partitions_v1` maintain the current day plus three future days. Explicit `create_history_day_v1` and `retire_history_day_v1` functions serialize work per date, repair a missing half of the event/attempt pair, and move matching fallback rows when creating a partition.

Every retention category defaults to 14 days and remains independently configurable through the persisted retention policy. Null still disables a category. Retention drops only completed daily partitions wholly before the category cutoff and bounded-deletes eligible default rows.

### Three independent maintenance tasks

The slow maintenance surface is split into three SQL entry points:

1. `prepare_history_partitions_v1` defaults to every six hours.
2. `retain_history_v1` runs once per local date at or after 03:00 and retires event, attempt, and schedule-occurrence history.
3. `prune_terminal_storage_v1` defaults to every five minutes and orders expired idempotency cleanup before terminal identity cleanup.

Each task has its own transaction-scoped advisory lock, persisted last-run state, exception-isolated phase telemetry, and a `force` option for explicit operation and tests. Workers poll task eligibility every minute by default, but PostgreSQL owns the global due decision, so task frequency does not multiply with worker count. `housekeep_v1` and `Queue.housekeep()` are removed rather than preserved because no production compatibility boundary exists.

One singleton maintenance policy stores a validated IANA timezone, task intervals, and the local history-retention hour. IANA names preserve geographic daylight-saving rules instead of freezing a numeric UTC offset. The daily task executes once for each local calendar date after the configured hour, including DST transition dates.

### Attribution safety without reverse history foreign keys

History inserts run through a trigger that locks and verifies the parent job before insertion. The trigger advances `job_outcome.history_through_at` for terminal jobs and moves the global retained-through watermark backward if late history is inserted into an already-cleared range.

`retain_history_v1` advances `maintenance_state.history_retained_before` only after both event and attempt history have no eligible partition or fallback row before their respective cutoffs. `prune_terminal_storage_v1` may select a terminal identity only when its retention windows have elapsed and its history boundary is behind that watermark. Schedule occurrences remain explicit deletion guards. `purge_queue_v1` explicitly deletes associated event and attempt rows before deleting queued identities.

The Workhorse schema is package-owned. Direct application deletion from `workhorse.job` is unsupported because it bypasses the terminal watermark and explicit purge cleanup. The chance of orphan history is therefore low through supported APIs but real for privileged ad hoc SQL or a future deletion path that omits history cleanup. Integration tests cover terminal cleanup, late inserts, concurrent insertion, and queue purge to keep every supported path honest.

## Consequences

### Positive

- A configurable rolling window has at most one day of partition-granularity over-retention.
- Three future partitions tolerate delayed maintenance without maintaining weeks of empty relations.
- Maintenance cadence and failures are isolated by concern while PostgreSQL remains the scheduling authority.
- Daily local-time cleanup is globally consistent and DST-aware.
- Terminal cleanup is frequent without scanning all history or racing daily retirement.
- Removing reverse history foreign keys avoids per-partition parent-deletion probes as partition count grows.

### Negative

- Daily partition counts are about seven times weekly counts, increasing catalog objects and DDL frequency.
- Correct terminal cleanup depends on the retained-history watermark and insert trigger remaining correct.
- Privileged direct SQL can violate package invariants that foreign keys previously enforced.
- A singleton timezone means all Workhorse maintenance in one database shares one operating calendar.
- Workers still perform cheap eligibility calls every minute; a future dedicated maintenance leader may be useful at very high worker counts.

## Future direction

Fourteen-day raw retention does not provide long-term product analytics. A later rollup system should materialize bounded hourly and daily aggregates with idempotent late-data recomputation and its own mandatory watermark before raw deletion. Optional cold export can then consume finalized raw history or aggregate buckets without coupling dispatch to object storage. Neither capability is part of schema version 12.

## Validation

Acceptance requires clean schema installation, current-plus-three partition coverage, partial-pair repair, independently rate-limited tasks, forced execution, task-lock isolation, IANA validation, DST scheduling, default and customized retention, watermark advancement and rollback on late inserts, concurrent history insertion versus terminal cleanup, explicit queue-purge history cleanup, health diagnostics, dashboard maintenance entries, development demo reset, packed consumers, and the complete repository gate.
