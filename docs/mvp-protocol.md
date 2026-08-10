# Workhorse MVP protocol

This is the compact schema version 21 protocol reference. The clean-install schema stores bounded
W3C trace metadata and supports scoped enqueue idempotency. It also supports retry policies,
checkpoints, progress, timer waits, cancellation, deadlines, execution timeouts, and dead-letter
redrive. Operator projections, bounded payload controls, lifecycle timelines, automated retention,
and per-minute statistics complete the protocol.

## Storage model

| Relation              | Role                                                                       | Mutation model                                                                        |
| --------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `job`                 | Immutable identity, payload, accepted contract, retry limit and policy     | Insert once                                                                           |
| `enqueue_idempotency` | Scoped retained enqueue ownership and canonical request fingerprint        | Reserve once per active `(scope, key)`; replace after expiry; delete on purge/cleanup |
| `job_runtime`         | Sole live row, retry state, and optional active cancellation request       | Insert at enqueue; CAS-update while live; delete at terminal transition               |
| `job_checkpoint`      | Immutable named handler restart boundaries                                 | Insert once per job and checkpoint name under a fenced active lease                   |
| `job_progress`        | Latest bounded mutable operational progress                                | Fenced replace, at most once per 100 ms for changed values from one generation        |
| `job_wait`            | Immutable named timer restart boundaries                                   | Insert once per job and wait name under a fenced active lease                         |
| `job_outcome`         | Terminal success, failure, or cancellation                                 | Insert once after runtime deletion                                                    |
| `job_query`           | Bounded operator lifecycle projection                                      | Trigger-synchronized on meaningful lifecycle changes; heartbeat-independent           |
| `job_redrive`         | Audited source-to-target redrive lineage and request replay evidence       | Insert once per accepted source/request identity                                      |
| `job_event`           | Lifecycle audit                                                            | Append-only, UTC-daily range partitions                                               |
| `attempt_history`     | Closed attempt records                                                     | Append-only, UTC-daily range partitions                                               |
| `schedule_definition` | Namespaced recurring-job desired state including contract and retry policy | Deploy upsert; omitted definitions are disabled                                       |
| `schedule_occurrence` | Deduplicated schedule fire mapped to a job                                 | Insert once per schedule second; job ID populated atomically                          |
| `retention_policy`    | Authoritative cleanup windows, work limits, defaults, and provenance       | Application seed or operator override and revert                                      |
| `maintenance_policy`  | IANA timezone, local retention time, cadences, defaults, and provenance    | Application seed or operator override and revert                                      |
| `maintenance_state`   | Per-task due state and retained-history safety watermark                   | SQL-owned maintenance state                                                           |

A committed job has exactly one live runtime or one terminal outcome, never both. Version 1 write tables and compatibility write views are absent.

## Indexed runtime states

- Ready claims use `job_runtime_ready_idx (queue_name, sequence, job_id) WHERE state = 'ready'`.
- Scheduled promotion uses `job_runtime_scheduled_idx (run_at, job_id) WHERE state = 'scheduled'`.
- Expiry recovery uses `job_runtime_expired_active_idx (expires_at, job_id) WHERE state = 'active'`.
- Dead-letter listing uses a cold partial `job_outcome` index ordered by `(finished_at, job_id)` where state is `failed`; it is never consulted by claim.
- Cross-state listing uses dedicated `job_query` indexes ordered by immutable `(created_at, job_id)`, optionally prefixed by queue, type, or state. These indexes are never consulted by claim, promotion, recovery, deadlines, or timeouts.
- Lifecycle timelines use job/time indexes on the partitioned event and attempt relations.

FIFO sequence is globally monotonic. Enqueue allocates ready sequences in input order. Promotion and retries allocate a new sequence when work becomes ready.

## Atomic transitions

