# Ironshift MVP protocol

This is the compact schema version 2 protocol reference. Public TypeScript `Queue`/`Worker` methods and the existing `_v1` SQL function signatures remain stable.

## Storage model

| Relation          | Role                                                  | Mutation model                                                          |
| ----------------- | ----------------------------------------------------- | ----------------------------------------------------------------------- |
| `job`             | Immutable identity, queue, type, payload, retry limit | Insert once                                                             |
| `job_runtime`     | Sole live row for scheduled, ready, or active work    | Insert at enqueue; CAS-update while live; delete at terminal transition |
| `job_outcome`     | Terminal success or failure                           | Insert once after runtime deletion                                      |
| `job_event`       | Lifecycle audit                                       | Append-only, monthly range partitions                                   |
| `attempt_history` | Closed attempt records                                | Append-only, monthly range partitions                                   |

A committed job has exactly one live runtime or one terminal outcome, never both. Version 1 write tables and compatibility write views are absent.

## Indexed runtime states

- Ready claims use `job_runtime_ready_idx (queue_name, sequence, job_id) WHERE state = 'ready'`.
- Scheduled promotion uses `job_runtime_scheduled_idx (run_at, job_id) WHERE state = 'scheduled'`.
- Expiry recovery uses `job_runtime_expired_active_idx (expires_at, job_id) WHERE state = 'active'`.

FIFO sequence is globally monotonic. Enqueue allocates ready sequences in input order. Promotion and retries allocate a new sequence when work becomes ready.

## Atomic transitions

1. `enqueue_many_v1` validates up to 1,000 JSONB requests against one timestamp and inserts `job`, `job_runtime`, and one `enqueued` event per job. `enqueue_v1` delegates to it.
2. `promote_v1` locks a bounded due set with `SKIP LOCKED`, updates scheduled runtime rows to ready, assigns sequences, and appends events.
3. `claim_v1` locks one FIFO ready row and performs one runtime state update to active with worker, fence, heartbeat, and expiry data, then appends the claim event.
4. `heartbeat_v1` CAS-updates only the matching unexpired active runtime.
5. `fail_v1` locks the matching active generation. Retry CAS-updates the same runtime, increments attempt, and places it ready or scheduled. Exhaustion deletes runtime and inserts failed outcome.
6. `recover_expired_v1` locks expired active runtimes in bounded batches and performs the same attempt increment/requeue or terminal delete/outcome transition with observed fence and expiry guards.
7. `complete_v1` deletes only the matching unexpired active runtime and inserts succeeded outcome, closed attempt history, and event atomically.

Every closed attempt has one immutable `attempt_history` row. Every lifecycle boundary appends a `job_event`.

## Batch enqueue contract

`Queue.enqueueMany(requests, transaction?)` accepts at most **1,000 requests**. Each request contains `queue`, `type`, `payload`, ISO-8601 `runAt`, and `maxAttempts`.

- Ready and scheduled jobs may be mixed.
- Returned UUIDs match input order.
- Ready FIFO sequence allocation follows input order.
- One timestamp classifies the whole batch.
- Any invalid request rolls back all identity, runtime, event, and notification work.
- Empty input performs no query.
- An active caller `PoolClient` controls commit or rollback.
- `NOTIFY ironshift_jobs` is commit-delivered and coalesced to one message per distinct queue gaining ready work.
- Scheduled-only queues are notified only after promotion.

## Ownership and crashes

A claim is owned only while `job_runtime.state = 'active'` and job ID, worker ID, fence token, and unexpired `expires_at` all match. Stale heartbeat, completion, and failure return rejection without modifying a newer generation.

Worker failpoints at `afterClaim`, `beforeHandler`, `afterHandler`, `beforeComplete`, and `afterComplete` model process loss. Pre-completion crashes leave active runtime for recovery. An `afterComplete` crash leaves immutable succeeded outcome and closed attempt history.

Delivery is at least once. External effects require application-level idempotency.

## History and retention

The default partitions keep history inserts available if maintenance is late. `create_history_partitions_v1(month)` creates explicit event and attempt partitions. `retire_history_month_v1(month)` drops both completed-month partitions and rejects current/future months.

No automatic retention exists for `job` or `job_outcome`.

## Validation limits

- The schema file supports clean installation, not online migration from schema version 1.
- Polling remains authoritative; `NOTIFY` is only a wake hint.
- Backoff/jitter and automated partition scheduling are not productized.
- Centralized runtime churn, partial-index maintenance, autovacuum behavior, and migration duration require production-scale measurement.
