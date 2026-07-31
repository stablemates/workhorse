# Workhorse MVP protocol

This is the compact schema version 6 protocol reference. Public TypeScript `Queue`/`Worker` methods remain stable; the canonical clean-install schema includes explicit durable checkpoints and the weekly history lifecycle functions documented below.

## Storage model

| Relation              | Role                                                  | Mutation model                                                          |
| --------------------- | ----------------------------------------------------- | ----------------------------------------------------------------------- |
| `job`                 | Immutable identity, queue, type, payload, retry limit | Insert once                                                             |
| `job_runtime`         | Sole live row for scheduled, ready, or active work    | Insert at enqueue; CAS-update while live; delete at terminal transition |
| `job_checkpoint`      | Immutable named handler restart boundaries            | Insert once per job and checkpoint name under a fenced active lease     |
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
5. `save_checkpoint_v1` locks the matching unexpired active generation and inserts one immutable named JSON result plus a `checkpoint_saved` event. Repeated equal values return the stored checkpoint; different values conflict; stale owners are rejected.
6. `fail_v1` locks the matching active generation. Retry CAS-updates the same runtime, increments attempt, and schedules Sidekiq-inspired quartic backoff with jitter unless the caller explicitly overrides the delay. Exhaustion deletes runtime and inserts failed outcome.
7. `recover_expired_v1` locks expired active runtimes in bounded batches and performs the same attempt increment/requeue or terminal delete/outcome transition with observed fence and expiry guards.
8. `complete_v1` deletes only the matching unexpired active runtime and inserts succeeded outcome, closed attempt history, and event atomically.
9. `sync_schedule_definitions_v1` atomically upserts one namespace's desired definitions, increments revisions for material changes, and optionally disables omitted names.
10. `fire_schedule_v1` locks an enabled definition matching the expected revision, reserves one occurrence second, and delegates to `enqueue_v1`; stale revisions return null and duplicate fires return the existing job ID.
11. `tick_v1` performs bounded due promotion and expired-lease recovery under the `workhorse:tick` advisory lock. `housekeep_v1` replenishes the history-partition horizon and prunes old occurrence keys under the separate `workhorse:housekeeping` lock, with each phase isolated in an exception subtransaction. Both return one telemetry row per phase: `(phase, rows_affected, duration_ms, skipped_lock, error)`.

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
- `NOTIFY workhorse_jobs` is commit-delivered and coalesced to one message per distinct queue gaining ready work.
- Scheduled-only queues are notified only after promotion.

## Ownership and crashes

A claim is owned only while `job_runtime.state = 'active'` and job ID, worker ID, fence token, and unexpired `expires_at` all match. Stale heartbeat, completion, and failure return rejection without modifying a newer generation.

Worker failpoints at `afterClaim`, `beforeHandler`, `afterHandler`, `beforeComplete`, and `afterComplete` model process loss. Pre-completion crashes leave active runtime for recovery. An `afterComplete` crash leaves immutable succeeded outcome and closed attempt history.

Delivery is at least once. External effects require application-level idempotency.

`HandlerContext.checkpoint(name, operation)` first returns an existing immutable value when present. Otherwise it runs the operation and saves its JSON result under the active fence. Concurrent calls for the same name within one handler are coalesced. A crash after an external effect but before PostgreSQL commits the checkpoint can still repeat that effect, so checkpoints do not replace provider idempotency, outbox/inbox, or compensation.

Checkpoint values are limited to 1 MiB of PostgreSQL's canonical JSONB text representation. They follow the parent job identity's retention lifecycle and cannot be retired independently without risking repetition of a previously completed step. A checkpoint miss proves only that PostgreSQL has no committed result for that name; it does not prove an external operation never ran.

## Worker-owned scheduling contract

`Queue.syncSchedules(namespace, definitions, { prune })` runs against the target database only, normally during deployment.

- Namespaces and names are stable deployment identities using letters, digits, dot, underscore, and hyphen.
- Definitions contain cron text plus a typed Workhorse queue job; arbitrary SQL is not accepted.
- Definition upsert is one target-database transaction; a per-namespace advisory lock serializes concurrent deployments.
- Workers parse cron expressions in process and compute each enabled definition's due occurrences from its last durable occurrence.
- Worker tick passes run at most once per `maintenanceIntervalMs` (default one second) and housekeeping passes at most once per `housekeepingIntervalMs` (default 60 seconds); transaction-scoped advisory locks inside `tick_v1`, `housekeep_v1`, and `fire_schedule_v1` make concurrent passes from other workers no-ops, so any number of workers run without duplicate fires and any surviving worker takes over.
- Maintenance is bounded: 1,000-row promotion/recovery limits per tick and a 10,000-row occurrence-pruning limit per housekeeping pass. Both report per-phase telemetry, surfaced through `worker.maintenanceTelemetry()` and the `onMaintenance` callback.
- `Worker` option `scheduleNamespaces` selects which namespaces a worker evaluates; `scheduleCatchupLimit` bounds missed occurrences fired after downtime.
- Worker fires call `fire_schedule_v1(namespace, name, revision, occurrence)` with the planned occurrence second as the occurrence key; stale, disabled, or missing definitions are no-ops.
- Callers using `Queue.fireSchedule(namespace, name, revision, occurrenceAt)` can supply a stable external occurrence timestamp.
- Occurrence deduplication is enqueue-level only. Worker delivery remains at least once.

## History and retention

The default partitions keep history inserts available if maintenance is late. `create_history_week_v1(week)` normalizes its argument to Monday, serializes creation for that boundary, and moves matching fallback rows into the new event and attempt partitions. `retire_history_week_v1(week)` drops both partitions only after the week is complete. Clean installation precreates the current week and four future weeks, while each `housekeep_v1` pass repairs and replenishes the four-week horizon when its edge is missing.

Schedule occurrence keys older than 30 days are pruned in bounded batches by default. No automatic retention exists for `job` or `job_outcome`.

## Validation limits

- The schema file supports clean installation, not online migration from schema version 1.
- Schedules fire only while at least one worker with matching `scheduleNamespaces` runs; drift is bounded by the worker tick cadence.
- Schedule precision is one second and cron expressions are evaluated in the worker's configured timezone.
- Polling remains authoritative; `NOTIFY` is only a wake hint.
- Automated history-retention policy is not productized.
- Centralized runtime churn, partial-index maintenance, autovacuum behavior, and migration duration require production-scale measurement.
