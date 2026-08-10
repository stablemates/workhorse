# Workhorse architecture

Workhorse is a PostgreSQL-backed durable queue whose correctness-sensitive lifecycle transitions live in versioned SQL functions. The TypeScript `Queue` and `Worker` remain thin protocol clients.

The current clean-install protocol is schema version 18.

This page is the precise reference. For the ideas it assumes — leases and fence tokens,
at-least-once delivery, cooperative cancellation, the runtime/outcome split — start with
[`guides/000-start-here.md`](guides/000-start-here.md).

## Design objective

Dispatch cost should scale with live work, not lifetime completed work. Schema version 2 therefore stores:

- immutable accepted identity and payload in `job`
- exactly one mutable `job_runtime` row only while a job is scheduled, ready, or active
- exactly one immutable `job_outcome` row after success or terminal failure
- at most one bounded mutable `job_progress` projection, separate from payload and outcome
- immutable audited `job_redrive` edges between failed sources and fresh target identities
- append-only, time-partitioned `job_event` and `attempt_history`

No compatibility write views are installed for the version 1 projection tables.

## System context

```mermaid
flowchart LR
  App[Application transaction] -->|enqueue_many_v1 / enqueue_v1| PG[(PostgreSQL)]
  Deploy[Deployment] -->|schedule sync| PG
  Supervisor[Process supervisor] -->|SIGINT / SIGTERM| WorkerProcess[Dedicated worker process]
  WorkerProcess --> Worker[TypeScript Worker]
  Worker[TypeScript Worker] -->|claim / heartbeat_v2 / acknowledge_cancel_v1| PG
  Operator[Authorized application or operator layer] -->|cancel_v1 with attribution| PG
  Operator -->|list_dead_letters_v1 / redrive_v1 / redrive_many_v1| PG
  Worker -->|fire_schedule_v1 / tick_v1 / split maintenance tasks| PG
  Worker -->|register_worker_v1| PG
  PG -->|payload + attempt + fence| Worker
  PG -->|operator pause flag| Worker
  Worker -->|handler outside SQL transaction| Effects[External effects]
  Worker -->|complete_v1 / fail_v1| PG
  Dashboard -->|read model + worker_registry| PG
  Dashboard -->|set_worker_paused_v1 with attribution| PG
  Health[Health and scenarios] -->|read runtime + outcome + statistics| PG
```

PostgreSQL is the durable authority. A worker owns a job only while the active `job_runtime` row matches its worker ID and fence token and has not expired.

Production deployment uses a dedicated worker process by default. The process owns its adapter,
Workers, optional probe-only listener, termination signals, bounded drain, and final resource close.
Framework co-hosting remains available but is not the default scaling boundary. See
[`worker-processes.md`](worker-processes.md) and
[ADR 0012](decisions/0012-dedicated-worker-processes.md).

The operator dashboard is a separate boundary from the worker fleet. It is a framework-neutral
request host that reads everything it shows from PostgreSQL, including worker identity and runtime
state, so it can be mounted in a process that runs no workers at all. Mounting requires only a
database connection.

## Data model

```mermaid
erDiagram
  job ||--o{ enqueue_idempotency : "owns retained enqueue keys"
  job ||--o| job_runtime : "live lifecycle"
  job ||--o| job_outcome : "terminal lifecycle"
  job ||--|| job_query : "operator projection"
  job ||--o{ job_redrive : "failed source"
  job ||--o| job_redrive : "redrive target"
  job ||--o{ job_checkpoint : "records restart boundaries"
  job ||--o| job_progress : "reports latest progress"
  job ||--o{ job_wait : "records timer boundaries"
  job ||--o{ job_event : "emits"
  job ||--o{ attempt_history : "closes attempts"
  schedule_definition ||--o{ schedule_occurrence : "fires"
  schedule_occurrence }o--o| job : "enqueues"

  job {
    uuid id PK
    text queue_name
    text job_type
    jsonb payload
    int max_attempts
    jsonb retry_policy
    timestamptz created_at
  }
  enqueue_idempotency {
    text idempotency_scope PK
    bytea idempotency_key_hash PK
    jsonb request_fingerprint
    uuid job_id FK
    timestamptz expires_at
    timestamptz created_at
  }
  job_runtime {
    uuid job_id PK
    text queue_name
    text state
    int current_attempt
    bigint fence_token
    timestamptz run_at
    bigint sequence
    text worker_id
    timestamptz expires_at
    text wait_name
    timestamptz attempt_started_at
    timestamptz cancel_requested_at
    text cancel_requested_by
    text cancel_reason
    bigint previous_retry_delay_ms
  }
  job_outcome {
    uuid job_id PK
    text state
    int current_attempt
    bigint fence_token
    jsonb result
    jsonb error
    timestamptz finished_at
  }
  job_query {
    uuid job_id PK
    text queue_name
    text job_type
    text state
    int current_attempt
    timestamptz run_at
    timestamptz created_at
    timestamptz updated_at
  }
  job_redrive {
    uuid source_job_id PK
    bytea request_id_hash PK
    uuid target_job_id UK
    text requested_by
    text reason
    jsonb request_fingerprint
    timestamptz requested_at
  }
  job_checkpoint {
    uuid job_id PK
    text checkpoint_name PK
    jsonb checkpoint_value
    int attempt
    bigint fence_token
    text worker_id
    timestamptz created_at
  }
  job_progress {
    uuid job_id PK
    jsonb progress_value
    bigint revision
    int attempt
    bigint fence_token
    text worker_id
    timestamptz created_at
    timestamptz updated_at
  }
  job_wait {
    uuid job_id PK
    text wait_name PK
    text mode
    bigint duration_ms
    timestamptz requested_wake_at
    timestamptz wake_at
    int attempt
    bigint fence_token
    text worker_id
    timestamptz created_at
  }
  schedule_definition {
    text namespace PK
    text schedule_name PK
    text cron_expression
    text queue_name
    text job_type
    jsonb payload
    jsonb retry_policy
    boolean enabled
  }
  schedule_occurrence {
    text namespace PK
    text schedule_name PK
    timestamptz occurrence_at PK
    uuid job_id UK
  }
```

