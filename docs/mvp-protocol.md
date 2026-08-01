# Workhorse MVP protocol

This is the compact schema version 8 protocol reference. Public TypeScript `Queue`/`Worker` methods remain stable; the canonical clean-install schema includes explicit durable checkpoints, named timer waits, and persisted automated retention.

## Storage model

| Relation              | Role                                                  | Mutation model                                                          |
| --------------------- | ----------------------------------------------------- | ----------------------------------------------------------------------- |
| `job`                 | Immutable identity, queue, type, payload, retry limit | Insert once                                                             |
| `job_runtime`         | Sole live row for scheduled, ready, or active work    | Insert at enqueue; CAS-update while live; delete at terminal transition |
| `job_checkpoint`      | Immutable named handler restart boundaries            | Insert once per job and checkpoint name under a fenced active lease     |
| `job_wait`            | Immutable named timer restart boundaries              | Insert once per job and wait name under a fenced active lease           |
| `job_outcome`         | Terminal success or failure                           | Insert once after runtime deletion                                      |
| `job_event`           | Lifecycle audit                                       | Append-only, weekly range partitions                                    |
| `attempt_history`     | Closed attempt records                                | Append-only, weekly range partitions                                    |
| `schedule_definition` | Namespaced recurring-job desired state                | Deploy upsert; omitted definitions are disabled                         |
| `schedule_occurrence` | Deduplicated schedule fire mapped to a job            | Insert once per schedule second; job ID populated atomically            |
| `retention_policy`    | Authoritative cleanup windows and bounded work limits | Singleton deploy synchronization                                        |

A committed job has exactly one live runtime or one terminal outcome, never both. Version 1 write tables and compatibility write views are absent.

## Indexed runtime states

- Ready claims use `job_runtime_ready_idx (queue_name, sequence, job_id) WHERE state = 'ready'`.
- Scheduled promotion uses `job_runtime_scheduled_idx (run_at, job_id) WHERE state = 'scheduled'`.
- Expiry recovery uses `job_runtime_expired_active_idx (expires_at, job_id) WHERE state = 'active'`.

FIFO sequence is globally monotonic. Enqueue allocates ready sequences in input order. Promotion and retries allocate a new sequence when work becomes ready.

## Atomic transitions

1. `enqueue_many_v1` validates up to 1,000 JSONB requests against one timestamp and inserts `job`, `job_runtime`, and one `enqueued` event per job. `enqueue_v1` delegates to it.
2. `promote_v1` locks a bounded due set with `SKIP LOCKED`, updates scheduled runtime rows to ready, assigns sequences, and appends events.
3. `claim_v1` locks one FIFO ready row and performs one runtime state update to active with worker, fence, heartbeat, expiry, and a preserved or newly initialized logical attempt start, then appends the claim event.
4. `heartbeat_v1` CAS-updates only the matching unexpired active runtime.
5. `save_checkpoint_v1` locks the matching unexpired active generation and inserts one immutable named JSON result plus a `checkpoint_saved` event. Repeated equal values return the stored checkpoint; different values conflict; stale owners are rejected.
6. `schedule_wait_v1` locks and revalidates the matching active generation, inserts at most one named relative or absolute timer definition, and either returns an elapsed boundary or changes runtime to wait-marked scheduled state without incrementing the attempt. Relative replay is first-write-wins; absolute target or mode changes conflict; each job is limited to 1,000 names.
7. `fail_v1` locks the matching active generation. Retry CAS-updates the same runtime, increments attempt, clears wait continuation metadata, and schedules Sidekiq-inspired quartic backoff with jitter unless the caller explicitly overrides the delay. Exhaustion deletes runtime and inserts failed outcome.
8. `recover_expired_v1` locks expired active runtimes in bounded batches and performs the same attempt increment/requeue or terminal delete/outcome transition with observed fence and expiry guards.
9. `complete_v1` deletes only the matching unexpired active runtime and inserts succeeded outcome, closed attempt history, and event atomically.
10. `sync_schedule_definitions_v1` atomically upserts one namespace's desired definitions, increments revisions for material changes, and optionally disables omitted names.
11. `fire_schedule_v1` locks an enabled definition matching the expected revision, reserves one occurrence second, and delegates to `enqueue_v1`; stale revisions return null and duplicate fires return the existing job ID.
12. `sync_retention_policy_v1` stores explicit nullable minimum windows and work bounds, rejecting policies that could delete identity before retained outcome, event, attempt, or occurrence attribution.
13. `tick_v1` performs bounded due promotion and expired-lease recovery under the `workhorse:tick` advisory lock. Every promoted row emits `promoted`; timer-backed promotion also carries and clears `wait_name` and appends `wait_elapsed`. `housekeep_v1` replenishes the history-partition horizon, retires event and attempt history independently, prunes occurrence keys, and removes safe terminal-job bundles under the separate `workhorse:housekeeping` lock. Every phase is isolated in an exception subtransaction. Both entry points return `(phase, rows_affected, duration_ms, skipped_lock, error)` telemetry.