1. `enqueue_many_v1` validates up to 1,000 JSONB requests against one timestamp, including canonical payload size, contract version, and redaction metadata, then returns `(ordinal, job_id, accepted)`. Keyed requests first acquire deterministic sorted scoped-ownership locks, while acceptance side effects remain in caller ordinal order. New requests set `accepted` and insert `job`, `job_runtime`, and one `enqueued` event; exact replays clear `accepted` and return the retained job ID before durable, FIFO, or notification side effects; mismatches abort the whole statement with structured safe conflict details. `enqueue_v1` delegates to it.
2. `promote_v1` locks a bounded due set with `SKIP LOCKED`, updates scheduled runtime rows to ready, assigns sequences, and appends events.
3. `claim_v1` locks one FIFO ready row whose absolute deadline has not expired and performs one runtime state update to active with worker, fence, heartbeat, lease expiry, and the current attempt's execution-timeout budget, then returns raw payload plus the accepted contract version, result limit, and error-redaction flag and appends the claim event.
4. `heartbeat_v2` returns `accepted`, `cancel_requested`, or `stale` for the exact unexpired active generation and extends only accepted leases. Additive compatibility `heartbeat_v1` returns true only for accepted.
5. `cancel_v1` locks the sole runtime. Ready, scheduled, and durable-wait continuations become canceled immediately. Active work records one request and returns `cancel_requested`; repeats retain the first request. Existing terminal success/failure returns `already_terminal`; existing cancellation returns `canceled`.
6. `acknowledge_cancel_v1` accepts only the exact unexpired worker/fence carrying a request, then inserts the canceled outcome, truthful attempt history, and terminal event atomically.
7. `save_checkpoint_v1` locks the matching unexpired active generation and inserts one immutable named JSON result plus a `checkpoint_saved` event. Repeated equal values return the stored checkpoint; different values conflict; cancellation-requested or stale owners are rejected.
   7b. `update_progress_v1` locks and revalidates the matching active generation, replaces one 64-KiB latest-value projection, increments its revision, and appends value-free `progress_updated` telemetry. Identical values are no-ops; changed values from one fence are limited to one every 100 milliseconds.
8. `schedule_wait_v1` locks and revalidates the matching active generation, inserts at most one named relative or absolute timer definition, and either returns an elapsed boundary or changes runtime to wait-marked scheduled state without incrementing the attempt. Relative replay is first-write-wins; absolute target or mode changes conflict; cancellation-requested or stale owners are rejected; each job is limited to 1,000 names.
9. `fail_v1` locks the matching active generation. A cancellation request returns `cancel_requested`. Otherwise retry asks PostgreSQL to select the persisted policy delay, CAS-updates the same runtime, increments attempt, persists any next jitter state, clears wait continuation metadata, and requeues ready or scheduled. Exhaustion deletes runtime and inserts failed outcome.
10. `recover_expired_v1` locks expired active runtimes in bounded batches. Requested rows materialize canceled without retry; other rows perform policy selection and attempt increment/requeue or terminal failure with observed fence and expiry guards.
11. `complete_v1` checks the persisted canonical result-size limit, then deletes only the matching unexpired active runtime with no cancellation request and inserts succeeded outcome, closed attempt history, and event atomically. `Queue.complete` first applies the accepted version's result validator.
12. `list_dead_letters_v1` validates failure-only filters and returns a bounded descending cursor page from immutable outcomes with persisted top-level payload redaction and redrive counts.
13. `redrive_v1` locks one source, requires a failed outcome plus audit metadata, resolves source/request idempotency, and creates a new ready identity with copied immutable definition and accepted contract metadata except for a cleared absolute deadline. It appends source and target events and one lineage edge without modifying the source outcome's semantic terminal columns; the existing retention watermark may advance with append-only history. `redrive_many_v1` selects at most 1,000 oldest matching sources after an optional keyset cursor; dry-run returns `eligible` rows without writes.
14. `list_jobs_v1` validates exact queue/type/state/creation-time filters, a bounded payload projection, and a filter-bound immutable cursor. It selects at most 1,000 candidates from `job_query` before joining `job` for optional top-level-redacted payload output. Persisted contract keys are always combined with caller projection keys.
15. `list_job_timeline_v1` merges retained `job_event` and `attempt_history` rows into one latest-first bounded cursor stream. Unknown identities and identities whose history was fully retired both return an empty stream; use point lookup when that distinction matters.
16. `sync_schedule_definitions_v1` atomically upserts one namespace's desired definitions with accepted contract metadata, increments revisions for material changes, and optionally disables omitted names.
17. `fire_schedule_v1` locks an enabled definition matching the expected revision, reserves one occurrence second, and delegates to `enqueue_v1` with the stored contract version, limits, and redaction keys; stale revisions return null and duplicate fires return the existing job ID. Canceling its job does not alter the definition or later occurrences.
18. `sync_retention_policy_v1` stores explicit nullable minimum windows and work bounds, rejecting policies that could delete identity before retained outcome, event, attempt, occurrence, or redrive-lineage attribution.
19. `tick_v1` performs bounded due promotion and expired-lease recovery under the `workhorse:tick` advisory lock. Every promoted row emits `promoted`; timer-backed promotion also carries and clears `wait_name` and appends `wait_elapsed`. `prepare_history_partitions_v1`, `retain_history_v1`, and `prune_terminal_storage_v1` own separate due state and advisory locks for partition coverage, daily history retirement, and terminal/idempotency cleanup. Every phase is isolated in an exception subtransaction, and every entry point returns `(phase, rows_affected, duration_ms, skipped_lock, error)` telemetry. Terminal identity pruning skips a redrive source while any retained descendant edge still protects it.