For every accepted job, exactly one of `job_runtime` and `job_outcome` must exist after a committed transition. SQL functions preserve this lifecycle exclusivity atomically.

### `job`

Insert-only identity, routing, payload, retry budget, normalized optional retry policy, and acceptance time. Dispatch reads payload only after a runtime row has been claimed. The policy is one of fixed `{delayMs}`, exponential `{initialDelayMs,multiplier,maxDelayMs}`, or decorrelated jitter `{baseDelayMs,maxDelayMs}`.

### `enqueue_idempotency`

PostgreSQL-owned scoped enqueue ownership, separate from stable job identity and dispatch. The primary key `(idempotency_scope, idempotency_key_hash)` serializes competing callers through one scoped unique owner. The hash is the full SHA-256 of the scope/key ownership input; raw keys are never persisted. Scope defaults to `default`; TTL defaults to 24 hours; keys are 1 through 512 UTF-8 bytes; scopes are 1 through 256 UTF-8 bytes; and TTL is an integer from 1 millisecond through 365 days.

The stored canonical fingerprint covers queue, type, payload, sorted tags, `maxAttempts`, normalized `retryPolicy`, TTL, and explicitly supplied `runAt`. An omitted `runAt` stays omitted for keyed immediate ingress instead of capturing the classification timestamp. Exact replay returns the bound job ID before job, event, runtime, FIFO-sequence, or notification side effects. A mismatch raises a structured conflict and aborts the whole statement or caller transaction. Requests without `options.idempotency` bypass this relation and retain the prior always-create behavior.

The ownership relation stores scope and full key hash, never the raw key. The initial `enqueued` event, UI projections, and errors expose only a bounded key preview plus 12-hex key digest; exact replay appends no event. Structured conflicts additionally carry full SHA-256 stored and rejected request digests. Expired ownership can be replaced by a new request. Housekeeping prunes expired bindings before terminal job identity, and purging ready or scheduled jobs releases their bindings with the job.

### `job_runtime`

The only mutable lifecycle relation. Its check constraint makes state-specific fields mutually exclusive:

- `scheduled`: `run_at` is populated; ready and ownership fields are null; `wait_name` and `attempt_started_at` are either both null for enqueue/retry delay or both populated for a durable timer
- `ready`: `ready_at` and FIFO `sequence` are populated; ownership fields and `wait_name` are null; a resumed timer may preserve `attempt_started_at`
- `active`: worker, acquisition, heartbeat, expiry, positive fence, and logical `attempt_started_at` are populated; ready placement and `wait_name` are null; optional cancellation-request timestamp, attribution, and reason are all present or all absent

Retry and recovery increment `current_attempt` while moving the same row back to ready or scheduled. Named durable timer suspension preserves `current_attempt`, because waiting is successful control flow rather than failure; promotion and the next claim continue the same logical attempt with a new fence. `previous_retry_delay_ms` stores only the previous decorrelated-jitter selection needed for the next deterministic step and is cleared for other policy types.

PostgreSQL validates policy shape and numeric bounds, selects the delay, performs the state transition, and writes provenance. Explicit persisted policies apply consistently to handler failure and expired-lease recovery. When policy is omitted, compatibility remains path-specific: handler failure uses the legacy Sidekiq-inspired random delay `(count ** 4) + 15 + floor(random() * 10) * (count + 1)` seconds, while lease recovery is immediate. Numeric `Queue.fail` delays, numeric or callback-derived `WorkerOptions.retryDelayMs`, and explicit `Queue.recoverExpired` delays take precedence, including zero. A worker callback may return `undefined` to omit the override and defer to PostgreSQL. Retry-budget enforcement remains in SQL regardless of delay source.

All delay fields are integers from zero through 31,536,000,000 milliseconds (365 days). Exponential `multiplier` is an integer from 1 through 100, and `maxDelayMs` must be at least `initialDelayMs` or `baseDelayMs`. Decorrelated jitter hashes stable job identity, current attempt, and persisted previous delay, so replay and `Queue` recreation select the same value.

