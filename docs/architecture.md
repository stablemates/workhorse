# Workhorse architecture

Workhorse is a PostgreSQL-backed durable queue whose correctness-sensitive lifecycle transitions live in versioned SQL functions. The TypeScript `Queue` and `Worker` remain thin protocol clients.

The current clean-install protocol is schema version 38. Version 23 is the oldest supported
forward-migration baseline.

`installSchema` reads `sql/schema.sql`. It accepts only a fresh database or an already-current
version 38 schema. `migrateSchema` reads the single `workhorse.schema_version` row. It applies the
immutable files in `sql/migrations/` in version order.

Migration `0024-add-schema-migration-ledger.sql` takes the transaction advisory lock keyed by
`workhorse:schema-migration`. It requires version 23 and creates `workhorse.schema_migration`. It
records the version 23 baseline and version 24 step. It then replaces the schema-version row with 24.

Migration `0025-make-schedule-occurrence-replay-a-no-op.sql` takes the same advisory lock. It
requires version 24 and changes `fire_schedule_v1` so a repeated occurrence returns null. It records
the version 25 step and replaces the schema-version row with 25.

Migration `0026-add-dashboard-read-surface.sql` requires version 25. It creates the versioned
dashboard views and `dashboard_job_estimate_v1`, records the version 26 step, and advances the
schema-version row to 26.

Migration `0027-add-job-priority.sql` requires version 26. It adds immutable priority and replaces
the ready index and affected SQL contracts. It records version 27 and advances the schema row.
Migration `0028-add-keyed-debounce-enqueue.sql` requires version 27. It adds the coalescing mode to
enqueue key ownership plus `enqueue_debounce_v1` and `enqueue_many_v2`. It records version 28 and
advances the schema-version row.

Migration `0029-add-keyed-throttle-enqueue.sql` requires version 28. It extends coalescing key
ownership with `throttle`, adds `enqueue_throttle_v1`, and updates `enqueue_many_v2`. It records
version 29 and advances the schema-version row. Every migration is safe to replay after its target
version commits.

Migration `0030-add-job-dependencies.sql` requires version 29. It adds the blocked runtime state,
one-prerequisite edge, release transition, and operator projection. It records version 30 and
advances the schema row.

Migration `0031-add-fan-in-dependency-policies.sql` requires version 30. It adds bounded fan-in,
terminal policies, serialized cycle rejection, and outcome-driven resolution. It records version
31 and advances the schema row.

Migration `0032-index-dependency-failures.sql` requires version 31. It adds the partial terminal
outcome index used by dependency health and telemetry reads. It records version 32 and advances
the schema row.

Migration `0033-add-single-child-jobs.sql` requires version 32. It adds immutable parent-child
lineage, fenced child creation and suspension, result joining, and the dashboard read view. It
records version 33 and advances the schema row.

Migration `0034-add-child-fan-out.sql` requires version 33. It removes the single-child index, marks
set-created edges, and adds bounded transactional child-set creation and joining. It records
version 34 and advances the schema row.

Migration `0035-preserve-child-lineage.sql` requires version 34. It makes the parent own child-edge
lifetime, prevents terminal pruning while any child is live or within an evidence window, and adds
the bounded dashboard redrive-lineage view. It records version 35 and advances the schema row.

Migration `0036-add-idempotent-signals.sql` requires version 35. It adds retained named signal
waits, fenced lease release, and idempotent attributed delivery. It records version 36 and advances
the schema row.

Migration `0037-add-human-wait-tokens.sql` requires version 36. It adds retained human decision
context, authenticated idempotent completion, and the actionable dashboard projection. It records
version 37 and advances the schema row.

Migration `0038-harden-signal-human-waits.sql` requires version 37. It preserves human-wait
attempt provenance through cancellation and deadline terminalization. It adds `timeout_at` to
`job_signal_wait` and `job_human_wait`, plus `job_signal_wait_pending_idx`. It adds the effective
PostgreSQL deadline to `dashboard_human_wait_v1.deadline_at`. It records version 38 and advances
the schema row.

Versions below 23, versions above 38, gaps, and mixed version rows fail without running a migration.
SQL protocol functions keep their independent `_vN` suffix. A schema migration does not rename a
function or reinterpret that suffix.

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
  Operator -->|list_dead_letters_v2 / redrive_v1 / redrive_many_v1| PG
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

Workers run in dedicated processes. Each process owns its adapter,
Workers, optional probe-only listener, termination signals, bounded drain, and final resource close.
Web frameworks do not participate in worker lifecycle. See
[`worker-processes.md`](worker-processes.md) and
[ADR 0012](decisions/0012-dedicated-worker-processes.md).

`@workhorse/drizzle`, `@workhorse/prisma`, `@workhorse/typeorm`, and `@workhorse/kysely` convert
provider database and transaction objects into `Queryable`. `createDrizzleAdapter` discovers the
retained node-postgres client through `$client`. `createPrismaAdapter`, `createTypeOrmAdapter`, and
`createKyselyAdapter` accept `notificationPool`; Kysely callers can pass the pool used by
`PostgresDialect`. If that option is absent, workers use bounded polling. `forTransaction` never
commits, rolls back, disconnects, or destroys the caller's transaction. Each adapter closes
resources only through its configured `close` callback, and `WorkhorseAdapter.close()` invokes that
callback once.

`prismaQueryable` sends the statement and positional values through `$queryRawUnsafe`.
`typeOrmQueryable` sends them through `query`. Both require a row array and synthesize the
`QueryResult` metadata that core does not inspect: an empty `command`, the row-array length as
`rowCount`, zero as `oid`, and an empty `fields` array. `PrismaQueryError` and `TypeOrmQueryError`
retain the statement and original `cause` without copying parameter values into the message. Their
error-code searches process at most 16 queued entries and accept only five-character uppercase
alphanumeric codes. `PrismaQueryError` prefers `meta.code` over Prisma's outer raw-query code.
`TypeOrmQueryError` follows `driverError` and `cause`. Each adapter copies the discovered code to
its wrapper's `code` property so core can preserve typed SQL conflicts.

`kyselyQueryable` builds a `CompiledQuery.raw` from the statement and positional values, then calls
`executeQuery` on either a `Kysely` database or `Transaction`. It maps `QueryResult.rows` into the
same synthetic node-postgres metadata described above. `KyselyQueryError` retains the statement and
original `cause`, follows at most 16 nested causes, accepts only five-character uppercase
alphanumeric codes, and copies the discovered code to its wrapper.

### What an adapter must guarantee

`src/adapter.ts` owns the shared implementation of every guarantee below, exported from
`@workhorse/core` as `QueryError`, `rowsToQueryResult`, `attachNotificationPool`,
`createProviderQueryable`, `createProviderAdapter`, and `createWorkhorseAdapter`. An adapter that
uses them supplies only how its ORM runs a statement; an adapter that does not still owes the same
guarantees.

1. **Statement execution.** `query(text, values)` sends `text` unmodified with `values` as
   positional parameters, and returns a `QueryResult` whose `rows` preserve result order.
   `rowsToQueryResult` sets `rowCount` to the row-array length, `command` to the empty string,
   `oid` to zero, and `fields` to an empty array; core reads only `rows` and `rowCount`. A provider
   that answers with anything other than a row array is a failed query, not an empty result.
2. **Transaction adaptation.** `forTransaction(transaction)` returns a `Queue` bound to the
   caller's transaction and never commits, rolls back, disconnects, or destroys it.
3. **Error translation.** A failed statement throws an error extending `QueryError`, which retains
   `statement` and the original `cause` and copies the SQLSTATE to `code`. The code comes from
   `databaseErrorCode` in `src/errors.ts`: breadth-first over `cause`, `driverError`, and `meta`,
   at most 16 objects, cycle-safe, accepting only five-character uppercase alphanumeric codes, and
   preferring a nested SQLSTATE over a Prisma `P\d{4}` code that carries `meta`. Core depends on
   this to raise `EnqueueIdempotencyConflictError` for SQLSTATE `P1001` and
   `RedriveIdempotencyConflictError` for `P1002` through any ORM wrapper. Messages never copy
   parameter values.
4. **Failures that pass through untranslated.** A `QueryError` is already translated and is
   rethrown as-is rather than nested again. A `RangeError` states that the statement itself was
   malformed — a placeholder with no matching value — which is the caller's error rather than the
   database's.
5. **Notification capability.** Optional. An adapter that can lend a dedicated session sets
   `connect()`, `notificationConnectionCapacity`, and `notificationConnectionIdentity` on the
   queryable, which `attachNotificationPool` does from a node-postgres pool's `connect()` and
   `options.max`. The pool object is the sharing identity, so queryables built from one pool share
   one listener. Transaction queryables never carry the capability, because that session ends.
   Without it, workers fall back to bounded polling.
6. **Resource ownership.** An adapter closes nothing it did not create. `WorkhorseAdapter.close()`
   invokes the configured `close` callback at most once, however many times it is called.

### Queue module seams

`Queue` remains the only public facade for queue operations. Its constructor calls
`createQueueModuleContext` and `createQueueModules`. Neither function is exported from
`src/index.ts`, so internal relocations do not change the package interface.

`createQueueModuleContext` returns an immutable `QueueModuleContext`. The context contains the
`Queryable`, default queue name, and validated `QueueOptions`. Every internal module extends
`QueueModule`, which retains that context for relocated behavior.

`createQueueModules` constructs nine receivers. They are `EnqueueContractsModule`,
`ClaimLeaseFenceModule`, `CheckpointsProgressWaitsModule`, `QueueAdministrationModule`,
`WorkerRegistryModule`, `RetentionMaintenanceModule`, `CronSchedulesModule`, and
`OperatorReadsModule`, plus `ChildJobsModule` for fenced child creation and joining.

`EnqueueContractsModule.enqueue` and `enqueueMany` own enqueue serialization, tracing, telemetry,
and `P1001` conflict translation. `jobAcceptance` selects and validates the current payload
contract for direct enqueue and schedule synchronization. `validateResult` validates completion
against the contract version accepted by the claimed job. `validateQueueOptions` checks contract
configuration before `Queue` creates the immutable module context. `Queue.enqueue`,
`enqueueMany`, `syncSchedules`, and `complete` delegate these operations without changing their
public signatures. `src/queue.ts` continues to re-export the four public error classes.

`ClaimLeaseFenceModule` owns `cancel`, `claim`, `heartbeat`, `heartbeatStatus`, `expireOwned`,
`acknowledgeCancel`, `complete`, `fail`, and `recoverExpired`. `Queue` delegates without changing
its public signatures. `FencedLease` converts a `ClaimedJob` and worker ID into the exact job ID,
worker ID, and decimal fence token tuple used by every owned SQL transition in that module.
`complete` invokes the enqueue module's result-contract validation before the fenced transition. `recordRecoveryTelemetry`
remains shared with `Queue.tick`, which reports the same recovery counters from the combined
maintenance function. `rowTimestamp` and `nullableRowTimestamp` own PostgreSQL timestamp mapping
for this module and the row mappers that remain in `Queue`.

`OperatorReadsModule.validateJobListQuery` and `validateJobTimelineQuery` own the validation already
moved behind the facade. They use `validateJobListQuery`, `validateJobTimelineCursor`, and
`validatePageLimit` from `src/queue/filter-cursor.ts`. The validators enforce the limits exported as
`MAX_JOB_QUERY_PAGE_SIZE`, `MAX_JOB_QUERY_PAYLOAD_BYTES`, and `MAX_JOB_QUERY_REDACT_KEYS`.