Every closed logical attempt has one immutable `attempt_history` row. Never-started cancellation has none; active or previously started durable-wait cancellation closes one row with outcome `canceled`. `started_at` spans timer suspensions and `claimed_at` identifies the final activation that closed it. Every lifecycle boundary appends a `job_event`; cancellation uses one `cancel_requested` event only for active work and one `canceled` event at terminal materialization. Repeated requests add no duplicate terminal or event evidence.

## Dead-letter and redrive contract

`Queue.listDeadLetters(query?)` accepts queue, type, required tags, error name, `finishedAfter`, and `finishedBefore` filters. Pages contain at most 1,000 rows and use immutable `(finishedAt, jobId)` cursor order. General live and terminal listing is provided by the schema-v16 `Queue.listJobs` contract above.

`Queue.redrive(sourceJobId, { requestedBy, reason, requestId })` accepts only a retained failed source. Actor is 1 through 200 characters, reason is 1 through 2,000 characters, and request ID is 1 through 512 UTF-8 bytes. The request ID is hashed; audit rows and conflict details expose only its safe preview, digest, and length.

The target starts ready at attempt one with source queue, type, payload, accepted contract version, size limits, redaction keys, tags, maximum attempts, retry policy, and execution timeout. Deadline, checkpoints, waits, attempts, results, and cancellation state are not copied. Exact source/request replay returns the retained target with status `replayed`; materially different attribution raises SQLSTATE `P1002` and `RedriveIdempotencyConflictError` without creating side effects.

`Queue.redriveMany(filter, request, { limit?, dryRun?, cursor? })` processes the oldest matching failures in one PostgreSQL statement and returns `{ results, nextCursor }`. The default limit is 100 and the maximum is 1,000. Passing `nextCursor` into the next call advances deterministically across equal timestamps; repeating the same cursor and request replays the same page. A dry-run returns `eligible` rows and performs no job, event, notification, or lineage writes. Each source derives independent idempotency from the shared request ID, so replaying a page cannot duplicate targets.

## Batch enqueue contract

`Queue.enqueueMany(requests, transaction?)` accepts at most **1,000 requests**. Each request contains `queue`, `type`, `payload`, optional ISO-8601 `runAt`, `maxAttempts`, optional `retryPolicy`, tags, and optional `idempotency: { key, scope?, ttlMs? }`.