Selective indexes keep unrelated states out of each access path:

| Index                            | Predicate             | Purpose                                                     |
| -------------------------------- | --------------------- | ----------------------------------------------------------- |
| `job_runtime_ready_idx`          | `state = 'ready'`     | Queue-local FIFO claims by `(queue_name, sequence, job_id)` |
| `job_runtime_scheduled_idx`      | `state = 'scheduled'` | Bounded due promotion by `(run_at, job_id)`                 |
| `job_runtime_expired_active_idx` | `state = 'active'`    | Bounded recovery by `(expires_at, job_id)`                  |

The table uses fillfactor 70 because heartbeat and lifecycle updates are intentional churn. State changes can still require index maintenance when rows enter or leave a partial index.

### `job_outcome`

Semantically immutable terminal state. Completion, terminal failure, or cancellation deletes runtime and inserts the outcome in one transaction. Succeeded rows contain `result`; failed rows contain `error`; canceled rows contain the bounded cancellation envelope. Those semantic columns never change. The retention-only `history_through_at` watermark may advance when later append-only history is attributed to the terminal identity. Never-started cancellation uses fence zero and has no attempt row, while started cancellation retains ownership provenance. Terminal jobs no longer occupy dispatch indexes. Automated retention never deletes an outcome alone: it removes the stable terminal job only after both identity and outcome minimum windows have elapsed and no retained history still attributes to that identity.

Failed outcomes additionally have one cold partial index ordered by immutable completion time and identity. `list_dead_letters_v1` uses it for bounded cursor pages and joins immutable `job` definition only after selecting terminal candidates. This index is not a dispatch path and claim never reads it.

### `job_query`

A bounded operator projection maintained in the same transaction as runtime and outcome lifecycle changes. It stores routing, state, current attempt, run time, cancellation-request metadata, immutable creation time, and the last meaningful lifecycle update. It deliberately excludes payload, result, error, checkpoints, waits, worker ownership, heartbeat, and lease expiry.

`list_jobs_v1` selects a page from dedicated global, queue, type, or state creation-time indexes before joining immutable `job` rows for optional payload projection. Heartbeats do not update the projection, and no query index is added to `job_runtime`. Pages use immutable `(created_at, job_id)` keys and a filter/projection-bound signature. Cross-page state membership is weakly consistent until snapshot pagination is implemented.

Payload is omitted by default. When requested, PostgreSQL applies bounded top-level redaction before checking the response byte ceiling and returns explicit omission status. These controls bound disclosure and returned size for selected rows, not accepted payload size or requested detoasting work.

### `job_redrive`

Insert-only source-to-target lineage and operator audit. The source/request hash primary key serializes exact replay, while unique target identity gives every new execution one parent. Raw request IDs are never stored. The row retains safe request preview/digest/length, actor, reason, canonical request fingerprint, source and initial target states, and request time.

`redrive_v1` accepts only a retained failed source. It creates a fresh ready job with copied queue, type, payload, tags, attempt budget, retry policy, and execution timeout, but clears the old absolute deadline and never copies checkpoint, wait, attempt, result, or cancellation state. Source and target events plus the lineage row commit atomically; the original outcome's semantic terminal columns are never updated, while its retention watermark follows the normal history-attribution rule. Exact replay returns the existing target, while a changed actor or reason under the same source/request identity conflicts. `redrive_many_v1` applies the same transition to an oldest-first bounded candidate page, accepts a keyset cursor for deterministic backlog progression, and performs no writes in dry-run mode.

The source foreign key protects lineage: terminal identity pruning skips any source with a retained descendant edge. Target deletion cascades its inbound edge, allowing ancestors to become eligible later under the normal retention windows. `Queue.getRedriveLineage` traverses the retained connected graph with an explicit bound and truncation flag.

### `job_checkpoint`

Insert-only named JSON results at explicit handler restart boundaries. The primary key `(job_id, checkpoint_name)` makes each name immutable for the stable job identity, so retries can reuse completed steps. `save_checkpoint_v1` locks and verifies the exact active, unexpired worker/fence generation before inserting, serializing the write against completion, failure, and lease recovery. Attempt, fence, worker, and creation time preserve ownership provenance. Equal repeated saves return the existing row; a different value conflicts.

`HandlerContext.checkpoint(name, operation)` reads an existing value before running user code and coalesces overlapping calls for the same name inside one handler. It does not make external effects exactly once: a process can disappear after an external system commits but before the checkpoint transaction commits.

Values are limited to 1 MiB of PostgreSQL's canonical JSONB text representation, giving every language client one authoritative definition. Checkpoints intentionally have no independent retirement path because deleting a completed name while retaining a retryable job could repeat that step. They cascade only when the stable parent job identity is deleted, so future job-retention policy must account for checkpoint storage.

### `job_progress`