Every closed logical attempt has one immutable `attempt_history` row. `started_at` spans timer suspensions and `claimed_at` identifies the final activation that closed it. Every lifecycle boundary appends a `job_event`; timer control flow uses `wait_scheduled`, `wait_elapsed`, and `wait_replayed`.

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

`HandlerContext.sleep(name, durationMs)` and `sleepUntil(name, date)` create named durable timer boundaries. A future first target atomically clears active ownership and reuses the scheduled index; normal promotion later restarts the handler from its entry point in the same attempt with a new fence. Relative durations are PostgreSQL-clock-based and first-write-wins by name. Absolute target or mode changes conflict. The worker aborts its cooperative signal and frees the slot without calling fail or complete. Code before the wait is replayed and therefore still needs checkpoints or application idempotency.

Wait names are limited to 200 characters, relative durations to 365 days, and retained names to 1,000 per job. A past-due first target is still recorded and returns immediately. The default one-second maintenance cadence makes sub-second durable waits inefficient and actual wake time can be later because of queue pause, downtime, or worker availability. Timer waits follow parent-job retention and do not provide signals, cancellation, or a workflow graph.

Checkpoint values are limited to 1 MiB of PostgreSQL's canonical JSONB text representation. They follow the parent job identity's retention lifecycle and cannot be retired independently without risking repetition of a previously completed step. A checkpoint miss proves only that PostgreSQL has no committed result for that name; it does not prove an external operation never ran.

## Worker-owned scheduling contract

`Queue.syncSchedules(namespace, definitions, { prune })` runs against the target database only, normally during deployment.

- Namespaces and names are stable deployment identities using letters, digits, dot, underscore, and hyphen.
- Definitions contain cron text plus a typed Workhorse queue job; arbitrary SQL is not accepted.
- Definition upsert is one target-database transaction; a per-namespace advisory lock serializes concurrent deployments.
- Workers parse cron expressions in process and compute each enabled definition's due occurrences from its last durable occurrence.
- Worker tick passes run at most once per `maintenanceIntervalMs` (default one second) and housekeeping passes at most once per `housekeepingIntervalMs` (default 60 seconds); transaction-scoped advisory locks inside `tick_v1`, `housekeep_v1`, and `fire_schedule_v1` make concurrent passes from other workers no-ops, so any number of workers run without duplicate fires and any surviving worker takes over.
- Maintenance is bounded: 1,000-row promotion/recovery limits per tick; by default at most 1,000 terminal jobs, four history partitions per category, 10,000 fallback rows per category, and 10,000 occurrences per housekeeping pass. Both loops report per-phase telemetry through `worker.maintenanceTelemetry()` and `onMaintenance`.
- `Worker` option `scheduleNamespaces` selects which namespaces a worker evaluates; `scheduleCatchupLimit` bounds missed occurrences fired after downtime.
- Worker fires call `fire_schedule_v1(namespace, name, revision, occurrence)` with the planned occurrence second as the occurrence key; stale, disabled, or missing definitions are no-ops.
- Callers using `Queue.fireSchedule(namespace, name, revision, occurrenceAt)` can supply a stable external occurrence timestamp.
- Occurrence deduplication is enqueue-level only. Worker delivery remains at least once.

## History and retention

`attempt_history.started_at` records the beginning of the logical attempt even when it suspends through timers, while `claimed_at` records the final activation that produced retry, expiry, success, or terminal failure. Timer suspension emits lifecycle events but does not close an attempt row.

The default partitions keep history inserts available if maintenance is late. `create_history_week_v1(week)` normalizes its argument to Monday, serializes creation for that boundary, and moves matching fallback rows into the new event and attempt partitions. `retire_history_week_v1(week)` remains an explicit paired primitive. Clean installation precreates the current week and four future weeks, while each `housekeep_v1` pass repairs that horizon.

`Queue.syncRetentionPolicy` persists independent minimum windows for identity, outcome, events, attempts, and occurrences. Null disables a category. Job, outcome, event, and attempt deletion is opt-in; occurrences retain the 30-day default. Event and attempt phases independently drop only fully expired completed weeks and bounded-delete expired default rows.

Identity is the attribution anchor. Terminal cleanup requires an outcome, elapsed identity and outcome windows, no live runtime, and no remaining event, attempt, or occurrence reference. Only then does deleting `job` cascade its outcome, checkpoints, and waits. Retention windows are minimums: weekly granularity, bounded catch-up, and retained provenance can extend actual storage. Queue health reports the policy, cleanup lag, oldest retained boundaries, eligible history partitions, and cumulative default-partition rows.

## Validation limits

- The schema file supports clean installation, not online migration from earlier schema versions.
- Schedules fire only while at least one worker with matching `scheduleNamespaces` runs; drift is bounded by the worker tick cadence.
- Schedule precision is one second and cron expressions are evaluated in the worker's configured timezone.
- Polling remains authoritative; `NOTIFY` is only a wake hint.
- Retention policy is configured through the Queue or SQL deployment API; the demo dashboard
  reports policy and cleanup health but does not mutate it.
- Centralized runtime churn, partial-index maintenance, autovacuum behavior, and migration duration require production-scale measurement.