- Scope defaults to `default`; TTL defaults to 86,400,000 ms (24 hours).
- Key length is 1 through 512 UTF-8 bytes; scope length is 1 through 256 UTF-8 bytes; TTL is an integer from 1 through 31,536,000,000 ms (365 days).
- The request fingerprint includes queue, type, payload, sorted tags, max attempts, normalized retry policy, TTL, and an explicitly supplied `runAt`.
- A keyed omitted `runAt` stays omitted in the fingerprint, allowing later immediate retries to replay instead of conflicting on a new classification timestamp.
- Exact replay returns the existing job ID with no duplicate job, event, FIFO-sequence, or notification work.
- A retained mismatch raises a structured conflict containing safe preview/digest identity, the existing job ID, and request ordinal, and rolls back the whole batch.
- Raw keys are never persisted. `enqueue_idempotency` stores scope plus the full SHA-256 key hash. The initial `enqueued` event, UI projections, and errors use a bounded preview plus 12-hex key digest; exact replay emits no event. Structured conflicts also include full stored/rejected request digests.
- Expired bindings permit reuse. Purging queued or scheduled jobs releases bindings. Housekeeping deletes expired bindings before terminal identity pruning.
- Requests without `idempotency` preserve the prior behavior and always create a new job.
- Ready and scheduled jobs may be mixed.
- Returned UUIDs match input order.
- Ready FIFO sequence allocation follows input order.
- One timestamp classifies the whole batch.
- Any invalid request rolls back all identity, runtime, event, and notification work.
- Empty input performs no query.
- An active caller `PoolClient` controls commit or rollback.
- `NOTIFY workhorse_jobs` is commit-delivered and coalesced to one message per distinct queue gaining ready work.
- Scheduled-only queues are notified only after promotion.

## Persisted retry-policy contract

The optional union is:

```ts
type RetryPolicy =
  | { type: "fixed"; delayMs: number }
  | {
      type: "exponential";
      initialDelayMs: number;
      multiplier: number;
      maxDelayMs: number;
    }
  | { type: "decorrelated-jitter"; baseDelayMs: number; maxDelayMs: number };
```

- `retryPolicy` is accepted by enqueue requests and recurring schedule job definitions, persisted on
  the stable job identity, and returned by claims and `JobSnapshot`.
- PostgreSQL is authoritative for exact-object validation, normalization, delay selection, state
  transition, persisted jitter state, and lifecycle-event provenance.
- Explicit policies apply to both handler failure and expired-lease recovery.
- Omitted policy preserves compatibility: handler failure selects legacy Sidekiq-inspired random
  backoff, while lease recovery selects zero for immediate readiness.
- Numeric `Queue.fail` delay and numeric or callback-derived `WorkerOptions.retryDelayMs` are
  higher-precedence manual overrides. A worker callback can return `undefined` to defer to the
  persisted policy or compatibility default. `Queue.recoverExpired(limit)` passes omitted delay as
  SQL `NULL` so persisted policy selection remains authoritative; an explicit recovery delay also
  overrides.
- Decorrelated jitter is deterministic from stable job identity, attempt, and persisted previous
  selected delay. Replaying the selector or recreating `Queue` cannot change the value.
- Every delay is an integer between 0 and 31,536,000,000 ms. Exponential `multiplier` is an integer
  between 1 and 100. Exponential and jitter maxima must be at least their initial or base delay.

## Ownership and crashes

A claim is owned only while `job_runtime.state = 'active'` and job ID, worker ID, fence token, and unexpired `expires_at` all match. Stale heartbeat, completion, failure, checkpoint, wait, and cancellation acknowledgement return rejection without modifying a newer or terminal generation.

Worker failpoints at `afterClaim`, `beforeHandler`, `afterHandler`, `beforeComplete`, and `afterComplete` model process loss. Pre-completion crashes leave active runtime for recovery. An `afterComplete` crash leaves immutable succeeded outcome and closed attempt history.