One latest-value mutable projection for operational progress, kept separate from immutable payload,
checkpoint, and outcome fields. `update_progress_v1` serializes on the active runtime row and accepts only
the exact unexpired worker/fence generation. Accepted changes increment a monotonic revision and replace
attempt, fence, worker, and update-time provenance. Identical values are no-ops.

Values are limited to 64 KiB of canonical JSONB text. One fence may commit a changed value at most every
100 milliseconds; a new ownership generation may report immediately. Each accepted change emits a bounded
`progress_updated` event with revision and byte size but not the value. The latest projection survives retry
and terminal materialization and cascades only with the stable parent identity.

### `job_wait`

Insert-once named timer boundaries for a stable job identity. Relative sleeps store the first PostgreSQL-computed wake timestamp and are first-write-wins by name; absolute waits conflict if replay supplies a different target or changes mode. `schedule_wait_v1` locks and revalidates the active generation, then either returns an elapsed row or atomically moves runtime to scheduled without consuming an attempt. Rows retain attempt, fence, worker, and creation provenance and leave dispatch eligibility in `job_runtime`.

Code after a wait resumes by replaying the handler from its entry point. Work before the wait must itself be idempotent or checkpointed. Names are limited to 200 characters, durations to 365 days, and one job to 1,000 timer names. Waits cascade only with the stable parent job identity.

### `retention_policy`

One singleton row is the target database's authoritative retention policy. `sync_retention_policy_v1` and `Queue.syncRetentionPolicy` set explicit nullable minimum windows for job identity, terminal outcome, job events, attempt history, and schedule occurrences, plus bounded work limits. Every category defaults to 14 days and remains configurable; null disables automatic deletion for that category.

Identity is the attribution anchor. Finite terminal-job retention requires both identity and outcome windows, finite event, attempt, and occurrence windows, and an identity minimum at least as long as every dependent minimum. PostgreSQL rejects configurations that could remove an identity before its retained provenance. Windows are minimums rather than deletion deadlines because bounded cleanup or retained dependent rows can safely extend actual retention.

### History

`job_event` is the append-only lifecycle audit. `attempt_history` contains one immutable row for every closed logical attempt, including retry, lease expiry, success, terminal failure, and cancellation after an attempt actually started. Its `started_at` preserves the logical attempt start across timer suspensions, while `claimed_at` identifies the final activation that closed it. Timer suspension itself emits events but does not close attempt history. Both history relations use UTC-daily range partitions with default fallbacks. Clean installation creates the current day plus three future days, and `prepare_history_partitions_v1` continuously replenishes and repairs that horizon.

`list_job_timeline_v1` merges retained rows from both history relations into one latest-first cursor stream ordered by event/attempt time, kind rank, and immutable record identity. Event details and attempt errors are operator evidence rather than job payload and are not changed by payload redaction. Since retention is independent, an existing identity can legitimately return partial or empty history.

Event and attempt retention are independent phases inside `retain_history_v1`. Each drops only fully expired completed daily partitions, retires at most the configured number per pass, skips busy day locks, caps DDL lock waits at 250 ms, and bounded-deletes expired rows from its own default partition. Explicit day creation and paired retirement functions remain available for controlled operator work. Default partitions preserve insert availability when partition maintenance is late, while health reports exact counts through 10,000 rows and explicit capped lower bounds beyond that so fallback spill cannot remain invisible or make health unbounded.

History tables intentionally do not carry reverse foreign keys to `job`, because dropping a daily partition must not probe every retained partition during parent deletion. Instead, an insert trigger locks and verifies the parent identity and advances its history boundary. A global retained-through watermark advances only after both history categories are completely cleared before their cutoffs. `prune_terminal_storage_v1` may delete a terminal identity only behind that watermark; `purge_queue_v1` explicitly deletes associated history before deleting queued identities. Direct application SQL that deletes package-owned `job` rows is unsupported because it can bypass these guards.

### `job_stat_bucket` and `job_stat_state`

Rolling statistics are the operator read path for anything expressed as a time window. Without them a page like "throughput over the last 24 hours" scans every retained event and attempt, which makes an auto-refreshing dashboard cost proportional to throughput and turns operator curiosity into database load exactly when the system is busiest.

`job_stat_bucket` holds one row per closed minute per `(queue_name, job_type)`. Measures are split by grain and never conflated: `enqueued` and the `job_*` columns count jobs, the `attempt_*` columns count closed attempts, so a job that retried four times before succeeding contributes one `job_succeeded` and five attempts. Each row also carries the latest attempt error in its minute, which is what lets the failing-types panel name a cause without reading history at all. First-attempt wait percentiles are deliberately not rolled up: exact percentiles are not mergeable across buckets, and a histogram that would be was measured as both less accurate and slower at realistic volumes.

`aggregate_stats_v1(from, to)` is the single definition of what a bucket means. `rollup_stats_v1` materializes it for fully elapsed minutes and advances the `job_stat_state` watermark; `stat_buckets_v1(from, to)` reads materialized buckets below the watermark and evaluates the same aggregation live above it. A window is therefore correct the instant a job runs, without waiting for a rollup pass, and a rollup that is behind costs a longer live tail rather than a wrong answer.

