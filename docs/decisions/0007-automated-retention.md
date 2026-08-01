# ADR 0007: Persisted, attribution-safe automated retention

- **Status:** Accepted
- **Date:** 2026-08-01
- **Amends:** [ADR 0004: Two-cadence maintenance split](0004-two-cadence-maintenance.md)

## Context

Weekly event and attempt partitions already keep claim cost proportional to live work, and housekeeping precreates the current week plus four future weeks. Retiring a completed week, however, is a manual paired operation. Schedule occurrences are the only history deleted automatically. Stable job identities, terminal outcomes, checkpoints, and waits otherwise grow without bound.

A retention implementation must satisfy constraints that generic age-based deletion does not:

- every accepted job must continue to have exactly one live runtime or one terminal outcome;
- live jobs must never be retention candidates;
- retained events, attempts, and schedule occurrences must not lose their stable job attribution;
- checkpoints and waits cannot be deleted while their retryable parent identity remains, because doing so could repeat a completed durable boundary;
- late history inserts must remain available through default partitions without making those fallbacks permanent unbounded storage;
- multiple workers may run housekeeping, possibly with different process lifetimes, so policy cannot depend on whichever worker happens to acquire the lock;
- partition DDL and row deletion must be bounded and isolated from the dispatch-latency-critical tick.

## Decision

Store one authoritative retention policy in PostgreSQL and synchronize it explicitly through the versioned Workhorse protocol. The policy defines independent minimum retention windows for job identity, terminal outcome, lifecycle events, attempt history, and schedule occurrences, plus per-pass limits for terminal jobs, history partitions, default-partition rows, and schedule occurrences.

Destructive retention is opt-in. Job, outcome, event, and attempt windows default to disabled. Schedule occurrences preserve the existing 30-day bounded default.

### Identity is the attribution anchor

A terminal job may be deleted only when all of the following are true:

1. it has a terminal outcome and no live runtime;
2. both the identity and outcome minimum windows have elapsed;
3. no retained lifecycle event references the job;
4. no retained attempt references the job;
5. no retained schedule occurrence references the job.

Deleting the stable identity then cascades its terminal outcome, checkpoints, and timer waits in the existing schema. This preserves the lifecycle invariant and prevents a retained historical row from becoming unattributable.

Enabling finite identity and outcome retention requires both terminal windows to be finite, finite dependent retention windows, and an identity minimum at least as long as every dependent minimum. PostgreSQL rejects configurations that cannot satisfy those constraints. Windows are minimums rather than deletion deadlines: bounded cleanup, retained attribution, or a long-running job can extend actual retention.

### Independent history retirement

Event and attempt retention run as separate housekeeping phases. Each phase:

- drops only fully expired, completed weekly partitions;
- retires at most the configured number of partitions per pass;
- uses the same per-week advisory-lock namespace as explicit partition creation and retirement;
- bounded-deletes expired rows from its default partition;
- leaves current and partially covered weeks attached.

Separating the two histories allows different minimum windows without requiring a partially retained week to be copied row by row.

### Housekeeping and telemetry

`housekeep_v1` remains the slow-cadence entry point and preserves its existing call shape. Under the existing `workhorse:housekeeping` try-lock it runs partition replenishment, event retention, attempt retention, occurrence retention, and terminal-job retention as individually reported exception-isolated phases. Existing explicit occurrence arguments remain overrides for compatibility; otherwise the persisted policy is authoritative.

Queue health reports the active policy, per-category retention lag, oldest retained boundaries, eligible history partitions, and cumulative default-partition usage. Lag is informational while bounded cleanup catches up. Unsafe policy is rejected at synchronization time rather than surfaced later as best-effort deletion.

## Consequences

### Positive

- Cleanup is automatic, bounded, and consistent across every worker process.
- PostgreSQL remains the authority for policy validation, selection, locking, and deletion.
- Live work and retained lifecycle attribution are protected by query predicates, not operator convention.
- Event and attempt history can use different windows while retaining cheap partition drops.
- Default partitions remain an availability fallback without becoming invisible permanent storage.
- Operators can distinguish healthy bounded catch-up from missing partitions or fallback spill.

### Negative

- Identity retention is constrained by every retained dependent category and can lag behind its nominal window.
- Terminal outcome data remains until the identity itself is safe to delete; the current normalized schema deliberately rejects an outcome-only deletion state.
- Retention adds DDL and deletion phases to housekeeping, increasing the importance of phase telemetry and conservative limits.
- Configuration is persisted mutable state that deployments must synchronize deliberately.

## Rejected alternatives

### Configure retention only through `WorkerOptions`

Different worker deployments could alternate incompatible policies depending on which process acquires housekeeping. Persisting policy in PostgreSQL makes one configuration observable and authoritative.

### Delete outcomes independently from job identity

That would leave an accepted job with neither a live runtime nor a terminal outcome, violating the central lifecycle invariant. Adding a second terminal tombstone model would duplicate authority and is not justified for this feature.

### Cascade-delete terminal jobs by age

Blind cascade would remove checkpoints and waits correctly but could orphan retained events, attempts, or occurrence attribution. Terminal selection must prove those dependents are gone first.

### Scan and delete all history rows

Row-wise deletion scales with lifetime history and gives up the purpose of weekly partitions. Fully expired partitions are dropped, while row deletion is reserved for bounded default-partition cleanup.

### Run retention in `tick_v1`

Partition DDL and cold-history deletion have a different cadence and failure domain from promotion and lease recovery. They remain isolated in housekeeping so cleanup cannot delay dispatch.

## Validation

Acceptance requires live PostgreSQL tests for policy defaults and rejection, independent event and attempt windows, bounded partition and fallback cleanup, terminal-only identity deletion, retained-history and occurrence guards, live-job safety, advisory-lock skip behavior, per-phase error isolation, schema/API mapping, retention lag, oldest retained boundaries, and cumulative default-partition reporting. The lifecycle benchmark must exercise automated housekeeping rather than only the manual retirement primitive.
