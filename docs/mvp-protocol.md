# Ironshift MVP protocol

This is the compact protocol reference. Read [architecture.md](architecture.md) for the design rationale, [features.md](features.md) for current support status, and [benchmarking.md](benchmarking.md) for the evidence runbook.

## Storage model

| Relation          | Role                                                  | Mutation model                                          |
| ----------------- | ----------------------------------------------------- | ------------------------------------------------------- |
| `job`             | Immutable identity, queue, type, payload, retry limit | Insert once                                             |
| `job_current`     | Operator-facing current projection                    | Updated at lifecycle boundaries, never used for claims  |
| `ready_job`       | Runnable work ordered by queue and sequence           | Insert on readiness, delete on claim                    |
| `scheduled_job`   | Future work ordered by `run_at`                       | Insert while delayed, delete on promotion               |
| `lease`           | Active ownership and fencing                          | Bounded by active concurrency; heartbeat updates expiry |
| `job_event`       | Lifecycle audit stream                                | Append-only, monthly range partitions                   |
| `attempt_history` | Final attempt outcomes                                | Append-only, monthly range partitions                   |

The default history partitions prevent inserts from failing if monthly partition maintenance is missed. `ironshift.create_history_partitions_v1(month)` creates explicit partitions. `ironshift.retire_history_month_v1(month)` drops both completed-month history partitions in bulk and refuses to retire the current or a future month. Production validation must still schedule these operations and measure their lock/latency impact.

## Atomic transitions

All correctness-sensitive transitions are versioned PostgreSQL functions:

1. `enqueue_v1` inserts immutable identity, current projection, initial event, and ready or scheduled work in the caller transaction.
2. `promote_v1` moves a bounded, locked due set from scheduled to ready.
3. `claim_v1` locks one ready row with `SKIP LOCKED`, removes it, allocates a global fence, creates a lease, and appends the claim event.
4. `heartbeat_v1` extends only the matching unexpired worker/fence lease.
5. `complete_v1` consumes only the matching unexpired lease, finalizes current state, and appends attempt/event history.
6. `fail_v1` immutably closes the current attempt and either creates a new ready/scheduled attempt or terminally fails the job.
7. `recover_expired_v1` locks expired leases in bounded batches, closes each attempt, and requeues or terminally fails it. The old fence can no longer complete.

## Crash harness

`Worker` can inject a process-like exception at `afterClaim`, `beforeHandler`, `afterHandler`, `beforeComplete`, or `afterComplete`. An injected crash intentionally does not call `fail_v1`. This leaves committed state exactly where a killed process would leave it so lease recovery and duplicate-effect windows can be tested.

`afterComplete` models a worker dying after PostgreSQL committed success but before the process observed it. Re-executing an external effect is the application's responsibility to prevent with an idempotency key.

## Known validation limits

- The worker uses indexed polling. `NOTIFY` is emitted as a wake hint, but a dedicated listener is intentionally postponed.
- Retry delay is caller supplied. Backoff and jitter policy are not productized.
- History partition creation and bulk retirement functions exist, but scheduling and retention policy are intentionally left to the validation environment.
- The health command reports table/index size, live/dead tuples, HOT ratio, vacuum timestamps, queue depth, expired leases, oldest ready age, oldest open transaction, lock waits, and notification usage. WAL rate, vacuum duration/I/O, historical growth, and provider-specific restrictions require further validation.
- Benchmark semantics cover independent enqueue, claim, and completion. The conventional prototype is a success-path baseline and must gain equivalent lease/history/recovery semantics before comparative product claims. The harness does not yet model PgQue separately, replication horizons, dashboard load, high contention, or 100 million transitions.