Each pass rewrites the last few closed minutes. A bucket is a pure function of the raw history in its minute, so a transaction that commits its history row after its own minute closed is absorbed by the rewrite instead of being lost, and running the pass twice converges rather than double counting. Cardinality is bounded per bucket: pairs beyond the group limit are folded into the `__other__` job type within their own queue, so generated job types cannot make statistics grow without limit.

The watermark is a retention interlock. Raw history is the only input a bucket can be rebuilt from, so `retain_history_v1` clamps its event and attempt cutoffs to `rolled_up_through`. A stalled rollup holds history and surfaces as growing retention lag and a rising `QueueHealth.statistics.lagMs`, rather than silently deleting the input to a window nobody has computed yet.

Buckets are a sixth retained category with its own configurable window, defaulting to 14 days and bounded per pass like every other prune. It sits outside the `job_identity >= dependents` constraint on purpose: a bucket summarizes jobs rather than attributing one, so keeping aggregates long after their source events are gone is the intended configuration rather than a violation.

Workers run `rollup_stats_v1` on `WorkerOptions.statisticsRollupIntervalMs`, one minute by default and matching the bucket width, before the retention pass in the same cycle so the pass can reclaim the history it just summarized. Passes serialize on a transaction-scoped advisory lock, so every worker may run it. Setting the interval to zero opts out: windows stay fully derived and history retention holds at the current watermark.

Full reference in [`rolling-statistics.md`](rolling-statistics.md); the design tradeoffs are recorded in [ADR 0019](decisions/0019-derived-rolling-statistics.md).

### `worker_registry`

One row per live worker process, keyed by the durable `worker_id` used for leases and attempt history. `register_worker_v1` is a single round trip that both publishes the runtime state the worker owns — `queue_name`, `concurrency`, `active_slots`, `draining` — and returns the operator-requested `paused` flag that PostgreSQL owns. Workers call it on `WorkerOptions.registryIntervalMs`, five seconds by default.

The relation exists because process-local memory cannot answer "which workers exist" once workers are deployed independently of the web tier. It is what allows an operator surface to report and control a fleet it does not host. It is never read by the claim path and holds one row per worker, so it cannot affect dispatch cost.

Ownership is deliberately split. A worker may not write `paused`, and an operator may not write the runtime columns. `set_worker_paused_v1` records the flag plus bounded `paused_by` and `paused_reason` attribution and returns no rows for an unregistered worker. The flag is scoped to a process incarnation. Each worker announces a fresh `instance_id`, and `register_worker_v1` keeps the pause only while that instance keeps refreshing; a new instance of the same worker id clears the flag and its attribution. Without that column PostgreSQL could not tell a routine heartbeat from a restart, and the flag would be either indefinitely sticky or cleared by the worker's own next heartbeat. Durable "stop this work" belongs to queue pause.

Pause is cooperative in exactly the sense cancellation is: the worker stops claiming at its next refresh, a handler already executing runs to completion, and a local `Worker.resume()` cannot clear a still-effective operator pause. Attribution is not authorization; callers enforce their own permission checks.

Graceful shutdown calls `deregister_worker_v1`. A killed worker simply stops refreshing, is reported offline once its registration goes stale, and is removed by the bounded `prune_worker_registry_v1`. Reported slot use is therefore eventually consistent with the worker's real event loop, and should be read as an operational indicator rather than a synchronous cross-process read.

### `maintenance_policy` and `maintenance_state`

The singleton maintenance policy stores one validated IANA timezone, a six-hour partition-preparation interval, a five-minute terminal-cleanup interval, and local history-retention hour 03:00 by default. Maintenance state stores independent last-run timestamps, the last retained local date, and the history-retention watermark. Workers poll all three tasks every minute by default, while PostgreSQL performs the global due check and advisory-lock coordination.

### Declarative schedules

`schedule_definition` is the target database's desired-state record for one deployment namespace. It stores validated cron text, a typed Workhorse job definition, and a monotonically increasing revision, never arbitrary SQL. Removed definitions are disabled rather than deleted so occurrence history remains attributable.

`schedule_occurrence` provides one durable key per `(namespace, schedule_name, occurrence_at)` second. `fire_schedule_v1` inserts that key and enqueues through `enqueue_v1` in one transaction. A repeated fire for the same second returns the existing job ID instead of creating another job.

Scheduling metadata lives entirely in the target database. Workers evaluate cron expressions in process with `cron-parser` and call revision-fenced `fire_schedule_v1`, `tick_v1`, and the three bounded maintenance tasks. Transaction-scoped advisory locks and persisted due state make concurrent callers no-ops, so schedules fire once and each maintenance task runs once per database cadence regardless of worker count, while any surviving worker keeps schedules alive.

## Atomic lifecycle

