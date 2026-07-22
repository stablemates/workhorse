# Ironshift MVP protocol

This is the compact schema version 3 protocol reference. Public TypeScript `Queue`/`Worker` methods and the existing `_v1` lifecycle SQL signatures remain stable unless explicitly replaced by the weekly history lifecycle functions.

## Storage model

| Relation              | Role                                                  | Mutation model                                                          |
| --------------------- | ----------------------------------------------------- | ----------------------------------------------------------------------- |
| `job`                 | Immutable identity, queue, type, payload, retry limit | Insert once                                                             |
| `job_runtime`         | Sole live row for scheduled, ready, or active work    | Insert at enqueue; CAS-update while live; delete at terminal transition |
| `job_outcome`         | Terminal success or failure                           | Insert once after runtime deletion                                      |
| `job_event`           | Lifecycle audit                                       | Append-only, weekly range partitions                                    |
| `attempt_history`     | Closed attempt records                                | Append-only, weekly range partitions                                    |
| `schedule_definition` | Namespaced recurring-job desired state                | Deploy upsert; omitted definitions are disabled                         |
| `schedule_occurrence` | Deduplicated schedule fire mapped to a job            | Insert once per schedule second; job ID populated atomically            |

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
8. `sync_schedule_definitions_v1` atomically upserts one namespace's desired definitions, increments revisions for material changes, and optionally disables omitted names.
9. `fire_schedule_v1` locks an enabled definition matching the expected revision, reserves one occurrence second, and delegates to `enqueue_v1`; stale revisions return null and duplicate fires return the existing job ID.
10. `maintain_v1` performs bounded due promotion, expired-lease recovery, and old occurrence pruning for pg_cron.

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

## pg_cron scheduling contract

`PgCronScheduler.sync(definitions, options?)` connects to both the target database and the cluster's pg_cron metadata database, normally `postgres`.

- Namespaces and names are stable deployment identities using letters, digits, dot, underscore, and hyphen.
- Definitions contain cron text plus a typed Ironshift queue job; arbitrary SQL is not accepted.
- pg_cron job names are scoped by target database and namespace.
- The target definition transaction commits before cron metadata reconciliation. Revision-fenced commands make a failed deploy safely retryable even though the two databases are not atomically distributed.
- A target-wide metadata session lock coordinates synchronization with reset cleanup; a target namespace lock and metadata transaction lock serialize definition and cron reconciliation.
- Pruning touches only current-role jobs with the exact Ironshift target/namespace prefix.
- One maintenance entry runs every second by default with bounded 1,000-row promotion/recovery and 10,000-row occurrence-pruning limits.
- Workers default to external maintenance. `maintenance: "worker"` restores cooperative per-claim maintenance for environments without pg_cron.
- pg_cron schedules call `fire_schedule_v1(namespace, name, revision)` and use the observed execution second as their occurrence key; stale, disabled, or missing definitions are no-ops.
- Callers using `trigger(name, scheduledAt)` can supply a stable external occurrence timestamp.
- Occurrence deduplication is enqueue-level only. Worker delivery remains at least once.

## History and retention

The default partitions keep history inserts available if maintenance is late. `create_history_week_v1(week)` normalizes its argument to Monday, serializes creation for that boundary, and moves matching fallback rows into the new event and attempt partitions. `retire_history_week_v1(week)` drops both partitions only after the week is complete. Clean installation precreates the current week and four future weeks, while each `maintain_v1` call repairs and replenishes the four-week horizon when its edge is missing.

Schedule occurrence keys older than 30 days are pruned in bounded batches by default. No automatic retention exists for `job` or `job_outcome`, and `cron.job_run_details` retention remains administrator-owned.

## Validation limits

- The schema file supports clean installation, not online migration from schema version 1.
- Production scheduling requires pg_cron 1.6+, cross-database scheduling grants, target-role authentication, and active database compute. Run `pnpm pg-cron:check`; provider details are in `docs/pg-cron-requirements.md`.
- Schedule precision is one second and cron expressions use the configured pg_cron timezone.
- Polling remains authoritative; `NOTIFY` is only a wake hint.
- Backoff/jitter and automated history-retention policy are not productized.
- Centralized runtime churn, partial-index maintenance, autovacuum behavior, and migration duration require production-scale measurement.