The operator dashboard is a separate boundary from the worker fleet. It is a framework-neutral
request host that reads everything it shows from PostgreSQL, including worker identity, runtime
state, and policy provenance, so it can be mounted in a process that runs no workers at all.
Mounting requires only a database connection. Policy mutation additionally requires `operator.mode
=== "local"` and a `DashboardSettingsController`; every call carries actor, reason, request ID, and
server-assigned occurrence time.

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

  concurrency_policy {
    text queue_name PK
    text namespace
    int max_active
    int max_active_per_key
    timestamptz updated_at
  }

  rate_limit_policy {
    text queue_name PK
    text namespace
    int rate_limit
    int rate_interval_ms
    int rate_burst
    int per_key_limit
    int per_key_interval_ms
    int per_key_burst
    timestamptz updated_at
  }

  rate_limit_policy ||--o{ rate_limit_bucket : "owns token state"
  rate_limit_bucket {
    text queue_name PK,FK
    text bucket_scope PK
    text bucket_key PK
    numeric tokens
    timestamptz refilled_at
  }

  job {
    uuid id PK
    text queue_name
    text concurrency_key
    text job_type
    jsonb payload
    text contract_version
    int payload_max_bytes
    int result_max_bytes
    text[] payload_redact_keys
    text[] result_redact_keys
    jsonb trace_context
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
    text concurrency_key
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
    text concurrency_key
    text job_type
    jsonb payload
    text contract_version
    int payload_max_bytes
    int result_max_bytes
    text[] payload_redact_keys
    text[] result_redact_keys
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

Insert-only identity, routing, payload, priority, retry budget, normalized optional retry policy, acceptance time, and accepted application contract. `priority` is an integer from 0 through 100, defaults to 0, and higher values dispatch first. Dispatch reads the raw payload only after a runtime row has been claimed. The retry policy is one of fixed `{delayMs}`, exponential `{initialDelayMs,multiplier,maxDelayMs}`, or decorrelated jitter `{baseDelayMs,maxDelayMs}`.

`contract_version` is null for an uncontracted job or contains the `JobTypeContracts.currentVersion` selected at acceptance. `payload_max_bytes` and `result_max_bytes` default to 1,048,576 and accept configured values through 16,777,216. PostgreSQL measures `octet_length(value::text)` after JSONB canonicalization, and `enqueue_many_v1` rejects an oversized payload before inserting `job`, `job_runtime`, history, idempotency, or notification effects. `complete_v1` checks the persisted result limit before deleting active runtime.

`payload_redact_keys` and `result_redact_keys` each contain at most 50 unique top-level object keys of 1 through 200 characters. When a worker claims a job, `claim_v3` returns the raw payload to its handler. `workhorse.redact_top_level_keys_v1` removes persisted keys for `Queue.getJob`, `Queue.listJobs`, dead-letter listing, and dashboard task detail. Caller-supplied `JobPayloadProjection.redactKeys` are added to the persisted payload keys. Scalar and array values pass through because top-level key redaction applies only to objects. If either persisted key array is non-empty, `workhorse.redact_error_details_v1` substitutes `RedactedJobError` and a fixed message before `fail_v1` writes runtime, outcome, attempt, or event errors. `Worker` applies the same rule before recording a handler exception in OpenTelemetry.

`QueueOptions.contracts` maps a job type to `currentVersion` and a `versions` record of `JobContractVersion`. A validator returns `true` to accept a JSON value; `false` or a thrown exception becomes `JobContractValidationError` without retaining the value or validator message. Enqueue validates with the current version. `claim_v3` returns the persisted `contractVersion`, `resultMaxBytes`, and `redactErrorDetails`, so completion uses the accepted version rather than the deployment's current version. A worker without that retained version gets `JobContractUnavailableError`; `Worker` handles either contract error through the ordinary fenced failure and retry path. Reads never invoke validators, so historical payloads remain inspectable after application validation changes.

### `enqueue_idempotency`

PostgreSQL-owned scoped enqueue ownership, separate from stable job identity and dispatch. The primary key `(idempotency_scope, idempotency_key_hash)` serializes competing callers through one scoped unique owner. The hash is the full SHA-256 of the scope/key ownership input; raw keys are never persisted. Scope defaults to `default`; TTL defaults to 24 hours; keys are 1 through 512 UTF-8 bytes; scopes are 1 through 256 UTF-8 bytes; and TTL is an integer from 1 millisecond through 365 days.

The stored canonical fingerprint covers queue, concurrency key, priority, type, payload, contract version, both size limits, both redaction-key sets, sorted tags, `maxAttempts`, normalized `retryPolicy`, `prerequisiteJobId`, normalized `dependencies`, TTL, and explicitly supplied `runAt`. An omitted `runAt` stays omitted for keyed immediate ingress instead of capturing the classification timestamp. Exact replay returns the bound job ID before job, dependency, event, runtime, FIFO-sequence, or notification side effects. A mismatch raises a structured conflict and aborts the whole statement or caller transaction. Requests without `options.idempotency` bypass this relation and retain the prior always-create behavior.

### `job_dependency`

At most 100 immutable prerequisite edges per dependent job. The primary key is `(dependent_job_id, prerequisite_job_id)`. `dependent_job_id` cascades when that job identity is removed. `prerequisite_job_id` restricts deletion, so retention cannot strand blocked work or erase released lineage. `on_success`, `on_failure`, and `on_cancellation` each contain `release`, `cancel`, or `fail`. `created_at` records acceptance. Nullable `released_at` records when the prerequisite outcome resolved, and `resolution` records the selected action.

`EnqueueOptions.dependencies` accepts 1 through 100 unique stable identities plus success, failure, and cancellation policies. `EnqueueOptions.prerequisiteJobId` remains the compatible success-oriented shorthand. `enqueue_many_v1` sorts and locks every prerequisite identity inside the caller's transaction. A live prerequisite creates a `blocked` runtime plus `dependency_blocked`. Each terminal prerequisite resolves its edge according to policy. After every edge resolves, `fail` precedes `cancel`, which precedes `release`.

`resolve_job_outcome_dependencies_v1` runs after every `job_outcome` insert and calls `resolve_dependents_v1`. That function locks dependents in identity order and records each edge's `released_at` plus `resolution`. The dependent stays blocked until every edge resolves. It then chooses `fail`, `cancel`, or `release` by fixed precedence. Release moves the blocked runtime to ready or scheduled, appends one `dependency_released`, and notifies a queue that gained ready work. Failure or cancellation removes the runtime and inserts a synthetic terminal outcome with `DependencyFailed` or `DependencyCanceled`. The outcome trigger applies the same policy recursively to downstream jobs. Runtime locks serialize concurrent prerequisite outcomes at the one state transition, so evidence, FIFO allocation, and notification happen once.

`validate_job_dependency_v1` takes the transaction-scoped dependency-graph advisory lock before every edge insert. Its recursive reachability check rejects direct and transitive cycles with SQLSTATE `P1002`. The JSON detail contains `dependentJobId`, `prerequisiteJobId`, at most 101 `cycleJobIds`, and `truncated`. The trigger also enforces the 100-edge bound for SQL callers.

`Queue.getJob` and `Queue.listJobs` expose sorted `prerequisiteJobIds`, `dependencyPolicy`, the compatible singular `prerequisiteJobId` when exactly one edge exists, and `blockedReason`. `Queue.getDependencyLineage(jobId, limit)` returns at most 1,000 edges where the identity is either the prerequisite or dependent. Each `DependencyLineageRecord` contains both identities, all three terminal policies, `createdAt`, nullable `releasedAt`, and nullable `resolution`; the result sets `truncated` when another edge exists. `dashboard_job_dependency_v1` exposes the same retained edge evidence to the bounded dashboard task-detail read.

`Queue.health().dependencies` reports blocked jobs, pending edges, and retained `DependencyFailed` outcomes. Each count scans at most 10,001 matching rows, returns at most 10,000, and sets `capped` when any value is a lower bound. The failure count uses `job_outcome_dependency_failed_idx`, so it scales with matching outcomes instead of all terminal history. `Queue.queueMetricSnapshot()` splits the same bounded facts by queue and exposes `dependencyCountsCapped`. `registerQueueMetrics()` exports them as `workhorse.queue.dependencies.blocked`, `workhorse.queue.dependencies.pending_edges`, `workhorse.queue.dependencies.failed_resolutions`, and `workhorse.queue.dependencies.capped`; the only attribute is `workhorse.queue.name`.

### `job_child`

One immutable row links a parent identity to each named child. The primary key is
`(parent_job_id, child_name)`, and `child_job_id` is unique. One parent may own at most 100 children.
Names contain 1 through 200 characters. `request_fingerprint` stores the complete normalized child
request for replay comparison. `created_as_set` distinguishes `runChildren` edges from the
compatible single-child contract. `created_at` records creation, while nullable `joined_at`
records the first accepted result read.

`create_child_v1(parent_job_id, worker_id, fence_token, child_name, request)` locks and validates
the exact active, unexpired parent generation. It calls `enqueue_many_v2`, inserts `job_child`, and
adds a `job_dependency` edge from parent to child with success `release`, failure `fail`, and
cancellation `cancel`. It then moves the parent from active to blocked and clears ownership in the
same transaction. A rollback removes the child, lineage, dependency, events, and suspension.
Coalescing and additional dependency options are rejected for child requests.

Migration 0034 retains that implementation as `create_single_child_v1`. The public
`create_child_v1` wrapper rejects any `created_as_set` edge before it delegates, which keeps the
single-child replay contract compatible without letting it consume a child-set replay.

`HandlerContext.runChild(name, type, payload, options)` calls the fenced transition and suspends
the handler without consuming its logical attempt. Child success releases the parent through the
dependency resolver. The next claim has a new fence, restarts the handler from entry, and returns
the retained result when `runChild` replays. `child_created`, `parent_linked`, and the first
`child_joined` record the lifecycle. A later parent retry reads the same result without creating
another child or appending another join event. A handler that creates no child completes through
the ordinary completion path.

`create_children_v1(parent_job_id, worker_id, fence_token, children)` accepts zero through 100
unique named requests. A non-empty first call creates every child and dependency edge before it
moves the parent to blocked. Replay requires the exact names and normalized requests. It returns a
JSON object keyed by child name only after every child succeeds. The object may not exceed the
parent job's `result_max_bytes`; an oversized join returns `result_too_large` without copying the
object to the client. `children_created` and `children_joined` each append once per set.

The version 1 set policy requires every child to succeed. Each edge declares success `release`,
failure `fail`, and cancellation `cancel`. If more than one rejected outcome exists, failure takes
precedence over cancellation, then prerequisite identity breaks ties. Terminal evidence names the
prerequisite whose resolution selected the parent outcome, regardless of settlement order.

`HandlerContext.runChildren(children)` exposes that transition. Zero children return `{}` without
suspension. Any child failure fails the parent after all edges resolve. Cancellation cancels the
parent unless failure takes precedence. Retry and duplicate dependency wakeups reuse the same
edges and results without appending another join event. `ChildResultLimitExceededError` reports
the measured and configured aggregate result sizes.

Child failure fails the parent, while child cancellation cancels it. Canceling a blocked parent
does not cancel the child, and a later child outcome cannot resurrect that terminal parent.
`ChildLeaseLostError`, `ChildConflictError`, and `ChildLimitExceededError` distinguish stale
ownership, a changed replay, and an oversized child set. The single-child function returns
`limit_exceeded` when any set-created edge exists, so callers cannot mix the two replay contracts.

`Queue.getJob` and `Queue.listJobs` expose `parentJobId` and sorted `childJobIds`.
`Queue.getChildLineage(jobId, limit)` returns at most 1,000 edges in either direction and reports
truncation. Each record includes the child's terminal state and bounded error when available.
`dashboard_job_child_v1` gives the dashboard the same lineage. The parent owns edge
lifetime. `prune_terminal_jobs_v1` refuses to prune it while any linked child is live or has not
crossed the identity, outcome, and history cutoffs. Parent deletion then removes dependency and
child edges atomically, so the next pass can reclaim children without a foreign-key cycle.

`Queue.health().children` reports waiting parents, live children, unjoined successful results, and
retained parents that child policy failed or canceled. Each count scans at most 10,001 matching
rows, returns at most 10,000, and sets `capped` when any value is a lower bound.

The ownership relation stores scope and full key hash, never the raw key. The initial `enqueued` event, UI projections, and errors expose only a bounded key preview plus 12-hex key digest; exact replay appends no event. Structured conflicts additionally carry full SHA-256 stored and rejected request digests. Expired ownership can be replaced by a new request. Housekeeping prunes expired bindings before terminal job identity, and purging ready or scheduled jobs releases their bindings with the job.

### `job_runtime`

The only mutable lifecycle relation. Its check constraint makes state-specific fields mutually exclusive:

- `scheduled`: `run_at` is populated; ready and ownership fields are null; `wait_name` and `attempt_started_at` are either both null for enqueue/retry delay or both populated for a durable timer
- `blocked`: `run_at` preserves the requested dispatch time; ready, ownership, wait, and attempt-start fields are null; no dispatch partial index contains the row
- `ready`: `ready_at` and FIFO `sequence` are populated; ownership fields and `wait_name` are null; a resumed timer may preserve `attempt_started_at`
- `active`: worker, acquisition, heartbeat, expiry, positive fence, and logical `attempt_started_at` are populated; ready placement and `wait_name` are null; optional cancellation-request timestamp, attribution, and reason are all present or all absent

`job_runtime.priority` duplicates immutable `job.priority` so claim can remain on the ready index. Retry, recovery, durable waits, and promotion preserve it while moving the same row between live states. Retry and recovery increment `current_attempt` while moving the same row back to ready or scheduled. Named durable timer suspension preserves `current_attempt`, because waiting is successful control flow rather than failure; promotion and the next claim continue the same logical attempt with a new fence. `previous_retry_delay_ms` stores only the previous decorrelated-jitter selection needed for the next deterministic step and is cleared for other policy types.

PostgreSQL validates policy shape and numeric bounds, selects the delay, performs the state transition, and writes provenance. Explicit persisted policies apply consistently to handler failure and expired-lease recovery. When policy is omitted, compatibility remains path-specific: handler failure uses the legacy Sidekiq-inspired random delay `(count ** 4) + 15 + floor(random() * 10) * (count + 1)` seconds, while lease recovery is immediate. Numeric `Queue.fail` delays, numeric or callback-derived `WorkerOptions.retryDelayMs`, and explicit `Queue.recoverExpired` delays take precedence, including zero. A worker callback may return `undefined` to omit the override and defer to PostgreSQL. Retry-budget enforcement remains in SQL regardless of delay source.

All delay fields are integers from zero through 31,536,000,000 milliseconds (365 days). Exponential `multiplier` is an integer from 1 through 100, and `maxDelayMs` must be at least `initialDelayMs` or `baseDelayMs`. Decorrelated jitter hashes stable job identity, current attempt, and persisted previous delay, so replay and `Queue` recreation select the same value.

Selective indexes keep unrelated states out of each access path:

| Index                            | Predicate             | Purpose                                                                   |
| -------------------------------- | --------------------- | ------------------------------------------------------------------------- |
| `job_runtime_ready_idx`          | `state = 'ready'`     | Strict-priority claims by `(queue_name, priority DESC, sequence, job_id)` |
| `job_runtime_scheduled_idx`      | `state = 'scheduled'` | Bounded due promotion by `(run_at, job_id)`                               |
| `job_runtime_expired_active_idx` | `state = 'active'`    | Bounded recovery by `(expires_at, job_id)`                                |

The table uses fillfactor 70 because heartbeat and lifecycle updates are intentional churn. State changes can still require index maintenance when rows enter or leave a partial index.

`concurrency_key` is null or a non-empty UTF-8 string through 256 bytes. `job` retains the accepted value, while `job_runtime` duplicates it for admission without joining lifetime identity. The key is queue-scoped. Keyless jobs consume only queue capacity.

`job_runtime_active_queue_key_expiry_idx` contains only active rows and orders them by queue, concurrency key, expiry, and job identity. `claim_v3` uses it to count live admission pressure without scanning terminal jobs or history.

### `job_outcome`

Semantically immutable terminal state. Completion, terminal failure, or cancellation deletes runtime and inserts the outcome in one transaction. Succeeded rows contain `result`; failed rows contain `error`; canceled rows contain the bounded cancellation envelope. Those semantic columns never change. The retention-only `history_through_at` watermark may advance when later append-only history is attributed to the terminal identity. Never-started cancellation uses fence zero and has no attempt row, while started cancellation retains ownership provenance. Terminal jobs no longer occupy dispatch indexes. Automated retention never deletes an outcome alone: it removes the stable terminal job only after both identity and outcome minimum windows have elapsed and no retained history still attributes to that identity.

Failed outcomes additionally have one cold partial index ordered by immutable completion time and identity. `list_dead_letters_v2` uses it for bounded cursor pages and joins immutable `job` definition only after selecting terminal candidates. This index is not a dispatch path and claim never reads it.

### `job_query`

A bounded operator projection maintained in the same transaction as runtime and outcome lifecycle changes. It stores routing, state, current attempt, run time, cancellation-request metadata, immutable creation time, and the last meaningful lifecycle update. It deliberately excludes payload, result, error, checkpoints, waits, worker ownership, heartbeat, and lease expiry.

`list_jobs_v2` selects a page from dedicated global, queue, type, or state creation-time indexes before joining immutable `job` rows for optional payload projection. Heartbeats do not update the projection, and no query index is added to `job_runtime`. Pages use immutable `(created_at, job_id)` keys and a filter/projection-bound signature. Cross-page state membership is weakly consistent until snapshot pagination is implemented.

Payload is omitted by default. When requested, PostgreSQL applies bounded top-level redaction before checking the response byte ceiling and returns explicit omission status. These controls bound disclosure and returned size for selected rows, not accepted payload size or requested detoasting work.

### `job_redrive`

Insert-only source-to-target lineage and operator audit. The source/request hash primary key serializes exact replay, while unique target identity gives every new execution one parent. Raw request IDs are never stored. The row retains safe request preview/digest/length, actor, reason, canonical request fingerprint, source and initial target states, and request time.

`redrive_v1` accepts only a retained failed source. It creates a fresh ready job with copied queue, type, priority, payload, accepted contract version, size limits, redaction keys, tags, attempt budget, retry policy, and execution timeout. It clears the old absolute deadline and never copies checkpoint, wait, attempt, result, or cancellation state. Source and target events plus the lineage row commit atomically; the original outcome's semantic terminal columns are never updated, while its retention watermark follows the normal history-attribution rule. Exact replay returns the existing target, while a changed actor or reason under the same source/request identity conflicts. `redrive_many_v1` applies the same transition to an oldest-first bounded candidate page, accepts a keyset cursor for deterministic backlog progression, and performs no writes in dry-run mode.

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

### `job_signal_wait`

One named external-delivery boundary per stable job identity. `wait_for_signal_v1` accepts the
exact active job, worker, and fence generation. A first declaration retains its attempt, fence,
worker, and claim time, then moves runtime to a non-runnable scheduled row without closing the
logical attempt. One job retains at most 1,000 signal names, each limited to 200 characters.

`send_signal_v1` accepts the job identity, signal name, JSON payload, idempotency key, and trusted
actor. Payloads are limited to 65,536 bytes of canonical JSONB text, keys to 512 UTF-8 bytes, and
actors to 200 characters. The function serializes delivery with declaration, stores only a SHA-256
key hash and request fingerprint, and makes the waiting runtime ready in the same transaction.
The first accepted payload is retained. An equal same-key retry returns `duplicate`; a changed
same-key request raises `SignalIdempotencyConflictError`; another key returns
`already_delivered`. Early, stale, and late deliveries return bounded statuses without changing
dispatch state.

`HandlerContext.waitForSignal(name)` suspends and later returns the retained payload after handler
replay. `Queue.sendSignal` is the application-owned delivery surface. The dashboard procedure
`dashboard.signalTask` derives `requestedBy` from its authenticated server principal before it
calls the same queue operation. `signal_waiting`, `signal_received`, `signal_replayed`, and
`signal_rejected` events retain bounded lifecycle evidence. Events include the actor and a short
key digest but never the raw key or payload.

PostgreSQL gives every undelivered signal a seven-day `timeout_at`; an earlier `job.deadline_at`
wins. The waiting runtime temporarily stores that effective bound in `job_runtime.deadline_at`.
Accepted delivery restores the immutable job deadline before making the runtime ready.
`terminalize_deadline_v1` materializes `DeadlineExceeded`, retains the original attempt attribution,
and makes every later delivery return `stale`. Signal rows have no independent retention window.
They cascade only when terminal identity pruning can safely remove the parent `job`, after its
outcome and required history are also eligible.

### `job_human_wait`

One named human decision per stable job identity. `wait_for_human_v1` accepts the exact active job,
worker, fence generation, name, and operator context. Names are limited to 200 characters. Context
and completion results are each limited to 65,536 bytes of canonical JSONB text. One job retains at
most 1,000 human decisions.

`complete_human_wait_v1` accepts the job identity, token name, result, idempotency key, and trusted
actor. Keys are limited to 512 UTF-8 bytes and actors to 200 characters. The function retains only
the SHA-256 key hash, request fingerprint, first result, actor, and completion time. An equal retry
returns `duplicate`; a changed same-key request raises `HumanWaitIdempotencyConflictError`; another
key returns `already_completed`. Early and stale requests return bounded statuses without changing
dispatch state.

`HandlerContext.waitForHuman(name, context)` suspends and returns the retained result after replay.
`Queue.completeHumanWait` is the application completion surface. The dashboard lists at most 100
actionable rows from `dashboard_human_wait_v1`, validates result JSON, and derives `completedBy` from
the authenticated principal. `human_wait_created`, `human_wait_completed`, `human_wait_replayed`,
and `human_wait_rejected` retain value-free lifecycle evidence.

Human decisions use the same seven-day PostgreSQL timeout and parent-identity retention contract.
Immediate cancellation and deadline terminalization read `job_human_wait` to preserve the original
attempt, fence, worker, and claim time before deleting `job_runtime`. A completion after either
transition returns `stale` and appends `human_wait_rejected`; it cannot overwrite the retained
decision row or terminal outcome. `dashboard_human_wait_v1.deadline_at` exposes the effective
PostgreSQL timeout, including an earlier immutable job deadline when one exists.

### `retention_policy`

One singleton row is the target database's authoritative retention policy. Its effective typed
columns contain explicit nullable minimum windows for job identity, terminal outcome, job events,
attempt history, schedule occurrences, and statistics, plus five bounded work limits. Matching
`application_*` columns retain the latest deployment defaults, while `operator_overrides` contains
only the names whose effective values an operator owns. Every category defaults to 14 days; null
disables automatic deletion for that category.

`sync_retention_policy_v1` and `Queue.syncRetentionPolicy` update the application columns and copy
them into effective columns that are not operator-owned. Passing `{ force: true }` copies every
supplied value and clears all overrides. `override_retention_policy_v1` and
`Queue.overrideRetentionPolicy` atomically update selected effective values and add their names.
`revert_retention_policy_v1` and `Queue.revertRetentionPolicy` copy selected application values back
and remove their names. `Queue.previewRetentionPolicy` counts at most 10,001 eligible rows per
category, reports 10,000 plus a capped flag, and performs no writes.

Identity is the attribution anchor. Finite terminal-job retention requires both identity and outcome windows, finite event, attempt, and occurrence windows, and an identity minimum at least as long as every dependent minimum. PostgreSQL rejects configurations that could remove an identity before its retained provenance. Windows are minimums rather than deletion deadlines because bounded cleanup or retained dependent rows can safely extend actual retention.

### `concurrency_policy`

One row per queue stores a deployment-owned dispatch budget. `queue_name` is the primary key and accepts 1 through 256 UTF-8 bytes. `namespace` accepts the same bounds and owns the row. `max_active` limits all active jobs in the queue and accepts integers from 1 through 1,000,000. Nullable `max_active_per_key` adds a queue-scoped key limit and accepts an integer from 1 through `max_active`. A null key limit disables keyed admission while preserving the queue limit. `updated_at` changes only when either effective limit changes.

`sync_concurrency_policies_v1(namespace, definitions, prune)` and `Queue.syncConcurrencyPolicies(namespace, definitions, { prune })` reconcile one namespace atomically. One call accepts at most 10,000 unique queue definitions. Each definition permits only `queue`, `maxActive`, and optional `maxActivePerKey`. The function takes an exclusive global transaction advisory lock to serialize reconcilers. It also takes an exclusive queue advisory lock before changing each row. `claim_v3` takes the matching shared queue lock before reading policy, so first creation and pruning cannot race an ungoverned claim. The reconciler rejects queues owned by another namespace, upserts desired rows, and prunes omitted rows by default. Passing `{ prune: false }` retains omitted rows. An empty desired set removes every policy owned by that namespace when pruning is enabled.

`Queue.concurrencyPolicies(queueNames)` returns persisted rows ordered by `queue_name`. An omitted or empty array returns every policy. A non-empty array filters by exact queue name. This read has no implicit result cap.

Policy capacity counts only active rows whose lease has not expired. The policy is therefore a dispatch budget, not mutual exclusion. A handler can still overlap a replacement after its stale lease expires. Fence validation prevents the stale generation from committing a lifecycle result.

### `rate_limit_policy` and `rate_limit_bucket`

One `rate_limit_policy` row per queue defines a PostgreSQL-owned token bucket. The queue bucket
requires `rate_limit`, `rate_interval_ms`, and `rate_burst`. Each accepts bounded positive integers:
limits and bursts from 1 through 1,000,000, and intervals from 1 through 86,400,000 milliseconds.
`queue_name` and `namespace` each accept 1 through 256 UTF-8 bytes.
Nullable `per_key_limit`, `per_key_interval_ms`, and `per_key_burst` either appear together or remain
null. A keyed policy gives every non-null `job.concurrency_key` an independent bucket within its
queue. Keyless jobs consume only the queue bucket.

`sync_rate_limit_policies_v1(namespace, definitions, prune)` and
`Queue.syncRateLimitPolicies(namespace, definitions, { prune })` reconcile deployment-owned desired
state. Each definition contains only `queue`, `rate`, and optional `perKey`; each bucket contains
`limit`, `intervalMs`, and `burst`. Synchronization accepts at most 10,000 unique queues, rejects
cross-namespace ownership, and prunes omitted rows by default. `Queue.rateLimitPolicies(queueNames)`
returns persisted definitions without an implicit result cap.

`rate_limit_bucket` stores mutable queue and key token balances separately from policy provenance.
`rate_limit_bucket_v1` computes elapsed time from `clock_timestamp()`, clamps negative elapsed time
to zero, adds `elapsed_ms * limit / interval_ms`, and caps the result at `burst`. One admitted start
consumes one token in the claim transaction. Completion, failure, cancellation, durable suspension,
and lease expiry never refund a token. Process clock skew cannot create capacity because application
time never enters refill arithmetic. Admission probes do not create rows for keys that never start;
the function inserts bucket state only when it consumes a token. Each claim inspects the oldest 100
key buckets for its queue and removes those whose tokens have fully refilled. This bounds cleanup
work while preventing inactive high-cardinality keys from accumulating forever. Deleting a policy
cascades its remaining bucket state; recreating the policy therefore begins with a full burst.

`Queue.rateLimitStatuses(queueNames)` observes at most 100 policies and the oldest 100 ready rows per
policy. It reads a 101st sentinel to set `policySetCapped` or `sampleCapped`, but never returns that
sentinel. Each returned row reports refilled queue tokens, throttled-ready depth, distinct sampled
keys waiting for tokens, and the earliest sampled `nextEligibleAt`. An omitted or empty `queueNames`
array observes every policy subject to the cap; a non-empty array filters exact queue names before
the cap. `QueueHealth.rateLimitPolicies` includes the same observations and sets `capped` when either
limit applies. OpenTelemetry exports configured starts per second, available queue tokens, throttled
ready depth, and next-eligibility delay using queue name as the only policy dimension.

### History

`job_event` is the append-only lifecycle audit. `attempt_history` contains one immutable row for every closed logical attempt, including retry, lease expiry, success, terminal failure, and cancellation after an attempt actually started. Its `started_at` preserves the logical attempt start across timer suspensions, while `claimed_at` identifies the final activation that closed it. Timer suspension itself emits events but does not close attempt history. Both history relations use UTC-daily range partitions with default fallbacks. Clean installation creates the current day plus three future days, and `prepare_history_partitions_v1` continuously replenishes and repairs that horizon.

`list_job_timeline_v2` merges retained rows from both history relations into one latest-first cursor stream ordered by event/attempt time, kind rank, and immutable record identity. Every entry exposes the job's immutable priority. Event details and attempt errors are operator evidence rather than job payload and are not changed by payload redaction. Since retention is independent, an existing identity can legitimately return partial or empty history.

Event and attempt retention are independent phases inside `retain_history_v1`. Each drops only fully expired completed daily partitions, retires at most the configured number per pass, skips busy day locks, caps DDL lock waits at 250 ms, and bounded-deletes expired rows from its own default partition. Explicit day creation and paired retirement functions remain available for controlled operator work. Default partitions preserve insert availability when partition maintenance is late, while health reports exact counts through 10,000 rows and explicit capped lower bounds beyond that so fallback spill cannot remain invisible or make health unbounded.

`create_history_day_v1` and `retire_history_day_v1` acquire `ACCESS EXCLUSIVE` on the
`attempt_history` parent before the `job_event` parent. Lifecycle transitions insert attempt history
before job events, so this shared parent-lock order prevents paired partition DDL from deadlocking a
transition between its two history inserts. Creation then locks `attempt_history_default` before
`job_event_default`, stages matching fallback rows, attaches each missing partition, and restores the
staged rows.

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

One row per live worker process, keyed by the durable `worker_id` used for leases and attempt history.
`register_worker_v1` is a single round trip that publishes `queue_name`, `concurrency`, `lease_ms`,
`heartbeat_ms`, `poll_ms`, `maintenance_interval_ms`, `maintenance_task_poll_ms`,
`registry_interval_ms`, `active_slots`, and `draining`, then returns the PostgreSQL-owned `paused`
flag. Workers call it on `WorkerOptions.registryIntervalMs`, five seconds by default. The dashboard
shows the reported process values read-only because changing them requires a deployment.

The relation exists because process-local memory cannot answer "which workers exist" once workers are deployed independently of the web tier. It is what allows an operator surface to report and control a fleet it does not host. It is never read by the claim path and holds one row per worker, so it cannot affect dispatch cost.

Ownership is deliberately split. A worker may not write `paused`, and an operator may not write the runtime columns. `set_worker_paused_v1` records the flag plus bounded `paused_by` and `paused_reason` attribution and returns no rows for an unregistered worker. The flag is scoped to a process incarnation. Each worker announces a fresh `instance_id`, and `register_worker_v1` keeps the pause only while that instance keeps refreshing; a new instance of the same worker id clears the flag and its attribution. Without that column PostgreSQL could not tell a routine heartbeat from a restart, and the flag would be either indefinitely sticky or cleared by the worker's own next heartbeat. Durable "stop this work" belongs to queue pause.

Pause is cooperative in exactly the sense cancellation is: the worker stops claiming at its next refresh, a handler already executing runs to completion, and a local `Worker.resume()` cannot clear a still-effective operator pause. Attribution is not authorization; callers enforce their own permission checks.

Graceful shutdown calls `deregister_worker_v1`. A killed worker simply stops refreshing, is reported offline once its registration goes stale, and is removed by the bounded `prune_worker_registry_v1`. Reported slot use is therefore eventually consistent with the worker's real event loop, and should be read as an operational indicator rather than a synchronous cross-process read.

### `maintenance_policy` and `maintenance_state`

The singleton maintenance policy stores one validated IANA `timezone`, a
`partition_preparation_interval_ms` from 60,000 through 604,800,000, a
`terminal_cleanup_interval_ms` from 1,000 through 86,400,000, and a
`history_retention_local_time` with second precision. Clean installation uses UTC, six hours, five
minutes, and 03:00. Matching `application_*` columns and `operator_overrides` use the same ownership
model as retention policy.

`sync_maintenance_policy_v1` seeds unoverridden effective values and accepts `p_force` to clear all
overrides. `override_maintenance_policy_v1` changes selected effective values.
`revert_maintenance_policy_v1` restores selected application defaults. A timezone or local-time
change clears `maintenance_state.last_completed_local_date`, so the new boundary may run on the
current local date. Maintenance state also stores independent last-run timestamps and the
history-retention watermark. Workers poll all three tasks every minute by default, while PostgreSQL
performs the global due check and advisory-lock coordination.

### Declarative schedules

`sync_schedule_definitions_v1` stores the accepted `contract_version`, both size limits, and both redaction-key arrays beside each schedule payload. Any change increments the schedule revision. `fire_schedule_v1` copies that metadata into the occurrence job, so a later deployment cannot reinterpret an already-synchronized definition with a different current contract.

`schedule_definition` is the target database's desired-state record for one deployment namespace. It stores validated cron text, a typed Workhorse job definition, and a monotonically increasing revision, never arbitrary SQL. Removed definitions are disabled rather than deleted so occurrence history remains attributable.

`schedule_occurrence` provides one durable key per `(namespace, schedule_name, occurrence_at)` second. `fire_schedule_v1` inserts that key and enqueues through `enqueue_v1` in one transaction. A repeated fire for the same second returns null, so only the call that creates the job reports a fire.

Scheduling metadata lives entirely in the target database. Workers evaluate cron expressions in process with `cron-parser` and call revision-fenced `fire_schedule_v1`, `tick_v1`, and the three bounded maintenance tasks. Transaction-scoped advisory locks and persisted due state make concurrent callers no-ops, so schedules fire once and each maintenance task runs once per database cadence regardless of worker count, while any surviving worker keeps schedules alive.

## Atomic lifecycle

```mermaid
stateDiagram-v2
  [*] --> blocked: enqueue with live prerequisite
  [*] --> ready: enqueue due
  [*] --> scheduled: enqueue future
  blocked --> ready: prerequisite succeeds after run_at
  blocked --> scheduled: prerequisite succeeds before run_at
  blocked --> canceled: cancel immediately
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

`enqueue_many_v1` parses and validates at most 1,000 requests against one timestamp, including optional priority, persisted retry policies, and up to 100 dependency identities. Priority defaults to 0 and must be an integer from 0 through 100. It returns `(ordinal, job_id, accepted)` for each input; `accepted` is true only when the statement created the durable job. One statement inserts `job`, optional `job_dependency` edges, `job_runtime` or a policy-selected terminal outcome, and acceptance events. Input ordinality controls returned IDs and ready sequence allocation. Any invalid member rolls back the entire batch. Commit-delivered `NOTIFY workhorse_jobs` is coalesced to one notification per distinct queue that gained ready work.

`enqueue_many_v2` preserves that contract and returns `(ordinal, job_id, outcome)`. Ordinary requests map `accepted` to `accepted` or `replayed` and stay on the set-based `enqueue_many_v1` path. A batch containing `debounce` or `throttle` requests locks every scoped idempotency, debounce, or throttle key in bytewise order before processing requests in caller order. This keeps mixed batches atomic and prevents overlapping batches from reversing key-lock order.

`Queue.enqueueWithResult` and `Queue.enqueueManyWithResults` expose `EnqueueResult`, whose `outcome` is `accepted`, `replayed`, `replaced`, `non_replaceable`, or `coalesced`. `Queue.enqueue` and `Queue.enqueueMany` preserve their string-ID return values by projecting the same structured results.

Idempotency replays one materially equivalent request and rejects a conflicting reuse. Debounce replaces one pending definition while arrivals continue. Throttle reuses one accepted identity without changing it. These contracts serialize acceptance in PostgreSQL, but they do not make handler effects exactly once. A handler can repeat after a lost lease or process failure, so external effects still require their own idempotency boundary.

#### Keyed debounce

`EnqueueOptions.debounce` contains `key`, optional `scope`, `windowMs`, and `schedule`. Keys and scopes share the idempotency limits of 512 and 256 UTF-8 bytes. `windowMs` is an integer from 1 through 31,536,000,000. `schedule` is `reset` or `preserve`. A request with `debounce` cannot also supply `idempotency` or `runAt`. PostgreSQL derives the initial run time from `clock_timestamp() + windowMs`.

`enqueue_debounce_v1` hashes the scoped key, takes the same transaction advisory lock as enqueue idempotency, and stores `coalescing_mode = 'debounce'` on `enqueue_idempotency`. It never persists the raw key. A new key creates one scheduled job through `enqueue_many_v1` and returns `accepted`.

If the retained runtime is `scheduled` or `ready`, PostgreSQL validates the replacement through `enqueue_many_v1`. The key window must still be active. PostgreSQL then updates the accepted job definition and runtime atomically. `reset` derives a new run time and key expiry from the statement clock. `preserve` retains both. The stable job ID and current attempt remain unchanged. A `debounced` event records the safe key preview and digest, schedule policy, window, expiry, prior request digest, and replacement request digest.

An active runtime, terminal outcome, incompatible idempotency key, or elapsed-but-still-pending runtime returns `non_replaceable` without changing the accepted definition. PostgreSQL appends `debounce_rejected` with a bounded reason. If the key window elapsed after the old job became active or terminal, a new pending identity can be accepted. Queue purge removes the key before the job identity, so a purged key can also accept fresh work. These rules preserve one runtime or outcome for every accepted identity and prevent promotion lag from creating two pending jobs for one elapsed key.

#### Keyed throttle

`EnqueueOptions.throttle` contains `key`, optional `scope`, and `windowMs`. Keys and scopes share the idempotency limits of 512 and 256 UTF-8 bytes. `windowMs` is an integer from 1 through 31,536,000,000. A request cannot combine `throttle` with `idempotency` or `debounce`. It may supply `runAt`; explicit scheduling remains material to request equivalence.

`enqueue_throttle_v1` hashes the scoped key, takes the shared transaction advisory lock, and converts the throttle window into the `enqueue_many_v1` idempotency retention contract. PostgreSQL stores `coalescing_mode = 'throttle'` and derives expiry from `clock_timestamp() + windowMs`. The first request returns `accepted`. An equivalent request before expiry returns the retained job ID with `coalesced` and creates no job, runtime, event, ready sequence, or notification effect.

Payload, queue, type, priority, scheduling, retry, contract, tag, deadline, timeout, or window changes before expiry raise `EnqueueIdempotencyConflictError`. Coalescing remains valid while the retained job is ready, scheduled, active, or terminal because throttle controls acceptance rather than execution. After expiry, a new request accepts a new stable identity even if the prior identity remains retained. Queue purge removes a pending job's binding and also permits a new acceptance. A retained key cannot change among idempotency, debounce, and throttle modes before expiry.

### Promotion

`promote_v1` locks a bounded due set with `FOR UPDATE SKIP LOCKED`, updates those runtime rows from scheduled to ready, preserves priority, assigns new FIFO sequences, appends events, and emits a wake hint. Every promoted row emits `promoted`; its locked `due` CTE also carries any durable `wait_name` through the update so timer-backed rows append `wait_elapsed` before the marker is cleared.

Production maintenance is worker-owned and split by cadence and failure domain.

Each worker calls `tick_v1` at most once per configured `maintenanceIntervalMs` (default one second). Under the transaction-scoped `workhorse:tick` advisory lock it performs bounded promotion and bounded expired-lease recovery, the two dispatch-latency-critical phases. Concurrent callers return immediately with `skipped_lock = true`. The same cadence drives in-process schedule evaluation.

Each worker polls `prepare_history_partitions_v1`, `retain_history_v1`, and `prune_terminal_storage_v1` at most once per configured `maintenanceTaskPollMs` (default 60 seconds). PostgreSQL checks persisted due state under a task-specific advisory lock. Partition preparation defaults to every six hours, terminal storage cleanup to every five minutes, and history retention to once per local date at or after `maintenance_policy.history_retention_local_time` in `maintenance_policy.timezone`. None shares the promotion advisory lock. Partition retirement abandons a DDL lock attempt after 250 ms rather than waiting indefinitely behind dispatch. Every phase runs in its own exception subtransaction, so one cleanup failure is reported without rolling back successful sibling phases.

Terminal-job pruning selects a bounded candidate window of identities with outcomes, both minimum windows elapsed, no live runtime, no retained schedule occurrence, and history boundaries behind the global retained-through watermark. The bounded delete cascades outcome, checkpoints, and waits. History insert triggers serialize with parent deletion and move the watermark backward for late old history, while queue purge explicitly removes history before identity.

All maintenance functions return one row per phase, `(phase, rows_affected, duration_ms, skipped_lock, error)`. `WorkerMaintenanceLoop` is the shared `tick | statistics_rollup | background_tasks` taxonomy for phase telemetry and drift metrics. The worker exposes the latest phase rows through `worker.maintenanceTelemetry()` and forwards each row to the optional `onMaintenance` callback. Between passes a worker issues only the claim query.

## OpenTelemetry metrics

`@workhorse/core` depends only on `@opentelemetry/api` and never installs an SDK, reader, exporter,
or resource. `src/telemetry.ts` owns every instrument. `lazyCounter`, `lazyHistogram`, and
`lazyGauge` create the underlying instrument on first emission and re-create it whenever
`metrics.getMeterProvider()` returns a provider other than the one last seen, so an application may
install its OpenTelemetry SDK before or after importing Workhorse. Emissions made while no provider
is registered are discarded, as the API's no-op provider discards them. ADR 0024 records the
measurement that selected this lifecycle over module-scope instrument creation.

Queue and worker operations emit these synchronous instruments:

| Instrument                           | Kind and unit           | Recording point and attributes                                                                                                                                                                                                |
| ------------------------------------ | ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `workhorse.jobs.enqueued`            | counter, `{job}`        | One accepted `enqueue_many_v1` member, grouped by `workhorse.queue.name` and `workhorse.job.type`. An outer caller transaction may still roll back after this statement returns.                                              |
| `workhorse.jobs.claimed`             | counter, `{job}`        | One successful `claim_v3`, by queue and job type. Empty claim polls emit nothing.                                                                                                                                             |
| `workhorse.jobs.completed`           | counter, `{job}`        | One accepted `complete_v1`, by queue and job type. A rejected stale completion emits nothing.                                                                                                                                 |
| `workhorse.jobs.failed`              | counter, `{job}`        | One `fail_v1` result, by queue, job type, and `workhorse.attempt.outcome`.                                                                                                                                                    |
| `workhorse.jobs.retried`             | counter, `{job}`        | Each attempt returned to live work by failure, owned expiry, or bounded recovery, by queue and job type. Recovery rows without dimensions use `unknown` for both.                                                             |
| `workhorse.jobs.cancellation`        | counter, `{request}`    | One `cancel_v1` result, by `workhorse.cancellation.status`.                                                                                                                                                                   |
| `workhorse.jobs.redrive`             | counter, `{request}`    | Every result from single or bulk redrive operations, by `workhorse.redrive.status`.                                                                                                                                           |
| `workhorse.handler.executions`       | counter, `{execution}`  | One worker handler activation, by queue, job type, and `workhorse.handler.outcome`. Outcomes are `succeeded`, `retry`, `failed`, `canceled`, `deadline_exceeded`, `timeout`, `lease_lost`, and `suspended`.                   |
| `workhorse.handler.duration`         | histogram, `ms`         | Wall-clock duration of the same activation, with the same attributes. An activation that ends without a recorded outcome reports `unknown`. Durable wait suspension closes an activation without closing its logical attempt. |
| `workhorse.handler.runtime`          | counter, `ms`           | Cumulative handler execution time by queue and job type.                                                                                                                                                                      |
| `workhorse.handler.batch.size`       | histogram, `{job}`      | Jobs delivered in one `BatchHandler` invocation, by queue, job type, and bounded full/partial flag.                                                                                                                           |
| `workhorse.handler.batch.linger`     | histogram, `ms`         | Time from the first member reaching its coordinator until batch dispatch, with the same attributes.                                                                                                                           |
| `workhorse.claim.duration`           | histogram, `ms`         | `claim_v3` latency, by queue and the bounded `workhorse.claim.result` values `claimed` and `empty`.                                                                                                                           |
| `workhorse.leases.expired`           | counter, `{lease}`      | Leases recovered by `recover_expired_v1`; zero-result passes emit nothing.                                                                                                                                                    |
| `workhorse.schedule.fired`           | counter, `{occurrence}` | One `fire_schedule_v1` call that returns a job ID, by schedule namespace and name.                                                                                                                                            |
| `workhorse.schedule.lag`             | histogram, `s`          | Delay from the planned occurrence to the successful fire, with the schedule attributes.                                                                                                                                       |
| `workhorse.worker.heartbeat.failure` | counter, `{heartbeat}`  | Every `heartbeat_v2` status other than `accepted`, by `workhorse.heartbeat.status`.                                                                                                                                           |
| `workhorse.maintenance.runs`         | counter, `{run}`        | Each maintenance result, by loop, phase, and skipped-lock flag.                                                                                                                                                               |
| `workhorse.maintenance.rows`         | counter, `{row}`        | Rows affected by the same result and attributes.                                                                                                                                                                              |
| `workhorse.maintenance.duration`     | histogram, `ms`         | SQL-reported duration for the same result and attributes.                                                                                                                                                                     |
| `workhorse.maintenance.errors`       | counter, `{error}`      | Maintenance results whose `error` is non-null, with the same attributes.                                                                                                                                                      |
| `workhorse.maintenance.drift`        | histogram, `ms`         | Delay beyond a worker maintenance loop's configured cadence, by loop.                                                                                                                                                         |

Each lifecycle event reaches exactly one instrument. A handler activation is counted by
`workhorse.handler.executions` and timed by `workhorse.handler.duration`, both dimensioned by
outcome; the write it produces is counted by `workhorse.jobs.completed`, `workhorse.jobs.failed`, or
`workhorse.jobs.retried` at the queue operation that performed it.

`WorkhorseMetricsObserver` lives in `src/metrics-observer.ts` and records its gauges through the same
lazy lifecycle. It performs two concurrent read-only queries every `intervalMs`, which
defaults to 10,000 and must be a safe integer of at least 1,000. `start()` collects immediately and
then repeats on an unreferenced timer; `stop()` clears the timer; `collect()` provides a serialized
one-shot collection. `onError` receives interval failures. Applications must run at most one observer
per database because every observer sees the same global PostgreSQL state.

Its queue query reads the shared depth aggregates in `src/queue-depth.ts` and joins `queue_control`
for the pause flag. The observer records `workhorse.jobs.count` for scheduled, ready, and active rows by queue and state;
`workhorse.queue.oldest_ready.age`; `workhorse.queue.paused`; `workhorse.lease.expired`;
`workhorse.deadline.overdue`; and `workhorse.execution_timeout.overdue`. A second query groups
`worker_registry` rows into mutually exclusive `running`, `paused`, `draining`, and `offline` states;
`offline` means the last heartbeat is at least 30 seconds old. The observer then records
`workhorse.worker.count`, `workhorse.worker.capacity`, and `workhorse.worker.active` by queue and worker
state. The observer never uses job IDs, worker IDs, payloads, error text, cancellation attribution, or
redrive attribution as metric attributes.

### Durable timer suspension

`schedule_wait_v1` accepts either a relative bigint duration or an absolute timestamp, locks the exact active worker/fence generation, and rechecks lease expiry after acquiring the runtime lock. A first future target inserts `job_wait`, changes runtime to wait-marked scheduled state, clears ownership, and emits `wait_scheduled`. A first past-due target is still recorded but leaves runtime active and returns elapsed. Relative replay returns the first stored target even if later configuration supplies another duration; absolute target or mode changes conflict. Reaching an elapsed name emits `wait_replayed`.

Suspension aborts the handler's cooperative signal and exits through private worker control flow, so the heartbeat stops and the worker slot is free for another claim. If the handler catches that signal and returns, the worker reasserts the recorded suspension. It also emits `workhorse.handler.signal_swallowed` at warning severity with `workhorse.handler.outcome = suspended`. Suspension does not call failure or completion and does not increment attempts. Normal promotion later makes the same logical attempt claimable with a new fence. Wake latency is bounded by maintenance cadence and worker availability, not by an exact wall-clock guarantee. Queue health reports the number of sleeping and overdue waits plus the next durable wake target.

### Durable signal suspension

`wait_for_signal_v1` takes an advisory lock scoped to job identity and signal name, then locks and
revalidates the active runtime generation. It inserts `job_signal_wait`, clears ownership, and
parks runtime outside the ready and active indexes. The worker uses the same private suspension
control path as a timer wait, so no failure, completion, or attempt-history row is written.

`send_signal_v1` takes the same advisory lock. If a pending row still owns the waiting boundary,
it retains the request and changes runtime to ready with a fresh FIFO sequence before notifying
workers. Competing deliveries serialize at this transition. Cancellation, deadline materialization,
or another lifecycle transition makes an undelivered row stale. A delivered row remains replayable
through later handler retries and follows parent-job retention.

`QueueHealth.externalWaits` reports `pendingSignals`, `pendingHumanDecisions`, `overdue`,
`oldestPendingAgeMs`, `rejectedDeliveries`, and `capped`. Separate scans inspect at most 10,001
pending signals, pending human decisions, overdue signals, overdue human decisions, and retained
rejection events. Counts cap at 10,000. An overdue row adds the critical
`overdue-external-waits` reason until the deadline reaper materializes it. `WorkhorseMetricsObserver`
exports `workhorse.wait.pending`, `workhorse.wait.overdue`, and
`workhorse.wait.delivery.rejected` by queue and the bounded `signal` or `human` kind only.

### Human decision suspension

`wait_for_human_v1` serializes on the stable job and token name, validates the active fence, stores
bounded decision context, and parks the runtime without closing the logical attempt. A replay must
provide equal JSON context. `complete_human_wait_v1` serializes competing operator results, retains
the first accepted completion, moves the runtime to ready, and notifies workers in the same
transaction. The handler restarts from entry and receives that retained result at the named wait.

### Claim

`claim_v3` takes shared advisory locks for concurrency and rate-policy deployment, then locks any
matching policy rows before admission. It computes acquisition and lease timestamps after those
potentially blocking locks. Without a concurrency policy, it selects the strict-priority head through
`job_runtime_ready_idx`. With one, it counts only unexpired active rows through
`job_runtime_active_queue_key_expiry_idx` and stops when queue capacity is full. With a rate policy,
it refills the queue bucket from PostgreSQL time and returns null when no queue token exists.

Priority dispatch has no aging or fair-share control. A sustained stream of higher-priority ready work can starve lower-priority rows in the same queue.

If concurrency-key or rate-key limits apply, `claim_v3` inspects at most the first 100 ready rows by
priority descending, FIFO sequence, and job identity. It selects the earliest candidate whose queue-scoped key has concurrency capacity and
a rate token. Saturated or throttled candidates remain ready, so later admissible work can proceed
without an unbounded prefix scan. The transaction consumes queue and key tokens only after its
runtime update selects a candidate. Competing worker processes serialize on the rate-policy row, so
one durable token admits one start even when claims overlap. Returning null after exhausting the
window enters the Worker's normal bounded empty-claim wait instead of a claim loop.

One runtime update changes the selected row to active and installs worker, global fence, acquisition, heartbeat, and expiry data. The same transaction appends the claim event before returning identity, payload, normalized `retryPolicy`, contract version, result limit, and error-redaction flag. No transaction remains open while user code runs. `Queue.claim` and production benchmarks use `claim_v3`. The clean-install schema does not install the retired `claim_v1` function.

### Worker concurrency and lifecycle

`WorkerOptions.concurrency` accepts an integer from 1 through 100 and defaults to 1. The configured value
is exposed as readonly `worker.concurrency`. `worker.runtimeState()` returns the process-local snapshot
`{ concurrency, activeSlots, paused, draining }`; it is an operational view of this object, not durable
liveness or membership state.

One claim pass fills only currently free slots. Claims remain serial because each `claim_v3` transition is
an independent correctness-sensitive database operation. Each successful claim starts one independent
per-job handler task; the fill loop stops when all free slots are occupied or the first claim returns null.
This bounds claim and connection pressure without serializing user handlers. A handler slot remains active
through completion, retry/failure handling, or durable-wait suspension, and every active job owns its own
heartbeat timer, abort controller, fence checks, and final transition.

`Worker.handleBatch(type, { maxSize, lingerMs }, handler)` registers one `BatchHandler` for a job
type. `maxSize` is a safe integer from 1 through 100 and cannot exceed `WorkerOptions.concurrency`.
`lingerMs` is a safe integer from 0 through 60,000. Jobs in ordinary active slots rendezvous in the
type's process-local coordinator. A full group dispatches immediately. A partial group dispatches
after its first member has waited `lingerMs`; this timer does not depend on `LISTEN` notifications.

Every `BatchHandlerItem` retains its payload and `HandlerContext`. The coordinator sorts members by
priority descending and coordinator arrival order. One invocation contains only the worker's configured
queue and registered job type. The handler returns one `BatchHandlerOutcome` per member in the same order.
`{ status: "succeeded", result }` submits that member's result. `{ status: "failed", error }` submits that
member's failure through its persisted retry policy and remaining attempt budget. A thrown error, non-array
return, wrong outcome count, or invalid outcome rejects every member. Each per-job execution path still
submits that failure under its own fence.

PostgreSQL admits each member through an independent `claim_v3` call before the process-local rendezvous.
The batch is not an atomic admission unit. Every admitted member consumes one worker slot, one queue or
keyed active count, one queue rate token, and one keyed rate token when the matching policy applies. A
policy can therefore produce a partial batch. Linger time continues to consume each admitted member's
lease and policy capacity. Priority controls PostgreSQL admission first; the coordinator's sort only orders
members that were already admitted. The fenced SQL transitions release each member's policy capacity after
completion, failure, cancellation, expiry, or recovery. A stale fence rejects only its member. `Worker.stop()`
drains admitted members and their heartbeats but prevents another claim pass.

`workhorse.handler.batch_dispatched` logs the bounded size, measured linger, full/partial flag, queue, type,
and worker identity without payloads or job IDs.

`pause()` prevents later claims while maintenance and active jobs continue. `resume()` clears the pause and
makes claims immediately eligible. `stop()` enters draining state, prevents later claims, and allows every
already active handler and its final fenced transition to finish before `run()` resolves. These process-local
controls do not impose queue weights. `concurrency_policy` enforces a durable active-work budget and
`rate_limit_policy` enforces a durable start-rate budget across worker processes.

An update that moves a governed runtime away from active, or deletes it, runs
`notify_concurrency_capacity_v1`. The trigger publishes the queue on `workhorse_jobs`. Completion, failure,
retry release, cancellation, durable wait, and recovery can therefore wake a worker in another process
without waiting for its fallback poll.

### Heartbeat

`heartbeat_v2` reads the runtime queue, takes its shared policy advisory lock, locks any policy row, and then locks the exact active worker/fence generation. This lock order serializes lease renewal with admission, so an expired lease cannot regain capacity after another claim consumed it. The function returns `accepted`, `cancel_requested`, `deadline_exceeded`, `timeout_exceeded`, or `stale`. It extends the lease only for `accepted`. The clean-install schema does not install the retired boolean `heartbeat_v1` function.

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

`recover_expired_v1` also sets transaction-local counts for expired leases and jobs returned to live
work. `recover_expired_telemetry_v1` returns those counts with total affected rows. `tick_v1` carries
them on its `recover` phase, so the production worker path and direct `Queue.recoverExpired` calls
emit the same recovery span and counters.

`expire_owned_telemetry_v1` wraps prompt timeout settlement by a live worker. It returns the exact
next state, so `Queue.expireOwned` emits a retry span and increments the retry counter only when
PostgreSQL starts another attempt.

### Terminal transitions

`complete_v1`, exhausted failure, and cancellation consume the matching runtime row. Runtime deletion, outcome insertion, any truthful attempt closure, and event append commit or roll back together. Completion and failure reject a runtime that already carries a cancellation request.

### Enqueue and replay

`enqueue_many_v1` first validates and canonicalizes every request against one classification timestamp. Keyed requests acquire deterministic sorted scoped-ownership locks before ordinal processing, preventing overlapping batches from deadlocking. Exact equivalents return the retained job ID and skip all acceptance side effects; a mismatch aborts the whole batch. New keyed and unkeyed requests then insert identity, runtime, one `enqueued` event, FIFO placement when ready, and at most one commit-delivered notification per ready queue in caller order. This preserves same-batch duplicates, caller transaction rollback, and ordinary unkeyed behavior.

## Read models and health

`Queue.getJob(id)` joins immutable `job` to both lifecycle relations and coalesces the one that exists, preserving `retryPolicy` plus cancellation-request metadata for active work.

`Queue.health()` reads every correctness-sensitive value in one statement. One MVCC snapshot
covers the verified schema version, state counts, and dispatch depths. It also covers dependency,
child, deadline, timeout, promotion, concurrency, rate-limit, rollup, and retention pressure.
`historyPartitionDays` reports whether each required daily history partition exists. `capturedAt`
is PostgreSQL's transaction timestamp for the statement.

Singleton CTEs carry `LIMIT 1` planner hints. Without them, PostgreSQL's row estimates trigger JIT
compilation and add roughly one second to each snapshot.

Snapshot cost tracks live work, not lifetime history. Live-state counts and depths come from `job_runtime` and are exact. Terminal state counts stop scanning `job_outcome` at `HEALTH_HISTORY_SCAN_LIMIT` (100,000) rows, and the `job_stat_bucket` count stops at the same cap; `terminalCountsCapped` and `statistics.bucketsCapped` mark capped values as lower bounds that are exact until the cap. The rate-limit block reuses the identical SQL as `Queue.rateLimitStatuses()`, so the two surfaces cannot disagree about throttle semantics.

PostgreSQL planner and collector readings are observations rather than transactional facts and are returned under `QueueHealth.observations`: per-relation size and tuple statistics from `pg_stat_user_tables` summed across `pg_partition_tree`, `oldestTransactionAgeMs` and `lockWaitCount` from `pg_stat_activity`, and `pg_notification_queue_usage()`. They are read concurrently with the snapshot statement and may lag until the statistics collector flushes.

`evaluateQueueHealth(snapshot, budgets)` produces `status.level` (`healthy`, `degraded`, `critical`) and `status.reasons`, each `{ code, severity, observed, budget }` plus `queue` on admission codes and `category` on retention lag. Critical codes mean work is stopping or being lost: `expired-leases`, `overdue-deadlines`, `overdue-execution-timeouts`, `stalled-promotion` when the oldest due scheduled runtime exceeds `promotionLagMs`, and `missing-history-partitions` counting each absent partition side. Degraded codes cost storage or throughput: `rollup-stalled`, `retention-lag`, `eligible-history-partitions`, `default-history-rows`, `concurrency-blocked`, and `rate-limit-throttled`. `DEFAULT_QUEUE_HEALTH_BUDGETS` sets `promotionLagMs` to 10 seconds, `rollupStalledLagMs` to 30 minutes, `rowRetentionLagMs` to 6 hours, `partitionRetentionLagMs` to 2 days, and `eligibleHistoryPartitions` to 2; `Queue.health({ budgets })` overrides any subset per call. The `workhorse-health` CLI exits 2 when the level is not `healthy`. The dashboard system page derives its verdict from these same reasons through `healthCheckMessages` and adds no thresholds of its own.

Retention health includes the persisted policy, oldest retained timestamps, per-category cleanup lag, counts of fully eligible event and attempt partitions, and bounded row counts for both default partitions. Fallback counts are exact through 10,000 rows; `defaultHistoryRowsCapped` marks 10,001 as a lower bound. Live jobs are excluded from terminal identity lag. History lag is based only on fully droppable partitions or expired default rows, not the intentionally retained partial boundary day.

## Dashboard package boundary

Core owns the dashboard's relational read contract. The version 1 views expose these exact columns:

- `dashboard_attempt_history_v1`: `attempt_id`, `job_id`, `attempt`, `fence_token`, `worker_id`, `outcome`, `started_at`, `claimed_at`, `finished_at`, `error`, `occurred_at`.
- `dashboard_concurrency_policy_v1`: `queue_name`.
- `dashboard_job_checkpoint_v1`: `job_id`, `checkpoint_name`, `checkpoint_value`, `attempt`, `fence_token`, `worker_id`, `created_at`.
- `dashboard_job_child_v1`: `parent_job_id`, `child_job_id`, `child_name`, `created_at`, `joined_at`.
- `dashboard_job_redrive_v1`: `source_job_id`, `target_job_id`, `request_id_preview`, `request_id_digest`, `request_id_length`, `requested_by`, `reason`, `source_state`, `target_initial_state`, `requested_at`.
- `dashboard_job_event_v1`: `event_id`, `job_id`, `attempt`, `event_type`, `details`, `occurred_at`.
- `dashboard_job_outcome_v1`: `job_id`, `state`, `current_attempt`, `run_at`, `result`, `error`, `finished_at`, `updated_at`.
- `dashboard_job_progress_v1`: `job_id`, `progress_value`, `revision`, `attempt`, `fence_token`, `worker_id`, `created_at`, `updated_at`.
- `dashboard_job_runtime_v1`: `job_id`, `queue_name`, `state`, `current_attempt`, `fence_token`, `run_at`, `ready_at`, `worker_id`, `acquired_at`, `heartbeat_at`, `expires_at`, `attempt_timeout_at`, `wait_name`, `attempt_started_at`, `cancel_requested_at`, `cancel_requested_by`, `cancel_reason`, `error`, `updated_at`.
- `dashboard_job_v1`: `id`, `queue_name`, `job_type`, `concurrency_key`, `payload`, `payload_redact_keys`, `result_redact_keys`, `tags`, `max_attempts`, `retry_policy`, `deadline_at`, `execution_timeout_ms`, `created_at`.
- `dashboard_job_wait_v1`: `job_id`, `wait_name`, `mode`, `duration_ms`, `requested_wake_at`, `wake_at`, `attempt`, `fence_token`, `worker_id`, `created_at`.
- `dashboard_maintenance_policy_v1`: `singleton`, `timezone`, `partition_preparation_interval_ms`, `terminal_cleanup_interval_ms`, `history_retention_local_time`, `updated_at`.
- `dashboard_maintenance_state_v1`: `task_name`, `last_started_at`, `last_completed_at`, `last_completed_local_date`.
- `dashboard_queue_control_v1`: `queue_name`, `paused`.
- `dashboard_rate_limit_policy_v1`: `queue_name`.
- `dashboard_retention_policy_v1`: `singleton`, `job_event_retention_days`, `attempt_history_retention_days`.
- `dashboard_schedule_definition_v1`: `namespace`, `schedule_name`, `cron_expression`, `queue_name`, `job_type`, `enabled`, `revision`, `updated_at`.
- `dashboard_schedule_occurrence_v1`: `namespace`, `schedule_name`, `occurrence_at`, `fired_at`.
- `dashboard_worker_registry_v1`: `worker_id`, `hostname`, `pid`, `queue_name`, `concurrency`, `lease_ms`, `heartbeat_ms`, `poll_ms`, `maintenance_interval_ms`, `maintenance_task_poll_ms`, `registry_interval_ms`, `active_slots`, `draining`, `paused`, `started_at`, `last_heartbeat_at`.

`dashboard_job_estimate_v1()` returns the planner tuple estimate for the private `job` table. The
dashboard uses it to choose exact counts or estimates without naming the private relation.
`redrive_lineage_v1(p_job_id uuid, p_limit integer)` accepts `p_limit` from 1 through 1,001. It
traverses and returns at most that many edges. Deterministic breadth-first order makes every
smaller response a prefix of a larger response. It returns:

- identity columns `source_job_id` and `target_job_id`;
- audit columns `requested_by`, `reason`, and `requested_at`;
- request evidence columns `request_id_preview`, `request_id_digest`, and `request_id_length`;
- state columns `source_state` and `target_initial_state`.

`stat_buckets_v1`,
`redact_top_level_keys_v1`, and the maintenance functions remain the other
versioned core surfaces used by the dashboard server. A core migration may change private tables
without a dashboard release when it preserves these view and function contracts.

`@workhorse/dashboard-contract` exports `DashboardCommandOptions`, `RunningDashboard`, and
`DashboardStandaloneModule<Database>`. The package contains declarations only and imports neither
`@workhorse/core` nor `@workhorse/dashboard`. Both packages depend on this contract, so neither
copies the standalone API from the other.

`@workhorse/dashboard/standalone` exports `startDashboardServer(database, options)`. The caller
owns `database` and closes it after `RunningDashboard.close()` stops the HTTP listener. The
dashboard entry owns `Queue`, `createDashboardOperatorControllers`, `createDashboardHost`,
`dashboardNodeMiddleware`, and the Node HTTP server. It binds `options.hostname` and `options.port`,
uses `/` as the dashboard path, and enables queue, task, and worker mutations only when
`options.allowMutations` is true.

`DashboardCommandOptions.authentication` selects the standalone single-admin mode. It contains a
username, a `scrypt-v1$<base64url-salt>$<base64url-digest>` password hash, and an optional session
lifetime. Version 1 uses scrypt with `N=16384`, `r=8`, and `p=1`. The salt contains at least 16
bytes, and the digest contains exactly 32 bytes. Sessions default to 28,800 seconds and accept
integer lifetimes from 60 through 86,400 seconds.

`previousPasswordHash` and `previousPasswordHashExpiresAt` form one optional rotation pair. The
expiry is an absolute ISO 8601 timestamp. Before that timestamp, either hash can authenticate. A
session created with the previous hash expires at the earlier of the configured session lifetime
and the rotation timestamp. At and after the timestamp, the previous hash and every session it
created fail authentication. The CLI maps the pair from
`WORKHORSE_DASHBOARD_PREVIOUS_PASSWORD_HASH` and
`WORKHORSE_DASHBOARD_PREVIOUS_PASSWORD_HASH_EXPIRES_AT`, including their `_FILE` variants.

The server stores only a random 32-byte session token and its expiry. The browser receives the
token in `__Host-workhorse-dashboard-session` with `Path=/`, `Max-Age`, `Secure`, `HttpOnly`, and
`SameSite=Strict`. `POST /logout` deletes the server record and expires the cookie. An expired
server record never authorizes a request, even if a client retains its cookie. Each process retains
at most 16 sessions. Login removes expired records and evicts the oldest record before exceeding
that bound.

Single-admin authentication retains at most five login reservations in a rolling 60-second window.
Each form submission reserves capacity before scrypt begins, so concurrent requests cannot bypass
the bound. Invalid submissions retain their reservations and return the generic `401` response.
Further submissions return `429` with `Retry-After` until the oldest reservation leaves the window.
A successful login clears the reservations. The limit is process-wide because the mode has one
configured administrator and does not trust caller-supplied forwarding headers as client identity.

The CLI reads `WORKHORSE_DASHBOARD_USERNAME` and `WORKHORSE_DASHBOARD_PASSWORD_HASH`. Each value can
instead come from its `_FILE` variant, with one trailing line ending removed. A direct value and its
file variant are mutually exclusive, and the username and hash must be configured together.
`createDashboardHost` accepts either `authorize` or `singleAdmin`, and rejects both or neither.
`mutationProcedures` classifies `dashboard.enqueueTest`, `dashboard.setScheduleEnabled`,
`dashboard.setQueuePaused`, `dashboard.purgeQueue`, `dashboard.setWorkerPaused`,
`dashboard.overrideMaintenancePolicy`, `dashboard.revertMaintenancePolicy`,
`dashboard.overrideRetentionPolicy`, `dashboard.revertRetentionPolicy`, `dashboard.runTaskNow`,
and `dashboard.cancelTask` as private mutations. `rpcProcedure` maps the request path to that set.
For every match, `rejectCrossOriginMutation` requires an `Origin` header whose parsed origin exactly
matches the request URL origin. The single-admin session contributes its configured username as
`DashboardRpcContext.authenticatedActor`. An embedded `authorize` callback may return a
`DashboardPrincipal` with an `actor`; a compatible boolean `true` result uses the server-owned
`auditActor`, which defaults to `dashboard`. `auditWithOccurredAt` replaces the parsed browser
`audit.actor` with that authenticated actor before any operator controller runs.

`DashboardCommandOptions.socketPath` selects a Unix socket instead of `hostname` and `port`. The
unauthenticated development bypass accepts only an address in `127.0.0.0/8`, `::1`, or a Unix
socket. A remotely reachable TCP listener without authentication fails before `listen`.
An unauthenticated loopback or Unix-socket listener also rejects a non-loopback `publicOrigin`, so
an explicit proxy configuration cannot publish the development bypass.
An authenticated remote TCP listener also requires `publicOrigin`; its protocol must be HTTPS.
`dashboardNodeMiddleware` ignores `Forwarded` and `X-Forwarded-*` when it constructs the Fetch
request URL. If `publicOrigin` is configured, that canonical HTTP or HTTPS origin supplies the
scheme and authority instead. This keeps Secure-cookie and same-origin mutation policy independent
of untrusted proxy headers. The CLI maps `--socket`, `--public-origin`, and
`WORKHORSE_DASHBOARD_PUBLIC_ORIGIN` to those options.

`Dockerfile.dashboard` builds the core, dashboard contract, and dashboard package tarballs, then
installs those release-shaped artifacts with production dependencies into a Node 24 Alpine image.
The image runs as the `node` user, exposes port 3000, binds `0.0.0.0`, and starts the read-only
dashboard command. Its startup contract requires `DATABASE_URL` or `WORKHORSE_DATABASE_URL`, both
single-admin credential values, and an HTTPS `WORKHORSE_DASHBOARD_PUBLIC_ORIGIN`. The packed test
asserts that the image consumes the generated tarball names and starts the installed standalone
CLI through the same remote-listener contract.

`src/cli/dashboard.ts` imports only the shared contract. It loads the optional
`@workhorse/dashboard/standalone` entry and verifies that the module exports
`startDashboardServer`. The `@workhorse/core` manifest declares `@workhorse/dashboard` as an
optional peer, so a worker-only installation does not install React or the dashboard package.
`workhorse dashboard` reports the missing optional package before it opens a listener.

## OpenTelemetry traces, logs, and baseline metrics

The host application configures the OpenTelemetry context manager, propagator, readers, processors,
exporters, and resource. Queue correctness is unchanged when no SDK is installed. The operational
instruments above provide the detailed queue, job type, outcome, and fleet dimensions used by the
bundled SigNoz dashboards. The baseline instruments below retain a smaller attribute set for
deployments that enforce a fixed cardinality cap.

`Queue.enqueueMany` creates `workhorse.enqueue` and injects the active W3C context into the new
job's `job.trace_context`. The column accepts only `traceparent` and optional `tracestate`, requires
`traceparent`, and caps canonical JSONB text at 1,024 bytes. It is separate from `job.payload` and
is excluded from operator projections. An idempotent replay keeps the first accepted context.
`claim_v3` returns the stored value, and `Worker` extracts it before creating the
`workhorse.handler` consumer span. Baggage is never persisted.

The runtime emits `workhorse.enqueue`, `workhorse.claim`, `workhorse.handler`,
`workhorse.heartbeat`, `workhorse.retry`, `workhorse.complete`, `workhorse.recovery`,
`workhorse.maintenance`, and `workhorse.schedule.synchronize` spans. Span attributes may include
`workhorse.job.id`, `workhorse.job.type`, `workhorse.job.attempt`, and
`workhorse.queue.name`, because spans are sampled event records rather than metric dimensions.
Workhorse emits at most eight attributes on one span and exports
`TRACE_ATTRIBUTE_COUNT_LIMIT = 8` for matching SDK span limits.

The runtime emits structured OpenTelemetry log records through `@opentelemetry/api-logs`. Debug
records cover enqueue acceptance and replay, claims, accepted heartbeats, handler registration and
execution boundaries, checkpoints, progress, schedule replay, and worker deregistration. Info
records cover queue and worker lifecycle, final execution outcomes, rejected
heartbeats, completion and failure, cancellation, durable waits, promotion and recovery, schedule
changes, redrive, and maintenance that changes rows or returns an error.
Warning records identify handlers that catch a durable-wait suspension signal and return normally.

Debug event names are `workhorse.job.enqueued`, `workhorse.job.enqueue_replayed`,
`workhorse.job.claimed`, `workhorse.job.heartbeat_accepted`,
`workhorse.job.checkpoint_saved`, `workhorse.job.progress_updated`,
`workhorse.handler.registered`, `workhorse.handler.started`, `workhorse.handler.finished`,
`workhorse.schedule.fire_replayed`, `workhorse.worker.registered`, and
`workhorse.worker.deregistered`.
`workhorse.maintenance.completed` emits only when the phase changes rows or returns an error.
Successful no-ops and skipped advisory locks emit no log; maintenance counters and duration
histograms still record them.
`workhorse.worker_registry.pruned` uses debug when no stale registrations exist.

Info event names are `workhorse.jobs.promoted`, `workhorse.leases.recovered`,
`workhorse.queue.paused`, `workhorse.queue.resumed`, `workhorse.queue.purged`,
`workhorse.schedules.synchronized`, `workhorse.schedule.fired`,
`workhorse.jobs.redrive_processed`, `workhorse.job.run_now_requested`,
`workhorse.job.cancellation_processed`, `workhorse.job.cancellation_acknowledged`,
`workhorse.job.redrive_processed`, `workhorse.job.wait_processed`, `workhorse.job.completed`,
`workhorse.job.completion_rejected`, `workhorse.job.failure_processed`,
`workhorse.job.heartbeat_rejected`, `workhorse.job.ownership_expired`,
`workhorse.job.execution_finished`, `workhorse.worker.paused`, `workhorse.worker.resumed`,
`workhorse.worker.registration_failed`, `workhorse.worker.started`,
`workhorse.worker.stop_requested`, and `workhorse.worker.stopped`.
`workhorse.maintenance.completed` uses info when the phase changes rows or returns an error.
`workhorse.worker_registry.pruned` uses info when PostgreSQL removes registrations.
`workhorse.retention_policy.synchronized` and `workhorse.maintenance_policy.synchronized` record
successful configuration changes at info.

The warning event name is `workhorse.handler.signal_swallowed`. It carries bounded job and worker
identity plus `workhorse.handler.outcome`. It never carries the swallowed value or error.

The internal `logDebug`, `logInfo`, and `logWarn` functions accept the closed `WorkhorseLogEvent` union. They
set `eventName`, `severityNumber`, `severityText`, and a stable text body. Job records may use
`workhorse.job.id`, `workhorse.job.type`, `workhorse.job.attempt`, `workhorse.job.state`, and
`workhorse.operation.status`. Owned transitions add `workhorse.worker.id`.

Queue records use `workhorse.queue.name` and may add `workhorse.job.count`. Schedule records may
use `workhorse.schedule.namespace`, `workhorse.schedule.name`, and `workhorse.schedule.count`.
Recovery records use `workhorse.recovery.rows_affected`, `workhorse.recovery.expired_leases`, and
`workhorse.recovery.retried`. Redrive records may use `workhorse.redrive.target_job_id` and
`workhorse.redrive.dry_run`. Durable records use the bounded status plus
`workhorse.checkpoint.name` or `workhorse.wait.name`; they never use the stored value.

Maintenance records use `workhorse.maintenance.operation`, `workhorse.maintenance.phase`,
`workhorse.maintenance.rows_affected`, and `workhorse.maintenance.skipped_lock`. Worker
registration records may use concurrency, active slots, draining, and pause state. Handler
completion adds `workhorse.handler.duration_ms`.

`Worker.refreshRegistration` emits `workhorse.worker.registered` after the first successful
registration and when `activeSlots`, `draining`, or the PostgreSQL-owned pause result changes. The
durable heartbeat still runs at `registryIntervalMs`, but an unchanged refresh emits no log.

Logs may include job, worker, schedule, and checkpoint identity because logs are event records.
Workhorse never logs payloads, results, error messages, cancellation reasons, idempotency keys, or
progress and checkpoint values. The active OpenTelemetry context remains attached at emission, so
an SDK can correlate handler logs with the current trace. If the host installs no Logs SDK, the API
remains a no-op and queue behavior is unchanged.

`createDashboardHost` emits one OpenTelemetry log after `RPCHandler` returns a matched dashboard
RPC response. `workhorse.dashboard.rpc_completed` uses debug below 1,000 milliseconds and warning
at or above 1,000 milliseconds. `workhorse.dashboard.rpc_failed` uses error for an HTTP status of
400 or greater. Both events set `rpc.system = "orpc"`, the dot-separated procedure path in
`rpc.method`, `http.response.status_code`, and `workhorse.dashboard.rpc.duration_ms`. They never
include the request input, response output, error details, headers, or URL query. Dashboard assets,
application pages, authorization failures, and schema compatibility failures do not produce these
RPC records. Without a Logs SDK, the OpenTelemetry API discards them.

The demo preload always installs one `NodeSDK` and one rotating file log processor. It writes NDJSON
to `logs/<environment>/<service>.ndjson`, rotates before the next record would take the current file
past 10,485,760 bytes, and retains five numbered archives. `WORKHORSE_DEMO_LOG_DIRECTORY`,
`WORKHORSE_DEMO_LOG_MAX_BYTES`, and `WORKHORSE_DEMO_LOG_ARCHIVES` override the root, byte limit,
and archive count. The server and worker use different `service.name` values, so they never write
the same file. If `WORKHORSE_DEMO_TELEMETRY = "true"`, the same SDK adds exactly one OTLP log
processor plus automatic trace and metric instrumentation. Otherwise trace and metric exporters
are disabled while local structured logs remain active.

`registerQueueMetrics` adds these observable instruments, which the meter reads at collection time
rather than on an emission path:

- `workhorse.queue.depth` is an observable gauge split by `workhorse.queue.name` and the
  `workhorse.job.state` values `ready`, `scheduled`, and `active`.
- `workhorse.queue.oldest_ready_age` is an observable gauge in milliseconds, split by
  `workhorse.queue.name`.
- `workhorse.queue.concurrency.limit` is the queue's configured active-job limit.
- `workhorse.queue.concurrency.active` counts active rows with unexpired leases in governed queues.
- `workhorse.queue.concurrency.blocked_ready` reports bounded ready work that policy admission rejects.
- `workhorse.queue.dependencies.blocked`, `workhorse.queue.dependencies.pending_edges`, and
  `workhorse.queue.dependencies.failed_resolutions` report bounded dependency pressure by queue.
  `workhorse.queue.dependencies.capped` reports lower-bound samples. None uses stable job identities
  as attributes.
- `workhorse.queue.children.waiting_parents`, `workhorse.queue.children.pending`,
  `workhorse.queue.children.unjoined_results`, `workhorse.queue.children.failed_parents`, and
  `workhorse.queue.children.canceled_parents` report bounded child orchestration by parent queue.
  `workhorse.queue.children.capped` reports lower-bound samples.
- `workhorse.queue.rate_limit.configured`, `workhorse.queue.rate_limit.available_tokens`,
  `workhorse.queue.rate_limit.throttled_ready`, and
  `workhorse.queue.rate_limit.next_eligible_delay` report rate-policy state for governed queues.

`workhorse.queue.depth` and `WorkhorseMetricsObserver`'s `workhorse.jobs.count` measure the same
live work and read it the same way. `src/queue-depth.ts` owns every aggregate over
`workhorse.job_runtime`: `depthColumns()` renders named aggregates such as `ready`, `expired`, and
`oldest_ready_age_ms`, `totalDepthSelect()` renders the database-wide row the health snapshot uses,
and `perQueueDepthSelect()` renders the per-queue rows `Queue.queueMetricSnapshot()` and the
observer use. Every count aggregates the `job_id` primary key, so a queue with no runtime rows
reports zero across the outer join rather than one. Callers supply their own queue-name source and
name the aggregates they need; no caller writes its own aggregate.

`registerQueueMetrics(queue)` registers the database-wide depth, age, and concurrency callbacks and returns a
cleanup function. Register it once per database and telemetry resource; registering it for every
worker duplicates observations. `Queue.queueMetricSnapshot()` groups live pressure by every queue
present in `job_runtime`, `queue_control`, `worker_registry`, `concurrency_policy`, or
`rate_limit_policy`, plus the
`Queue.defaultQueue`. Concurrency metrics carry only `workhorse.queue.name`; raw key values never become
metric attributes.

Lifecycle counters and handler instruments use `workhorse.queue.name` and `workhorse.job.type`.
`workhorse.handler.executions` and `workhorse.handler.duration` add the bounded
`workhorse.handler.outcome`. `workhorse.jobs.failed` also uses the bounded
`workhorse.attempt.outcome` values `ready`, `scheduled`, `failed`, `cancel_requested`,
`deadline_exceeded`, `timeout_exceeded`, and `stale` returned by `fail_v1`.
Claim latency uses `workhorse.queue.name` and the bounded `workhorse.claim.result`. Maintenance
instruments retain their bounded loop attribute. Job IDs, worker IDs, schedule names, namespaces,
tags, payload values, and error messages remain forbidden metric attributes.

Queue and job type multiply the number of time series. Applications must keep both as stable
identifiers and must not embed customer or request identity in either value. Workhorse exports
`METRIC_ATTRIBUTE_CARDINALITY_LIMIT = 2,000`, matching the OpenTelemetry JavaScript SDK default,
for applications that configure explicit reader limits. Values beyond the configured SDK limit
enter its overflow series.

The host sets deployment-wide filters as OpenTelemetry resource attributes. Use
`deployment.environment.name` for the environment and `service.name` for the emitting process.
The SigNoz v6 import artifact at `docs/signoz/workhorse-business-metrics-v1.json` defines dynamic
environment, service, queue, and job-type variables.

Start production dashboards with ready and scheduled depth, oldest-ready age, and claiming and handler
latency percentiles. Add rates for enqueueing, claiming, and completing jobs, plus failure and retry
rates, expired leases, and maintenance drift. Alert when ready depth stays above zero while both claiming and completion rates
stay zero for 5 minutes; make that critical at 15 minutes. Warn when maintenance drift exceeds
twice its configured cadence for three consecutive observations, and make it critical above five
times the cadence. Warn when expired leases exceed 1% of jobs workers claim or failures exceed 5% of handler
settlements over 10 minutes; make failures critical above 20%. Replace the age and latency
thresholds with the application's queue-delay and handler-duration SLOs rather than using a
library-wide guess.

The `telemetry-context` operational scenario compares full enqueue and claiming durations for equal
baseline and instrumented cohorts. The instrumented cohort activates in-memory span and metric
exporters. The scenario verifies exports, payload isolation, context recovery, and the absence of a
dispatch index. Its stable order makes the timings diagnostic rather than a performance claim.

## Errors

Every error Workhorse raises deliberately extends `WorkhorseError` (`src/errors.ts`), which extends `Error` and sets `name` in each subclass. `instanceof WorkhorseError` therefore means "Workhorse rejected this call", not "this call failed": a PostgreSQL error, a handler's own throw, and a driver connection failure propagate unchanged and do not carry the base. The exported subclasses are `CheckpointConflictError`, `CheckpointLeaseLostError`, `EnqueueIdempotencyConflictError`, `JobContractUnavailableError`, `JobContractValidationError`, `JobValueSizeLimitError`, `MissingRowError`, `ProgressLeaseLostError`, `ProgressRateLimitError`, `RedriveIdempotencyConflictError`, `SignalIdempotencyConflictError`, `SignalWaitLeaseLostError`, `SignalWaitLimitExceededError`, `WaitConflictError`, `WaitLeaseLostError`, and `WaitLimitExceededError` from the queue, plus `CancellationRequestedError`, `DeadlineExceededError`, `ExecutionTimeoutError`, and `InjectedCrashError` from the worker.

Recognizing a PostgreSQL failure means reading through whatever an ORM wrapped it in. `databaseErrorCode(error)` returns the SQLSTATE and `databaseErrorDetails(error)` returns every `DETAIL` string along the chain. Both walk breadth-first over `cause`, `driverError`, and `meta`, visit at most 16 objects, and track visited objects so a cyclic `cause` terminates. A candidate SQLSTATE must match `/^[0-9A-Z]{5}$/`; a Prisma code matching `/^P\d{4}$/` on an object that also carries `meta` is held back and returned only when nothing nested supplies a real SQLSTATE, because Prisma reports `P2010` on the same field and retains the true SQLSTATE under `meta`.

Workhorse raises two SQLSTATEs of its own: `P1001` for an enqueue idempotency conflict and `P1002` for a redrive idempotency conflict. `Queue` converts each into its typed error, decoding the conflict diagnostics from `DETAIL`. A payload failing shape validation is discarded in favor of sanitized placeholder details rather than propagated, since `DETAIL` is diagnostic text an operator or an ORM can also write.

`expectOneRow(result, source)` takes the single row a statement is defined to return and throws `MissingRowError` naming `source` when the result is empty. An empty result from a set-returning function that declares one row means the installed schema and this client disagree.

## Delivery semantics

Workhorse provides durable at-least-once execution. Enqueue idempotency can make repeated acceptance attempts converge on one durable job identity, but it does not make handler execution or external effects exactly once. A process can die after an external effect but before completion commits, or after completion commits but before observing the response. Applications must use provider idempotency keys or transactional outbox/inbox patterns for non-idempotent effects.

Schedule occurrence deduplication prevents duplicate enqueue for one occurrence second. The worker's in-process scheduler supplies the planned occurrence slot as the key, and a per-occurrence advisory lock plus the durable key make concurrent workers racing the same fire converge on one job. This does not change handler delivery semantics: a scheduled job can still execute more than once after a worker crash.

## Deployment synchronization

`Queue.syncSchedules(namespace, definitions, { prune })` is a desired-state reconciler:

1. It validates stable namespace and schedule names plus queue job definitions, including optional retry policies.
2. It atomically upserts target definitions and by default deactivates omitted names through `sync_schedule_definitions_v1`.
3. A per-namespace advisory lock serializes concurrent deployments of the same namespace.

Because definitions live only in the target database, a deployment is one transaction: there is no second metadata database to converge. Every material definition change increments a revision, and worker fires pass the revision they loaded. A stale in-process schedule therefore becomes a no-op instead of running a new payload at an old cadence. Definition row locking also makes a disable deployment wait for a fire that already began before returning.

`Queue.syncConcurrencyPolicies(namespace, definitions, { prune })` reconciles queue dispatch budgets in
the same target database. A queue has one namespace owner. Concurrent synchronization serializes before
ownership checks, and a second namespace cannot replace the owner silently. Scheduled definitions retain
their `concurrencyKey`, while `fire_schedule_v1` sends it through ordinary enqueue admission metadata.

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

- The canonical artifact installs version 38. Forward migration starts at version 23; older schemas
  require a separately engineered upgrade path.
- Only plain PostgreSQL 15+ is required; no extension beyond the default `plpgsql` is installed.
- Schedules fire only while at least one worker with matching `scheduleNamespaces` is running; scheduling drift is bounded by `maintenanceIntervalMs` and catch-up after downtime is bounded by `scheduleCatchupLimit`.
- Job, outcome, event, attempt, and schedule-occurrence retention default to 14 days and remain independently configurable. Enqueue-idempotency bindings expire by their request TTL and are cleaned before terminal identity pruning.
- Default work bounds are 1,000 terminal jobs, four history partitions per category, 10,000 default-partition rows per category, and 10,000 schedule occurrences per maintenance pass.
- Health snapshots scan at most 100,001 terminal outcomes and 100,001 statistic buckets when counting; capped counts are flagged, exact-until-the-cap lower bounds.
- Schedules have one-second precision; cron expressions are evaluated in the worker's configured timezone, for which UTC is recommended.
- Runtime updates centralize churn in one relation and require vacuum and HOT-update validation under sustained heartbeat load.
- `NOTIFY` is a wake hint. Polling remains the correctness mechanism.
- `Worker.run()` subscribes through a process-local `JobNotificationHub` keyed by the exact
  notification connection identity. `Queue.supportsJobNotifications()` checks that capability and
  `Queue.subscribeToJobNotifications()` returns a `JobNotificationSubscription`; its `close()`
  removes that worker and closes the hub after the final subscriber. A node-postgres pool therefore
  reserves one shared connection for `LISTEN workhorse_jobs` regardless of the number of subscribing
  `Queue` or `Worker` objects. The Drizzle adapter forwards its node-postgres `$client.connect()`
  capability, uses `$client` as `notificationConnectionIdentity`, and reads capacity from
  `$client.options.max`. The Prisma, TypeORM, and Kysely adapters forward `connect()` from their
  optional `notificationPool`, use that pool as `notificationConnectionIdentity`, and read capacity
  from `notificationPool.options.max`. Without those capabilities, an adapter remains polling-only.
  A pool whose capacity is 1 also remains polling-only, which prevents its sole connection from being
  held away from claims. Queue-name payloads wake matching subscribers and `*` wakes all subscribers.
  Repeated
  notifications collapse through the worker's replace-on-wake `AbortController` rather than
  creating concurrent claim loops.
- Listener error or end events release the failed client, wake all subscribers, and reconnect after
  exponential delays from 100 ms through 5,000 ms with ±10% jitter. Initial connection and every
  reconnect also wake all subscribers, so work committed during the gap gets an immediate claim.
  `WorkerOptions.onNotificationError` observes failures; they never fail dispatch. The final
  subscriber issues `UNLISTEN`, releases the shared connection, and lets normal worker drain finish.
- Notification-capable `Worker.run()` uses a 5,000 ms default fallback poll with ±10% jitter. An
  explicit `pollMs` replaces that base. Query-only adapters and `runOnce()` retain the 250 ms
  compatibility default; `runOnce()` never opens a listener. Every empty poll still runs the same
  authoritative `claim_v3`, so lost notifications bound delay rather than changing correctness.
- Retention operates on minimum windows. Daily granularity, bounded passes, and retained attribution can extend actual storage beyond a configured cutoff.