```mermaid
stateDiagram-v2
  [*] --> ready: enqueue due
  [*] --> scheduled: enqueue future
  ready --> canceled: cancel immediately
  scheduled --> canceled: cancel immediately
  scheduled --> ready: promote
  ready --> active: claim
  active --> active: heartbeat / cancel request
  active --> canceled: exact-fence acknowledgement or requested lease expiry
  active --> scheduled: named durable wait, same attempt
  active --> ready: fail/recover, selected or overridden zero delay
  active --> scheduled: fail/recover, selected or overridden positive delay
  active --> succeeded: complete
  active --> failed: exhausted fail/recovery
```

### Enqueue

`enqueue_many_v1` parses and validates at most 1,000 requests against one timestamp, including optional persisted retry policies. One statement inserts `job`, `job_runtime`, and `enqueued` events. Input ordinality controls returned IDs and ready sequence allocation. Any invalid member rolls back the entire batch. Commit-delivered `NOTIFY workhorse_jobs` is coalesced to one notification per distinct queue that gained ready work.

### Promotion

`promote_v1` locks a bounded due set with `FOR UPDATE SKIP LOCKED`, updates those runtime rows from scheduled to ready, assigns new FIFO sequences, appends events, and emits a wake hint. Every promoted row emits `promoted`; its locked `due` CTE also carries any durable `wait_name` through the update so timer-backed rows append `wait_elapsed` before the marker is cleared.

Production maintenance is worker-owned and split by cadence and failure domain.

Each worker calls `tick_v1` at most once per configured `maintenanceIntervalMs` (default one second). Under the transaction-scoped `workhorse:tick` advisory lock it performs bounded promotion and bounded expired-lease recovery, the two dispatch-latency-critical phases. Concurrent callers return immediately with `skipped_lock = true`. The same cadence drives in-process schedule evaluation.

Each worker polls `prepare_history_partitions_v1`, `retain_history_v1`, and `prune_terminal_storage_v1` at most once per configured `maintenanceTaskPollMs` (default 60 seconds). PostgreSQL checks persisted due state under a task-specific advisory lock. Partition preparation defaults to every six hours, terminal storage cleanup to every five minutes, and history retention to once per local date at or after 03:00 in the configured IANA timezone. None shares the promotion advisory lock. Partition retirement abandons a DDL lock attempt after 250 ms rather than waiting indefinitely behind dispatch. Every phase runs in its own exception subtransaction, so one cleanup failure is reported without rolling back successful sibling phases.

Terminal-job pruning selects a bounded candidate window of identities with outcomes, both minimum windows elapsed, no live runtime, no retained schedule occurrence, and history boundaries behind the global retained-through watermark. The bounded delete cascades outcome, checkpoints, and waits. History insert triggers serialize with parent deletion and move the watermark backward for late old history, while queue purge explicitly removes history before identity.

All maintenance functions return one row per phase, `(phase, rows_affected, duration_ms, skipped_lock, error)`. The worker records this telemetry per loop, exposes it through `worker.maintenanceTelemetry()`, and forwards each row to the optional `onMaintenance` callback. Between passes a worker issues only the claim query.

### Durable timer suspension

`schedule_wait_v1` accepts either a relative bigint duration or an absolute timestamp, locks the exact active worker/fence generation, and rechecks lease expiry after acquiring the runtime lock. A first future target inserts `job_wait`, changes runtime to wait-marked scheduled state, clears ownership, and emits `wait_scheduled`. A first past-due target is still recorded but leaves runtime active and returns elapsed. Relative replay returns the first stored target even if later configuration supplies another duration; absolute target or mode changes conflict. Reaching an elapsed name emits `wait_replayed`.

Suspension aborts the handler's cooperative signal and exits through private worker control flow, so the heartbeat stops and the worker slot is free for another claim. It does not call failure or completion and does not increment attempts. Normal promotion later makes the same logical attempt claimable with a new fence. Wake latency is bounded by maintenance cadence and worker availability, not by an exact wall-clock guarantee. Queue health reports the number of sleeping and overdue waits plus the next durable wake target.

### Claim

`claim_v1` selects one queue-local ready row by FIFO sequence with `SKIP LOCKED`. One runtime update changes it to active and installs worker, global fence, acquisition, heartbeat, and expiry data. The claim event is appended before the function returns identity, payload, and normalized `retryPolicy`. No transaction remains open while user code runs.

### Worker concurrency and lifecycle

`WorkerOptions.concurrency` accepts an integer from 1 through 100 and defaults to 1. The configured value
is exposed as readonly `worker.concurrency`. `worker.runtimeState()` returns the process-local snapshot
`{ concurrency, activeSlots, paused, draining }`; it is an operational view of this object, not durable
liveness or membership state.

One claim pass fills only currently free slots. Claims remain serial because each `claim_v1` transition is
an independent correctness-sensitive database operation. Each successful claim starts one independent
per-job handler task; the fill loop stops when all free slots are occupied or the first claim returns null.
This bounds claim and connection pressure without serializing user handlers. A handler slot remains active
through completion, retry/failure handling, or durable-wait suspension, and every active job owns its own
heartbeat timer, abort controller, fence checks, and final transition.