Delivery is at least once. Enqueue idempotency deduplicates durable acceptance, not handler effects. Cancellation is cooperative: `heartbeat_v2` delivers the request through `AbortSignal`, but cannot forcibly preempt JavaScript or roll back committed effects. External effects require provider idempotency, an outbox/inbox, or compensation. `requestedBy` is attribution only and callers must authorize requests before invoking the core transition.

`HandlerContext.checkpoint(name, operation)` first returns an existing immutable value when present. Otherwise it runs the operation and saves its JSON result under the active fence. Concurrent calls for the same name within one handler are coalesced. A crash after an external effect but before PostgreSQL commits the checkpoint can still repeat that effect, so checkpoints do not replace provider idempotency, outbox/inbox, or compensation.

`HandlerContext.sleep(name, durationMs)` and `sleepUntil(name, date)` create named durable timer boundaries. A future first target atomically clears active ownership and reuses the scheduled index; normal promotion later restarts the handler from its entry point in the same attempt with a new fence. Relative durations are PostgreSQL-clock-based and first-write-wins by name. Absolute target or mode changes conflict. The worker aborts its cooperative signal and frees the slot without calling fail or complete. Code before the wait is replayed and therefore still needs checkpoints or application idempotency.

Wait names are limited to 200 characters, relative durations to 365 days, and retained names to 1,000 per job. A past-due first target is still recorded and returns immediately. The default one-second maintenance cadence makes sub-second durable waits inefficient and actual wake time can be later because of queue pause, downtime, or worker availability. Timer waits follow parent-job retention. They do not provide general-purpose signals, early wake, or a workflow graph, although the containing job may be canceled through the ordinary job lifecycle.

Checkpoint values are limited to 1 MiB of PostgreSQL's canonical JSONB text representation. They follow the parent job identity's retention lifecycle and cannot be retired independently without risking repetition of a previously completed step. A checkpoint miss proves only that PostgreSQL has no committed result for that name; it does not prove an external operation never ran.

## Worker-owned scheduling contract

Before scheduling concerns, the worker execution contract is:

- `WorkerOptions.concurrency` is an integer from 1 through 100 and defaults to 1.
- `worker.concurrency` is readonly; `worker.runtimeState()` returns
  `{ concurrency, activeSlots, paused, draining }` for this in-process worker.
- A fill pass claims serially into free slots, starts one independent handler task per accepted job, never
  exceeds the configured slot count, and stops at the first null claim.
- Every active job has its own heartbeat, abort signal, and fenced completion/failure lifecycle.
- `pause()` blocks new claims but does not cancel active handlers; `resume()` reopens claims immediately.
- `stop()` blocks new claims and drains active handlers before `run()` resolves.
- Concurrency is local execution capacity, not a durable worker registry, cross-process rate limit, queue
  weighting policy, or exactly-once guarantee.

`Queue.syncSchedules(namespace, definitions, { prune })` runs against the target database only, normally during deployment.

- Namespaces and names are stable deployment identities using letters, digits, dot, underscore, and hyphen.
- Definitions contain cron text plus a typed Workhorse queue job; arbitrary SQL is not accepted.
- Definition upsert is one target-database transaction; a per-namespace advisory lock serializes concurrent deployments.
- Workers parse cron expressions in process and compute each enabled definition's due occurrences from its last durable occurrence.
- Worker tick passes run at most once per `maintenanceIntervalMs` (default one second). Workers poll the three slow tasks at most once per `maintenanceTaskPollMs` (default 60 seconds), while PostgreSQL owns their database-global due state. Transaction-scoped advisory locks inside every maintenance task and `fire_schedule_v1` make concurrent passes no-ops, so any number of workers run without duplicate fires and any surviving worker takes over.
- Maintenance is bounded: 1,000-row promotion/recovery limits per tick; by default at most 1,000 terminal jobs, four history partitions per category, 10,000 fallback rows per category, and 10,000 occurrences per task pass. Every loop reports per-phase telemetry through `worker.maintenanceTelemetry()` and `onMaintenance`.
- `Worker` option `scheduleNamespaces` selects which namespaces a worker evaluates; `scheduleCatchupLimit` bounds missed occurrences fired after downtime.
- Worker fires call `fire_schedule_v1(namespace, name, revision, occurrence)` with the planned occurrence second as the occurrence key; stale, disabled, or missing definitions are no-ops.
- Callers using `Queue.fireSchedule(namespace, name, revision, occurrenceAt)` can supply a stable external occurrence timestamp.
- Occurrence deduplication is enqueue-level only. Worker delivery remains at least once.

