# ADR 0001: Live runtime and cold terminal outcome

- **Status:** Accepted
- **Date:** 2026-07-22
- **Schema version:** 2

## Context

Schema version 1 represented a live job across `job_current` plus one of `ready_job`, `scheduled_job`, or `lease`. The split kept individual indexes narrow, but every lifecycle boundary required coordinated writes across multiple mutable relations. Terminal jobs remained in the mutable current-state table, so retained history contributed to ongoing table size and vacuum work.

The pivot must preserve public `Queue`/`Worker` behavior, versioned `_v1` SQL signatures, FIFO claims, fencing, retries, recovery, append-only history, transactional batch enqueue, and coalesced notifications.

## Decision

Use four lifecycle categories:

1. `job` is immutable accepted identity and payload.
2. `job_runtime` is the only mutable row and exists only for scheduled, ready, or active work.
3. `job_outcome` is immutable and exists only for succeeded or terminally failed work.
4. `job_event` and `attempt_history` remain append-only and partitioned.

A committed job has exactly one runtime or one outcome. Terminal transitions delete runtime and insert outcome atomically. No compatibility write views are provided for `job_current`, `ready_job`, `scheduled_job`, or `lease`.

Runtime uses state-specific check constraints and three partial indexes:

- ready FIFO by queue and sequence
- scheduled due time
- active expiry

Claim changes ready to active with one runtime update and appends an event. Heartbeat, retry, and recovery use compare-and-set predicates over state and ownership generation. Retry and recovery increment the attempt in place. Completion and exhausted failure consume the active runtime and insert outcome, attempt history, and event in one transaction.

## Consequences

### Positive

- Dispatch indexes contain only relevant live states.
- Terminal retention cannot bloat ready, scheduled, or expiry indexes.
- One mutable lifecycle relation removes cross-table projection synchronization.
- `getJob` can preserve its public shape by coalescing runtime and outcome.
- The old worker/fence cannot mutate a requeued or terminal generation.

### Negative

- Heartbeats and state transitions concentrate update churn in `job_runtime`.
- Entering or leaving partial indexes prevents every update from being HOT.
- Operator reads must join two possible lifecycle relations.
- A direct online upgrade is not provided by the canonical clean-install schema.
- Existing custom SQL, dashboards, and retention jobs referencing legacy relations must be rewritten.

## Migration risks

A production migration requires a separately designed, rehearsed procedure. Principal risks are:

1. **Cutover consistency:** version 1 rows spread across four tables must map to exactly one runtime or outcome without losing fences, attempts, run times, results, or errors.
2. **Concurrent writers:** old functions cannot write during backfill unless dual-write or a bounded write pause is engineered. This decision intentionally avoids compatibility write views because they would not safely reproduce multi-relation semantics.
3. **Sequence continuity:** the new ready sequence must start above every migrated ready ordering value, and FIFO equivalence must be defined for scheduled promotion and retries.
4. **Fence continuity:** `fence_token_seq` must advance beyond every migrated active fence before claims resume.
5. **Schema-version cleanup:** version 1 metadata must not coexist in a way that lets clients infer compatibility from `max(version)` alone.
6. **Lock and WAL volume:** backfill, index creation, validation, and legacy table retirement can create long locks, replication lag, and substantial WAL.
7. **Dependent SQL:** views, benchmarks, health queries, dashboards, grants, and ad hoc operational scripts may depend on removed table names.
8. **Rollback:** after version 2 accepts new transitions, reconstructing the four-table version 1 projection is nontrivial and must be planned before cutover.

## Validation

The integration contract verifies schema version 2, absence of legacy relations, batch atomicity and FIFO, coalesced notification, promotion, exclusive claims, heartbeat fencing, retry/recovery attempt increments, stale rejection, terminal runtime deletion, immutable outcomes, attempt/event history, crash boundaries, health, and history retirement.