`pause()` prevents later claims while maintenance and active jobs continue. `resume()` clears the pause and
makes claims immediately eligible. `stop()` enters draining state, prevents later claims, and allows every
already active handler and its final fenced transition to finish before `run()` resolves. These controls do
not impose global rate limits, queue weights, or concurrency budgets across worker processes.

### Heartbeat

`heartbeat_v2` locks the exact active worker/fence generation and returns `accepted`, `cancel_requested`, `deadline_exceeded`, `timeout_exceeded`, or `stale`. It extends the lease only for `accepted`. Additive `heartbeat_v1` compatibility returns `true` only for `accepted`, so existing callers still stop treating canceled or stale work as owned.

### Cancellation

`cancel_v1` locks the sole runtime row, serializing cancellation with completion, failure, checkpoint, wait, heartbeat, and recovery. Ready, future-scheduled, and durable-wait continuations delete runtime and insert one immutable `canceled` outcome immediately. Never-started work emits no attempt history. A durable wait whose logical attempt already started closes exactly one canceled attempt using retained provenance.

For active work, the first request stores its timestamp, optional `requestedBy`, and optional reason, then appends one `cancel_requested` event. Repeats retain the first committed metadata. Heartbeat status aborts the handler's `AbortSignal` with `CancellationRequestedError`. `acknowledge_cancel_v1` accepts only the exact unexpired worker/fence and creates one canceled outcome, attempt row, and terminal event. If the handler ignores the signal until expiry, bounded recovery materializes cancellation instead of retrying.

Cancellation is cooperative, not an out-of-band lease revocation. JavaScript cannot be forcibly interrupted and external effects remain at least once. Handlers should observe `AbortSignal`, stop beginning new effects, and use provider idempotency, outbox/inbox, or compensation. `requestedBy` is audit attribution only; authorization belongs to the calling application or operator layer.

Cancellation versus completion or failure is first-committer-wins because all terminal paths own the same runtime lock and exclusivity invariant. After cancellation commits, stale completion, failure, checkpoint, wait, heartbeat, and acknowledgement calls cannot recreate runtime or overwrite outcome. After success or failure commits, cancellation reports that existing terminal state. Repeated terminal requests do not duplicate events, outcomes, or attempt history.

A recurring schedule owns definitions and occurrence deduplication, not the lifecycle of every fired job. Canceling one occurrence does not disable the definition, change its revision, or prevent the next occurrence from enqueueing independently.

### Deadlines and execution timeouts

An optional enqueue deadline is an absolute wall-clock boundary on the stable job identity. It keeps
advancing while work is ready, scheduled, waiting, retrying, or active. PostgreSQL prevents an expired
job from entering a new claim and materializes one immutable failed outcome with deadline-specific
evidence. A deadline never creates another attempt.

An optional execution timeout is a budget for one logical attempt. Active execution consumes the
budget, while a named durable wait releases the lease and pauses that accounting. If the timeout is
reached, PostgreSQL closes the attempt with timeout-specific history and either schedules the next
attempt through the persisted retry policy or materializes terminal failure when the retry budget is
exhausted.

Ordinary handlers should complete within 110 seconds so rolling deployments retain practical drain
headroom. Longer operations should use durable execution boundaries: idempotent stages, named
checkpoints, and lease-releasing waits. The recommendation is not a hard database limit because
deployment grace periods vary, but applications should set execution timeouts deliberately rather
than relying on an unbounded handler.

The worker mirrors authoritative timestamps with local timers only for prompt cooperative delivery.
The handler receives a distinct `AbortSignal` reason, but JavaScript and external effects are not
forcibly preempted. SQL transition predicates and bounded maintenance remove the live generation and
fence late completion, failure, heartbeat, checkpoint, or wait writes. Cancellation, completion,
deadline, timeout, and lease-expiry races remain row-lock ordered and first-committer-wins.

### Retry and recovery

`fail_v1` locks the matching unexpired active generation. If budget remains, it calls the PostgreSQL delay selector, compare-and-set increments the attempt, persists any next jitter state, and places the row in ready or scheduled state. Otherwise it deletes runtime and inserts a failed outcome. In both cases it closes attempt history and appends an event atomically. `retry_scheduled` details include `retry_policy`, `retry_delay_ms`, and `retry_delay_source`.

`recover_expired_v1` cooperatively locks expired active rows in bounded batches. A row carrying a cancellation request becomes canceled and does not retry. Other rows perform policy selection and increment-and-requeue or delete-and-outcome transition using the observed fence and expiry as CAS guards. `Queue.recoverExpired(limit)` passes an omitted delay as SQL `NULL`, allowing persisted policy selection; an explicit number remains an override. `lease_expired` details include the policy, selected delay, and source. Old workers cannot later complete because their active generation no longer exists.

### Terminal transitions

`complete_v1`, exhausted failure, and cancellation consume the matching runtime row. Runtime deletion, outcome insertion, any truthful attempt closure, and event append commit or roll back together. Completion and failure reject a runtime that already carries a cancellation request.

### Enqueue and replay