## History and retention

`attempt_history.started_at` records the beginning of the logical attempt even when it suspends through timers, while `claimed_at` records the final activation that produced retry, expiry, success, terminal failure, or cancellation. Timer suspension emits lifecycle events but does not close an attempt row. Never-started cancellation has no attempt row.

The default partitions keep history inserts available if maintenance is late. `create_history_day_v1(day)` normalizes its argument to a UTC date, serializes creation for that boundary, repairs either missing half of a partial event/attempt pair, and moves matching fallback rows into each newly created partition. `retire_history_day_v1(day)` remains an explicit paired primitive. Clean installation precreates the current day and three future days, while `prepare_history_partitions_v1` repairs that horizon every six hours by default.

`Queue.syncRetentionPolicy` records application defaults for independent minimum windows and work
limits. It updates effective values unless an operator owns them. `{ force: true }` clears every
override and restores deployment authority. `Queue.overrideRetentionPolicy` changes selected
effective values, while `Queue.revertRetentionPolicy` restores selected current application
defaults. Every category defaults to 14 days; null disables a category. Event and attempt phases
independently drop only fully expired completed days and bounded-delete expired default rows.

Identity is the attribution anchor. History inserts lock and verify their parent and update its retained-history boundary. Daily retention advances a global watermark only after event and attempt cleanup is complete through their cutoffs. Terminal cleanup requires an outcome, elapsed identity and outcome windows, no live runtime or retained occurrence, and a terminal boundary behind that watermark. Only then does deleting `job` cascade its outcome, checkpoints, and waits. Retention windows are minimums: daily granularity, bounded catch-up, and retained provenance can extend actual storage. Queue health reports policy, cleanup lag, oldest retained boundaries, eligible history partitions, and cumulative default-partition rows.

`Queue.syncMaintenancePolicy` records application defaults for one IANA timezone, a local
wall-clock retention time, and task cadences. `Queue.overrideMaintenancePolicy` changes selected
effective values, and `Queue.revertMaintenancePolicy` restores selected application defaults.
Partition preparation defaults to six-hour intervals, terminal/idempotency cleanup to five-minute
intervals, and history retention to once per local date at or after 03:00 UTC. Workers poll task
eligibility every minute by default; PostgreSQL owns the global due check and separate advisory lock
for each task.

## Validation limits

- The schema file supports clean installation, not online migration from earlier schema versions.
- Schedules fire only while at least one worker with matching `scheduleNamespaces` runs; drift is bounded by the worker tick cadence.
- Schedule precision is one second and cron expressions are evaluated in the worker's configured timezone.
- `Worker.run()` shares one `LISTEN workhorse_jobs` connection per node-postgres pool. Queue payloads
  wake matching workers and `*` wakes all subscribers. Reconnect starts at 100 ms, doubles through
  5 seconds, and applies ±10% jitter. A successful initial connection or reconnect prompts a claim.
- Polling remains authoritative. Notification-capable `run()` defaults to a 5-second fallback with
  ±10% jitter; a database without `connect()` retains 250 ms. An explicit `pollMs` replaces the base
  in either mode. A node-postgres pool with `max = 1` remains polling-only. `runOnce()` retains 250
  ms by default and opens no listener.
- Retention policy changes require a bounded impact preview in the dashboard. Process-owned worker
  options remain read-only and change only through deployment configuration.
- Centralized runtime churn, partial-index maintenance, autovacuum behavior, and migration duration require production-scale measurement.