`enqueue_many_v1` first validates and canonicalizes every request against one classification timestamp. Keyed requests acquire deterministic sorted scoped-ownership locks before ordinal processing, preventing overlapping batches from deadlocking. Exact equivalents return the retained job ID and skip all acceptance side effects; a mismatch aborts the whole batch. New keyed and unkeyed requests then insert identity, runtime, one `enqueued` event, FIFO placement when ready, and at most one commit-delivered notification per ready queue in caller order. This preserves same-batch duplicates, caller transaction rollback, and ordinary unkeyed behavior.

## Read models and health

`Queue.getJob(id)` joins immutable `job` to both lifecycle relations and coalesces the one that exists, preserving `retryPolicy` plus cancellation-request metadata for active work. Health state counts union runtime and outcome, including canceled outcomes. Ready, scheduled, active, expired-active, and oldest-ready metrics come directly from `job_runtime`.

Retention health includes the persisted policy, oldest retained timestamps, per-category cleanup lag, counts of fully eligible event and attempt partitions, and bounded row counts for both default partitions. Fallback counts are exact through 10,000 rows; `defaultHistoryRowsCapped` marks 10,001 as a lower bound. Live jobs are excluded from terminal identity lag. History lag is based only on fully droppable partitions or expired default rows, not the intentionally retained partial boundary day.

## Delivery semantics

Workhorse provides durable at-least-once execution. Enqueue idempotency can make repeated acceptance attempts converge on one durable job identity, but it does not make handler execution or external effects exactly once. A process can die after an external effect but before completion commits, or after completion commits but before observing the response. Applications must use provider idempotency keys or transactional outbox/inbox patterns for non-idempotent effects.

Schedule occurrence deduplication prevents duplicate enqueue for one occurrence second. The worker's in-process scheduler supplies the planned occurrence slot as the key, and a per-occurrence advisory lock plus the durable key make concurrent workers racing the same fire converge on one job. This does not change handler delivery semantics: a scheduled job can still execute more than once after a worker crash.

## Deployment synchronization

`Queue.syncSchedules(namespace, definitions, { prune })` is a desired-state reconciler:

1. It validates stable namespace and schedule names plus queue job definitions, including optional retry policies.
2. It atomically upserts target definitions and by default deactivates omitted names through `sync_schedule_definitions_v1`.
3. A per-namespace advisory lock serializes concurrent deployments of the same namespace.

Because definitions live only in the target database, a deployment is one transaction: there is no second metadata database to converge. Every material definition change increments a revision, and worker fires pass the revision they loaded. A stale in-process schedule therefore becomes a no-op instead of running a new payload at an old cadence. Definition row locking also makes a disable deployment wait for a fire that already began before returning.

## Worker process lifecycle

`defineWorkerProcess()` declares a process-owned adapter and one or more worker configurations.
`startWorkerProcess()` provides framework-neutral orchestration without global signals.
`runWorkerProcess()` and `workhorse worker --config` add the standalone Node lifecycle.

The first `SIGINT` or `SIGTERM` marks readiness false and calls `stop()` on every Worker. Later claim
requests stop, active handlers and their per-job heartbeats continue, and adapter resources close only
after every run loop settles. A claim transaction already in flight may commit after shutdown begins;
that committed lease is drained rather than abandoned. Process termination does not synthesize durable
job cancellation or abort a handler.

A configurable deadline, 25 seconds by default, prevents an uncooperative handler from blocking
termination forever. A second signal exits with its conventional signal code; a missed deadline exits
with code 1. Hard termination leaves active leases for ordinary fenced expiry recovery. Any unexpected
worker-loop failure stops sibling workers, applies the same bounded drain, and fails the process so an
external supervisor can restart it.

The optional probe-only listener reports liveness while running or draining and readiness only while
accepting claims. It does not expose application HTTP ingress, queue data, or mutations.

## Operational limits

- The canonical schema is a clean-install artifact, not an online version 1 to version 2 migration.
- Only plain PostgreSQL 15+ is required; no extension beyond the default `plpgsql` is installed.
- Schedules fire only while at least one worker with matching `scheduleNamespaces` is running; scheduling drift is bounded by `maintenanceIntervalMs` and catch-up after downtime is bounded by `scheduleCatchupLimit`.
- Job, outcome, event, attempt, and schedule-occurrence retention default to 14 days and remain independently configurable. Enqueue-idempotency bindings expire by their request TTL and are cleaned before terminal identity pruning.
- Default work bounds are 1,000 terminal jobs, four history partitions per category, 10,000 default-partition rows per category, and 10,000 schedule occurrences per maintenance pass.
- Schedules have one-second precision; cron expressions are evaluated in the worker's configured timezone, for which UTC is recommended.
- Runtime updates centralize churn in one relation and require vacuum and HOT-update validation under sustained heartbeat load.
- `NOTIFY` is a wake hint. Polling remains the correctness mechanism.
- Retention operates on minimum windows. Daily granularity, bounded passes, and retained attribution can extend actual storage beyond a configured cutoff.
