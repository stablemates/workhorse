# Ironshift architecture

This document explains the validation MVP as a system: what each module owns, why the database is shaped this way, how jobs move through it, and which guarantees do and do not exist.

## Purpose and boundary

Ironshift tests one product hypothesis: a PostgreSQL queue can keep dispatch work small and predictable by separating immutable identity, narrow operational projections, bounded leases, and append-only history.

It is not yet a production queue product. The MVP intentionally omits cron, priorities, concurrency policies, rate limits, cancellation, workflows, a web UI, framework adapters, and automated retention scheduling. See the [viability evaluation](research/postgres-queue-product-viability-evaluation.md) for the evidence gates that must be met before broadening the product.

## System context

```mermaid
flowchart LR
  App[Application transaction] -->|enqueue_v1 in same transaction| PG[(PostgreSQL)]
  Worker[TypeScript Worker] -->|promote / recover / claim| PG
  PG -->|claimed payload + fence| Worker
  Worker -->|heartbeat| PG
  Worker -->|user handler, outside SQL transaction| Effect[External systems]
  Worker -->|complete or fail with fence| PG
  Health[Health CLI] -->|read-only diagnostics| PG
  Bench[Benchmark CLI] -->|controlled workloads| PG
```

PostgreSQL is the durable authority. The TypeScript process never owns a job merely because it received a notification or loaded a payload. Ownership exists only while the matching lease row, worker ID, fence token, and expiry remain valid.

## Repository map

| Path                       | Responsibility                                                                     |
| -------------------------- | ---------------------------------------------------------------------------------- |
| `sql/schema.sql`           | Canonical clean-database schema and all correctness-sensitive transition functions |
| `src/schema.ts`            | Loads the canonical schema for tests and explicit installation                     |
| `src/queue.ts`             | Thin typed client over versioned SQL transitions and read models                   |
| `src/worker.ts`            | Polling, heartbeats, handler dispatch, retries, shutdown, and crash injection      |
| `src/types.ts`             | Public protocol and diagnostics types                                              |
| `src/cli/reset-db.ts`      | Guarded development-only database recreation                                       |
| `src/cli/health.ts`        | Machine-readable queue and PostgreSQL diagnostics                                  |
| `benchmarks/run.ts`        | Conventional-table and hybrid-projection workload implementations                  |
| `src/cli/benchmark.ts`     | Benchmark argument parsing and JSON report writing                                 |
| `test/integration.test.ts` | Live-PostgreSQL correctness and crash-boundary contract                            |

The TypeScript client deliberately does not reproduce transition logic. It calls PostgreSQL functions so every client uses the same locking, fencing, event, and state rules.

## Data model

```mermaid
erDiagram
  job ||--|| job_current : "has current projection"
  job ||--o| ready_job : "is runnable"
  job ||--o| scheduled_job : "waits until run_at"
  job ||--o| lease : "is actively owned"
  job ||--o{ job_event : "emits lifecycle events"
  job ||--o{ attempt_history : "finalizes attempts"

  job {
    uuid id PK
    text queue_name
    text job_type
    jsonb payload
    int max_attempts
  }
  job_current {
    uuid job_id PK
    text state
    int current_attempt
    bigint version
    timestamptz run_at
  }
  ready_job {
    uuid job_id PK
    text queue_name
    int attempt
    bigint sequence
  }
  scheduled_job {
    uuid job_id PK
    timestamptz run_at
    int attempt
  }
  lease {
    uuid job_id PK
    text worker_id
    bigint fence_token
    timestamptz expires_at
  }
```

## Database field dictionary

The following tables describe every persisted column in `sql/schema.sql`. “Required” means PostgreSQL rejects `NULL`; it does not mean the caller always supplies the value directly.

### `schema_version`

Records which clean-schema protocol is installed. It is informational during the reset-based validation phase and provides a future compatibility check for clients.

| Field          | PostgreSQL type | Required/default                          | Written by          | Purpose                                                                                                                     |
| -------------- | --------------- | ----------------------------------------- | ------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `version`      | `integer`       | Required; primary key                     | Schema installation | Numeric protocol/schema version. The MVP installs version `1`. A client can reject a database with an incompatible version. |
| `installed_at` | `timestamptz`   | Required; defaults to `clock_timestamp()` | PostgreSQL          | Wall-clock time when that version row was installed. It is diagnostic metadata, not a migration ordering mechanism.         |

### `job`

Stores the immutable definition of accepted work. Rows are inserted once and are not used to find runnable work.

| Field          | PostgreSQL type | Required/default                                       | Written by   | Purpose                                                                                                                             |
| -------------- | --------------- | ------------------------------------------------------ | ------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| `id`           | `uuid`          | Required; primary key; defaults to `gen_random_uuid()` | `enqueue_v1` | Stable job identity shared by all attempts, events, projections, API responses, logs, and external idempotency schemes.             |
| `queue_name`   | `text`          | Required; non-empty check                              | `enqueue_v1` | Logical queue used to isolate claim ordering. A worker only claims rows for its configured queue.                                   |
| `job_type`     | `text`          | Required; non-empty check                              | `enqueue_v1` | Handler routing key. `Worker.handle(type, handler)` uses this value to select application code.                                     |
| `payload`      | `jsonb`         | Required                                               | `enqueue_v1` | Durable handler input. It is fetched only after ownership is established so payload size does not widen the ready relation.         |
| `max_attempts` | `integer`       | Required; `1..100`                                     | `enqueue_v1` | Maximum number of claims that may become attempts. When the current attempt reaches this value, failure or expiry becomes terminal. |
| `created_at`   | `timestamptz`   | Required; defaults to `clock_timestamp()`              | PostgreSQL   | Acceptance time of the stable job identity. It does not change on retries.                                                          |

### `job_current`

Stores one mutable, operator-facing current projection per job. Dispatch never scans this table.

| Field             | PostgreSQL type | Required/default                              | Written by                                      | Purpose                                                                                                                                                               |
| ----------------- | --------------- | --------------------------------------------- | ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `job_id`          | `uuid`          | Required; primary and foreign key to `job.id` | `enqueue_v1`                                    | Identity of the job whose current state this row summarizes. `ON DELETE CASCADE` removes it with the job definition.                                                  |
| `state`           | `text`          | Required; constrained enum                    | Every lifecycle transition                      | Current lifecycle state: `scheduled`, `ready`, `active`, `succeeded`, or `failed`. It is for lookup and operations, not claim eligibility.                            |
| `current_attempt` | `integer`       | Required; defaults to `0`; non-negative       | `claim_v1`                                      | Most recently claimed one-based attempt number. It remains `0` until the first claim.                                                                                 |
| `version`         | `bigint`        | Required; defaults to `0`; non-negative       | `claim_v1`                                      | Current fence token while active. After an attempt closes, it retains the last ownership generation so transition functions can detect projection/lease corruption.   |
| `run_at`          | `timestamptz`   | Required                                      | Enqueue, retry, recovery                        | Requested eligibility time for the current or next attempt. Scheduled placement uses it directly; ready placement may retain a value in the past.                     |
| `started_at`      | `timestamptz`   | Nullable                                      | `claim_v1`                                      | Claim time of the current or most recent attempt. A retry claim overwrites the prior value because immutable attempt timing lives in `attempt_history`.               |
| `finished_at`     | `timestamptz`   | Nullable                                      | Completion or terminal failure/recovery         | Time the job entered terminal `succeeded` or `failed`. It remains `NULL` while the job can still run.                                                                 |
| `result`          | `jsonb`         | Nullable                                      | `complete_v1`; cleared by claim                 | Durable successful handler result for operator lookup. It is `NULL` before success and is not an exactly-once record of an external side effect.                      |
| `error`           | `jsonb`         | Nullable                                      | `fail_v1` or recovery; cleared by claim/success | Normalized error for the last closed unsuccessful attempt while waiting to retry, or the terminal error. Immutable per-attempt errors also live in `attempt_history`. |
| `updated_at`      | `timestamptz`   | Required; defaults to `clock_timestamp()`     | Every lifecycle transition                      | Last time the current projection changed. It is useful for operational freshness and debugging, not strict event ordering.                                            |

### `ready_job`

Contains only work eligible for immediate claim. Keeping this row narrow is the central dispatch-path optimization.

| Field         | PostgreSQL type | Required/default                              | Written by                           | Purpose                                                                                                                                                                        |
| ------------- | --------------- | --------------------------------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `job_id`      | `uuid`          | Required; primary and foreign key to `job.id` | Enqueue, promotion, retry, recovery  | Identity of the runnable job. Uniqueness prevents two ready projections for one job. Claim deletes this row atomically with lease creation.                                    |
| `queue_name`  | `text`          | Required                                      | Same transition that inserts the row | Denormalized queue key used by `ready_job_claim_idx`, avoiding a join to the payload-bearing `job` table during selection.                                                     |
| `attempt`     | `integer`       | Required; at least `1`                        | Enqueue or prior attempt closure     | One-based attempt number that the next claim will start. Retry and recovery insert the previous attempt plus one.                                                              |
| `enqueued_at` | `timestamptz`   | Required; defaults to `clock_timestamp()`     | PostgreSQL                           | Time this attempt entered the ready projection. Health diagnostics use the minimum value to report oldest runnable age.                                                        |
| `sequence`    | `bigint`        | Required; generated identity                  | PostgreSQL                           | FIFO ordering key within a queue. Promotion and retry receive a new sequence when they become ready, so ordering reflects ready eligibility rather than original job creation. |

### `scheduled_job`

Contains only future attempts. It is scanned by due time, never by the ready claim query.

| Field        | PostgreSQL type | Required/default                              | Written by                               | Purpose                                                                                                                                   |
| ------------ | --------------- | --------------------------------------------- | ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `job_id`     | `uuid`          | Required; primary and foreign key to `job.id` | Enqueue, delayed retry, delayed recovery | Identity of the waiting job. Uniqueness prevents duplicate scheduled projections. Promotion deletes this row before creating a ready row. |
| `queue_name` | `text`          | Required                                      | Same transition that inserts the row     | Queue copied into the future projection so promotion can create `ready_job` without joining `job`.                                        |
| `attempt`    | `integer`       | Required; at least `1`                        | Enqueue or prior attempt closure         | One-based attempt number that should become runnable at `run_at`.                                                                         |
| `run_at`     | `timestamptz`   | Required                                      | Enqueue, retry, recovery                 | Earliest eligibility time. `promote_v1` only locks rows whose value is less than or equal to PostgreSQL's current clock.                  |

### `lease`

Represents active ownership of one attempt. Its size is bounded by concurrently executing jobs.

| Field          | PostgreSQL type | Required/default                              | Written by                        | Purpose                                                                                                                           |
| -------------- | --------------- | --------------------------------------------- | --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `job_id`       | `uuid`          | Required; primary and foreign key to `job.id` | `claim_v1`                        | Identity of the actively owned job. One row per job prevents simultaneous active attempts.                                        |
| `worker_id`    | `text`          | Required; non-empty check                     | `claim_v1`                        | Runtime identity that must match heartbeat, completion, and failure calls. It distinguishes workers sharing the same queue.       |
| `attempt`      | `integer`       | Required; at least `1`                        | `claim_v1`                        | One-based attempt currently executing. It is copied into immutable history when the lease closes.                                 |
| `fence_token`  | `bigint`        | Required; unique                              | `claim_v1` from `fence_token_seq` | Ownership generation. Even if an old worker resumes after expiry, its lower token cannot mutate the newer attempt.                |
| `acquired_at`  | `timestamptz`   | Required; defaults to `clock_timestamp()`     | PostgreSQL                        | Claim time used as the immutable attempt start when history is finalized. Heartbeats do not change it.                            |
| `heartbeat_at` | `timestamptz`   | Required; defaults to `clock_timestamp()`     | Claim and accepted heartbeat      | Last time the owning worker proved liveness. It is diagnostic; expiry is enforced through `expires_at`.                           |
| `expires_at`   | `timestamptz`   | Required                                      | Claim and accepted heartbeat      | Ownership deadline. Heartbeat, completion, and failure require it to still be in the future; recovery selects it after it passes. |

### `job_event`

Append-only lifecycle audit stream partitioned by `occurred_at`. It is deliberately independent of the hot dispatch tables.

| Field         | PostgreSQL type | Required/default                          | Written by                   | Purpose                                                                                                                                                                                    |
| ------------- | --------------- | ----------------------------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `event_id`    | `bigint`        | Required; generated identity              | PostgreSQL                   | Monotonic event sequence used as a tie-breaker for a job timeline. The partitioned table has no global primary-key constraint.                                                             |
| `job_id`      | `uuid`          | Required; logical reference               | Every lifecycle transition   | Job the event describes. It is intentionally not a foreign key so history partitions can be retained or retired independently of job-row retention.                                        |
| `attempt`     | `integer`       | Nullable                                  | Attempt-specific transitions | One-based attempt associated with the event. It is `NULL` for job-level events such as initial enqueue or promotion.                                                                       |
| `event_type`  | `text`          | Required                                  | Transition function          | Stable event discriminator such as `enqueued`, `claimed`, `retry_scheduled`, `lease_expired`, `succeeded`, or `failed`.                                                                    |
| `details`     | `jsonb`         | Required; defaults to `{}`                | Transition function          | Event-specific metadata, for example worker ID, fence token, next attempt, run time, next state, or normalized error. Consumers must branch on `event_type`.                               |
| `occurred_at` | `timestamptz`   | Required; defaults to `clock_timestamp()` | PostgreSQL                   | Event insertion time inside the transition transaction and monthly partition key. It becomes visible only after commit and orders history approximately; `event_id` breaks same-time ties. |

Known `job_event.details` object fields are:

| Event type        | Detail field   | Type                           | Purpose                                                                                                                                                               |
| ----------------- | -------------- | ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `enqueued`        | `state`        | `ready \| scheduled`           | Initial dispatch projection selected by enqueue.                                                                                                                      |
| `enqueued`        | `run_at`       | JSON timestamp string          | Requested initial eligibility time.                                                                                                                                   |
| `promoted`        | no fields      | empty object                   | Promotion currently needs no extra metadata; event time and job ID identify the transition.                                                                           |
| `claimed`         | `worker_id`    | `string`                       | Worker that acquired the lease.                                                                                                                                       |
| `claimed`         | `fence_token`  | JSON number                    | Ownership generation allocated by the claim. Consumers that require exact 64-bit values should read it as arbitrary-precision data rather than a JavaScript `number`. |
| `claimed`         | `expires_at`   | JSON timestamp string          | Initial lease deadline calculated by PostgreSQL.                                                                                                                      |
| `retry_scheduled` | `next_attempt` | `number`                       | One-based attempt number created after failure.                                                                                                                       |
| `retry_scheduled` | `run_at`       | JSON timestamp string          | Eligibility time of the next attempt.                                                                                                                                 |
| `retry_scheduled` | `error`        | error envelope                 | Error that closed the prior attempt.                                                                                                                                  |
| `lease_expired`   | `fence_token`  | JSON number                    | Ownership generation that expired.                                                                                                                                    |
| `lease_expired`   | `next_state`   | `ready \| scheduled \| failed` | State selected after closing the expired attempt.                                                                                                                     |
| `succeeded`       | `fence_token`  | JSON number                    | Ownership generation that committed success.                                                                                                                          |
| `failed`          | `error`        | error envelope                 | Terminal failure information.                                                                                                                                         |

The runtime-created error envelope contains:

| Field     | Type             | Purpose                                                                                |
| --------- | ---------------- | -------------------------------------------------------------------------------------- |
| `name`    | `string`         | JavaScript error class/name, `NonErrorThrown`, or `LeaseExpired`.                      |
| `message` | `string`         | Human-readable error message. Non-`Error` throws are converted with `String(value)`.   |
| `stack`   | `string \| null` | JavaScript stack when available. Database-created lease-expiry errors omit this field. |

### `attempt_history`

Append-only final record for every closed attempt, partitioned by `occurred_at`.

| Field         | PostgreSQL type | Required/default                          | Written by                                  | Purpose                                                                                                                                                    |
| ------------- | --------------- | ----------------------------------------- | ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `attempt_id`  | `bigint`        | Required; generated identity              | PostgreSQL                                  | Monotonic history-row identity. Like `event_id`, it is not declared as a global primary key across partitions.                                             |
| `job_id`      | `uuid`          | Required; logical reference               | Completion, failure, recovery               | Stable job whose attempt closed. It is not a foreign key so history retention is independent from operational job retention.                               |
| `attempt`     | `integer`       | Required                                  | Closing transition                          | One-based attempt that ended. The pair `job_id` and `attempt` identifies the logical attempt, though the MVP does not declare a uniqueness constraint.     |
| `fence_token` | `bigint`        | Required                                  | Closing transition                          | Ownership generation that closed the attempt. It connects audit history to the exact lease and detects stale-worker reports.                               |
| `worker_id`   | `text`          | Required                                  | Closing transition from lease               | Worker that held the lease when the attempt ended or expired. It supports incident analysis and worker-version correlation later.                          |
| `outcome`     | `text`          | Required; constrained enum                | Closing transition                          | Attempt result: `succeeded`, `failed`, `retry`, or `lease_expired`. `lease_expired` can lead to either another attempt or terminal job failure.            |
| `started_at`  | `timestamptz`   | Required                                  | Closing transition from `lease.acquired_at` | Immutable attempt start time. Runtime duration is `finished_at - started_at`.                                                                              |
| `finished_at` | `timestamptz`   | Required; defaults to `clock_timestamp()` | PostgreSQL                                  | Time the attempt was closed by success, failure, or recovery.                                                                                              |
| `error`       | `jsonb`         | Nullable                                  | Failure or recovery                         | Normalized attempt error. It is normally `NULL` for successful attempts.                                                                                   |
| `occurred_at` | `timestamptz`   | Required; defaults to `clock_timestamp()` | PostgreSQL                                  | History insertion time and monthly partition key. It is separate from `finished_at` so partitioning remains explicit even if finish-time semantics evolve. |

### Immutable identity

`job` stores facts that define the accepted work: identity, queue, handler type, payload, retry limit, and creation time. It is not scanned for dispatch.

### Current projection

`job_current` answers operator questions such as “what state is this job in?” It is updated only at lifecycle boundaries and is never part of the claim query. Its `version` stores the current fence token while active and retains the last ownership generation after the attempt closes.

### Dispatch projections

`ready_job` contains only runnable work. `scheduled_job` contains only future work. Splitting them prevents a large delayed backlog from occupying the claim index. Claiming deletes a ready row instead of mutating a large lifetime job table.

A job should appear in at most one of `ready_job`, `scheduled_job`, or `lease`. Terminal jobs appear in none of them.

### Active lease and fencing

`lease` is bounded by active worker concurrency rather than lifetime job volume. Each claim allocates a monotonically increasing fence token from `fence_token_seq`. Every heartbeat, completion, and failure includes that token.

Expiry alone is not sufficient protection. A paused worker may resume after another worker recovered and reclaimed the job. The old worker therefore also needs the old token, which PostgreSQL rejects after recovery.

### Append-only history

`job_event` records lifecycle events. `attempt_history` records one immutable outcome for every closed attempt. Both are monthly range-partitioned so old history can be retired with partition drops instead of row-by-row deletes.

The default partitions are a safety net. Regular operation should create the next partition before the month begins and move any matching rows out of the default partition before attaching a partition if the default already contains that range.

## Job lifecycle

```mermaid
stateDiagram-v2
  [*] --> Ready: enqueue run_at <= now
  [*] --> Scheduled: enqueue run_at > now
  Scheduled --> Ready: promote_v1
  Ready --> Active: claim_v1
  Active --> Succeeded: complete_v1, current fence
  Active --> Ready: fail_v1 or recover, immediate retry
  Active --> Scheduled: fail_v1 or recover, delayed retry
  Active --> Failed: retry budget exhausted
  Succeeded --> [*]
  Failed --> [*]
```

### Enqueue

`enqueue_v1` inserts `job`, `job_current`, one history event, and either `ready_job` or `scheduled_job` in one database transaction. Calling it through a `PoolClient` already inside `BEGIN` makes application writes and enqueue commit or roll back together.

`NOTIFY` is only emitted for immediately runnable work. PostgreSQL delivers it after commit. Workers still poll because notifications are hints, not durable jobs.

### Promotion

`promote_v1` selects a bounded due batch with `FOR UPDATE SKIP LOCKED`, removes those rows from `scheduled_job`, inserts them into `ready_job`, updates current state, and appends events within one statement transaction. Multiple workers can promote concurrently without moving the same row twice.

### Claim

`claim_v1` locks the oldest ready row for one queue with `SKIP LOCKED`. It then deletes the row, allocates a fence token, creates the lease, updates `job_current`, and appends a claim event before returning the payload.

The SQL transaction ends before the handler starts. No PostgreSQL row lock or application transaction is held while user code runs.

### Heartbeat

`heartbeat_v1` only extends an unexpired lease matching job ID, worker ID, and fence token. A false return means ownership has been lost. The worker aborts its local signal, but arbitrary user code must cooperate with that signal.

### Completion

`complete_v1` deletes only the matching unexpired lease. It then verifies `job_current.version`, marks success, inserts immutable attempt history, and appends the success event. A stale or expired worker receives `false` and cannot commit queue success.

### Failure and retry

`fail_v1` closes the matching active attempt. If retry budget remains, it creates the next attempt in ready or scheduled state. Otherwise it marks the job failed. Fence-integrity checks raise and roll back the whole SQL call if the lease and current projection disagree.

### Expiry recovery

`recover_expired_v1` locks expired leases in bounded batches. For each lease it closes immutable attempt history and either creates a new attempt or terminally fails the job. The old token is no longer valid after recovery.

## SQL transition interface dictionary

All intervals passed by the TypeScript client are integer milliseconds. PostgreSQL converts them into intervals inside the function so the database clock remains authoritative.

### `enqueue_v1`

| Parameter/return | Type          | Purpose                                                                                                                                                                |
| ---------------- | ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `p_queue_name`   | `text`        | Queue that will own the initial ready or scheduled projection. Empty values are rejected.                                                                              |
| `p_job_type`     | `text`        | Handler routing key persisted in `job.job_type`. Empty values are rejected.                                                                                            |
| `p_payload`      | `jsonb`       | Durable handler input. SQL converts a database `NULL` argument to JSON `null`, though the TypeScript API only accepts JSON values.                                     |
| `p_run_at`       | `timestamptz` | Initial eligibility time. A value at or before the database clock creates a ready row; a future value creates a scheduled row. Defaults to the current database clock. |
| `p_max_attempts` | `integer`     | Total claim attempts permitted, including the first. Defaults to `3` and must be between `1` and `100`.                                                                |
| return value     | `uuid`        | Newly generated stable `job.id`.                                                                                                                                       |

### `promote_v1`

| Parameter/return | Type      | Purpose                                                                                                 |
| ---------------- | --------- | ------------------------------------------------------------------------------------------------------- |
| `p_limit`        | `integer` | Maximum due rows to move in one transaction. SQL clamps it to `1..10000`; the client defaults to `100`. |
| return value     | `integer` | Number of scheduled rows successfully moved to ready and recorded as promotion events.                  |

### `claim_v1`

| Parameter/return   | Type                   | Purpose                                                                                                          |
| ------------------ | ---------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `p_queue_name`     | `text`                 | Queue whose oldest ready row should be claimed.                                                                  |
| `p_worker_id`      | `text`                 | Durable owner identity written into the lease. Empty values are rejected.                                        |
| `p_lease_ms`       | `integer`              | Initial ownership duration in milliseconds. Must be between `100` and `86400000` and defaults to `30000`.        |
| `job_id`           | returned `uuid`        | Stable claimed job identity. No row is returned when the queue has no eligible work.                             |
| `job_type`         | returned `text`        | Handler routing key loaded after ownership is established.                                                       |
| `payload`          | returned `jsonb`       | Durable handler input loaded after ownership is established.                                                     |
| `attempt`          | returned `integer`     | One-based attempt number started by this claim.                                                                  |
| `max_attempts`     | returned `integer`     | Retry ceiling copied from the immutable job definition.                                                          |
| `fence_token`      | returned `bigint`      | New ownership generation required by every subsequent attempt transition.                                        |
| `lease_expires_at` | returned `timestamptz` | Database-calculated initial lease deadline. It is a snapshot; heartbeats can move the authoritative value later. |

### `heartbeat_v1`

| Parameter/return | Type      | Purpose                                                                                                                                             |
| ---------------- | --------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `p_job_id`       | `uuid`    | Job whose active ownership should be extended.                                                                                                      |
| `p_worker_id`    | `text`    | Must equal `lease.worker_id`.                                                                                                                       |
| `p_fence_token`  | `bigint`  | Must equal the active ownership generation.                                                                                                         |
| `p_lease_ms`     | `integer` | New duration measured from the database clock at heartbeat execution. The TypeScript client normally reuses the worker's configured lease duration. |
| return value     | `boolean` | `true` when exactly one unexpired matching lease was extended; `false` when ownership is stale, expired, or belongs to another worker.              |

### `complete_v1`

| Parameter/return | Type      | Purpose                                                                                                                                   |
| ---------------- | --------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `p_job_id`       | `uuid`    | Job to move into terminal success.                                                                                                        |
| `p_worker_id`    | `text`    | Must equal the active lease owner.                                                                                                        |
| `p_fence_token`  | `bigint`  | Must equal both the active lease token and `job_current.version`.                                                                         |
| `p_result`       | `jsonb`   | Durable successful handler result stored in `job_current.result`; defaults to JSON `null`.                                                |
| return value     | `boolean` | `true` when success committed; `false` when the lease was absent, expired, or stale. Projection corruption raises and rolls back instead. |

### `fail_v1`

| Parameter/return   | Type      | Purpose                                                                                                                                                      |
| ------------------ | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `p_job_id`         | `uuid`    | Job whose current attempt ended unsuccessfully.                                                                                                              |
| `p_worker_id`      | `text`    | Must equal the active lease owner.                                                                                                                           |
| `p_fence_token`    | `bigint`  | Must equal the active lease and current projection generation.                                                                                               |
| `p_error`          | `jsonb`   | Normalized error envelope stored in current state, immutable history, and the failure/retry event.                                                           |
| `p_retry_delay_ms` | `integer` | Delay before the next attempt. Values at or below zero create a ready row; positive values create a scheduled row. Defaults to `0`.                          |
| return value       | `text`    | `ready`, `scheduled`, or `failed` for the committed next state; `stale` when no matching unexpired lease existed. Fence inconsistency raises and rolls back. |

### `recover_expired_v1`

| Parameter/return   | Type      | Purpose                                                                                                                        |
| ------------------ | --------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `p_limit`          | `integer` | Maximum expired leases to close in one transaction. SQL clamps it to `1..10000`; the client defaults to `100`.                 |
| `p_retry_delay_ms` | `integer` | Delay before recovered work becomes eligible. Non-positive values requeue immediately; positive values schedule it.            |
| return value       | `integer` | Number of expired attempts closed. The function raises and rolls back the batch if a lease/current fence invariant is corrupt. |

### `create_history_partitions_v1`

| Parameter/return | Type   | Purpose                                                                                                                                                               |
| ---------------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `p_month`        | `date` | Any date in the month to create. The function normalizes it to the month's first day and creates matching `job_event_YYYYMM` and `attempt_history_YYYYMM` partitions. |
| return value     | `void` | No data result. Existing partitions are left in place.                                                                                                                |

### `retire_history_month_v1`

| Parameter/return | Type   | Purpose                                                                                                                     |
| ---------------- | ------ | --------------------------------------------------------------------------------------------------------------------------- |
| `p_month`        | `date` | Any date in a completed month whose event and attempt partitions should be dropped. Current and future months are rejected. |
| return value     | `void` | No data result. Missing month partitions are tolerated through `DROP TABLE IF EXISTS`.                                      |

## Transaction and crash semantics

| Crash point                                        | Durable state                  | Expected recovery                          |
| -------------------------------------------------- | ------------------------------ | ------------------------------------------ |
| Before enqueue commit                              | No accepted job                | Caller retries transaction                 |
| After enqueue commit                               | Ready or scheduled job exists  | Worker eventually polls it                 |
| After claim commit, before handler                 | Active lease exists            | Lease expires and is recovered             |
| During handler                                     | External effect may be partial | Lease expires; handler may run again       |
| After external effect, before completion           | Effect may be duplicated       | Stable external idempotency key required   |
| After completion commit, before worker observes it | Job is succeeded               | No recovery; caller may have seen an error |

The queue provides at-least-once handler execution. It cannot make a payment, email, HTTP call, or other external side effect exactly once. Use provider idempotency keys, an outbox/inbox protocol, or compensation.

## Worker runtime

`Worker.runOnce()` performs one maintenance and dispatch cycle:

1. promote due scheduled rows;
2. recover expired leases;
3. claim one job;
4. start a heartbeat timer;
5. execute the registered handler outside a database transaction;
6. complete on success or fail/retry on error;
7. clear the heartbeat timer.

`Worker.run()` repeats that cycle and sleeps only when no job was claimed. The current MVP uses polling. `NOTIFY` listener integration is postponed so durable behavior never depends on session-pinned notification connections.

## Public TypeScript field dictionary

`Json` means JSON-compatible `null`, boolean, number, string, array, or object values. `Queryable` is the minimal `query(text, values)` contract shared by `pg.Pool` and `pg.PoolClient`; it has no persisted fields.

### `Queue` instance

| Field          | Type     | Purpose                                                                                                                     |
| -------------- | -------- | --------------------------------------------------------------------------------------------------------------------------- |
| `defaultQueue` | `string` | Public default queue used by enqueue and claim calls when an operation-specific queue is omitted. It defaults to `default`. |

The constructor's database handle is private. It can be a pool or transaction-capable query object satisfying `Queryable`.

### `EnqueueOptions`

| Field         | Type     | Optional/default               | Purpose                                                                                                                               |
| ------------- | -------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| `queue`       | `string` | Optional; `Queue.defaultQueue` | Selects the durable `queue_name` for this job.                                                                                        |
| `runAt`       | `Date`   | Optional; current client time  | Initial eligibility time sent to `enqueue_v1`. PostgreSQL compares it with the database clock to choose ready or scheduled placement. |
| `maxAttempts` | `number` | Optional; `3`                  | Total permitted attempts, including the first. PostgreSQL validates the `1..100` range.                                               |

### `ClaimedJob<TPayload>`

| Field            | Type       | Purpose                                                                                                                                                             |
| ---------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`             | `string`   | Stable UUID job identity.                                                                                                                                           |
| `type`           | `string`   | Handler routing key from `job.job_type`.                                                                                                                            |
| `payload`        | `TPayload` | Typed view of the durable JSON payload. The generic cast is trusted by the caller; runtime schema validation is not included.                                       |
| `attempt`        | `number`   | One-based attempt currently owned.                                                                                                                                  |
| `maxAttempts`    | `number`   | Maximum attempt count from the immutable job definition.                                                                                                            |
| `fenceToken`     | `bigint`   | Ownership generation required for heartbeat, completion, and failure. It remains a `bigint` because PostgreSQL `bigint` can exceed JavaScript's safe integer range. |
| `leaseExpiresAt` | `Date`     | Expiry returned by claim. It is informational because a heartbeat may extend the database row later.                                                                |

### Handler context

The handler's first argument is `payload: TPayload`, the typed view of `ClaimedJob.payload`. Its second argument is the context object below.

| Field    | Type                   | Purpose                                                                                                                                |
| -------- | ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `job`    | `ClaimedJob<TPayload>` | Full ownership and attempt metadata for logs, external idempotency keys, and handler decisions.                                        |
| `signal` | `AbortSignal`          | Cooperative cancellation signal aborted when heartbeat fails or lease ownership is lost. It cannot forcibly stop non-cooperative code. |

### `WorkerOptions`

| Field          | Type                              | Optional/default                                              | Purpose                                                                                                                                            |
| -------------- | --------------------------------- | ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `queue`        | `string`                          | Optional; queue default                                       | Queue claimed by this worker instance.                                                                                                             |
| `workerId`     | `string`                          | Optional; `worker-${process.pid}`                             | Durable lease owner. Production deployments should make it unique across simultaneously running processes, usually with host and process identity. |
| `leaseMs`      | `number`                          | Optional; `30000`                                             | Ownership duration granted at claim and heartbeat. It must be longer than `heartbeatMs`.                                                           |
| `heartbeatMs`  | `number`                          | Optional; approximately one-third of `leaseMs`, minimum `100` | Local interval between lease-extension attempts. Shorter intervals improve failure margin but increase database writes.                            |
| `pollMs`       | `number`                          | Optional; `250`                                               | Sleep duration after an empty claim cycle. It controls idle latency and empty-poll load.                                                           |
| `retryDelayMs` | `number` or `(attempt) => number` | Optional; `0`                                                 | Fixed or attempt-dependent delay used after ordinary handler failure. Positive values schedule; zero or negative values requeue immediately.       |
| `failpoint`    | `Failpoint` or callback           | Optional                                                      | Test-only hook that throws `InjectedCrashError` at a selected transition boundary without closing the lease.                                       |

### `InjectedCrashError`

In addition to standard JavaScript `Error.name`, `Error.message`, and optional `Error.stack`, the injected crash error exposes:

| Field       | Type        | Purpose                                                                                                        |
| ----------- | ----------- | -------------------------------------------------------------------------------------------------------------- |
| `failpoint` | `Failpoint` | Exact boundary at which the deterministic crash was injected. Tests can use it to distinguish crash scenarios. |

### `JobSnapshot<TResult>`

| Field            | Type                                                  | Purpose                                                                                                             |
| ---------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `id`             | `string`                                              | Stable UUID from `job.id`.                                                                                          |
| `queue`          | `string`                                              | Logical queue from `job.queue_name`.                                                                                |
| `type`           | `string`                                              | Handler key from `job.job_type`.                                                                                    |
| `payload`        | `Json`                                                | Durable input payload.                                                                                              |
| `state`          | `scheduled \| ready \| active \| succeeded \| failed` | Current operator-facing lifecycle state.                                                                            |
| `currentAttempt` | `number`                                              | Most recently claimed attempt, or `0` before first claim.                                                           |
| `maxAttempts`    | `number`                                              | Retry ceiling from the immutable definition.                                                                        |
| `fenceToken`     | `bigint`                                              | Current or last ownership generation from `job_current.version`. It does not itself prove an active lease exists.   |
| `runAt`          | `Date`                                                | Current/next eligibility time in the current projection.                                                            |
| `result`         | `TResult \| null`                                     | Durable successful result, or `null` before success. The generic type is caller-supplied and not runtime validated. |
| `error`          | `Json \| null`                                        | Current retry/terminal error envelope, or `null` when none is exposed.                                              |
| `createdAt`      | `Date`                                                | Stable job acceptance time.                                                                                         |
| `updatedAt`      | `Date`                                                | Last current-projection transition time.                                                                            |

### `QueueHealth`

| Field                    | Type             | Purpose                                                                                                                    |
| ------------------------ | ---------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `schemaVersion`          | `number \| null` | Highest installed protocol version, or `null` when no version row exists.                                                  |
| `counts.scheduled`       | `number`         | Current jobs whose operator state is scheduled.                                                                            |
| `counts.ready`           | `number`         | Current jobs whose operator state is ready.                                                                                |
| `counts.active`          | `number`         | Current jobs whose operator state is active.                                                                               |
| `counts.succeeded`       | `number`         | Retained jobs in terminal success.                                                                                         |
| `counts.failed`          | `number`         | Retained jobs in terminal failure.                                                                                         |
| `readyDepth`             | `number`         | Exact current row count in `ready_job`. Compare with `counts.ready` to detect projection drift.                            |
| `scheduledDepth`         | `number`         | Exact current row count in `scheduled_job`.                                                                                |
| `activeLeases`           | `number`         | Exact current row count in `lease`.                                                                                        |
| `expiredLeases`          | `number`         | Leases whose `expires_at` has passed and are eligible for recovery. A persistent non-zero value can indicate recovery lag. |
| `oldestReadyAgeMs`       | `number \| null` | Milliseconds since the oldest attempt entered `ready_job`, or `null` when no work is ready.                                |
| `relations`              | relation array   | Per-relation PostgreSQL storage and churn observations described below.                                                    |
| `oldestTransactionAgeMs` | `number \| null` | Age of the oldest other open transaction. Long transactions can delay vacuum cleanup.                                      |
| `lockWaitCount`          | `number`         | Other sessions currently waiting on PostgreSQL locks.                                                                      |
| `notificationQueueUsage` | `number`         | Fraction from `0` to `1` of PostgreSQL's global asynchronous notification queue in use.                                    |

Each `QueueHealth.relations` entry contains:

| Field                       | Type             | Purpose                                                                                                               |
| --------------------------- | ---------------- | --------------------------------------------------------------------------------------------------------------------- |
| `relation`                  | `string`         | PostgreSQL relation name in the `ironshift` schema. Parent partitioned tables and child partitions appear separately. |
| `totalBytes`                | `number`         | Heap, indexes, and auxiliary storage reported by `pg_total_relation_size`.                                            |
| `tableBytes`                | `number`         | Main relation bytes reported by `pg_relation_size`.                                                                   |
| `indexBytes`                | `number`         | Sum of attached index bytes reported by `pg_indexes_size`.                                                            |
| `liveTuples`                | `number`         | PostgreSQL estimate of live rows. It may lag recent transactions.                                                     |
| `deadTuples`                | `number`         | PostgreSQL estimate of dead row versions awaiting or surviving cleanup. It is a trend signal, not an exact count.     |
| `modificationsSinceAnalyze` | `number`         | Estimated row modifications since statistics were last analyzed. High values can make planner estimates stale.        |
| `hotUpdateRatio`            | `number \| null` | `n_tup_hot_upd / n_tup_upd`, or `null` before any updates. Higher values mean more updates avoided new index entries. |
| `lastVacuum`                | `Date \| null`   | Last manual vacuum time known to PostgreSQL statistics.                                                               |
| `lastAutovacuum`            | `Date \| null`   | Last automatic vacuum time known to PostgreSQL statistics.                                                            |

The health queries run concurrently and do not share one repeatable-read snapshot. Under active traffic, counts can describe slightly different instants. They are operational observations, not a transactional consistency proof.

## Failure injection

The worker exposes failpoints at `afterClaim`, `beforeHandler`, `afterHandler`, `beforeComplete`, and `afterComplete`. `InjectedCrashError` bypasses normal failure handling so committed database state matches a process that disappeared at that boundary. The integration test suite exercises all five points.

| Failpoint value  | Durable point represented                                                                                 |
| ---------------- | --------------------------------------------------------------------------------------------------------- |
| `afterClaim`     | Claim committed and lease exists, but handler lookup/execution has not started.                           |
| `beforeHandler`  | Handler was found and heartbeat infrastructure exists, but user code has not run.                         |
| `afterHandler`   | User code and any external effect returned, but no completion call has started.                           |
| `beforeComplete` | Handler result exists and ownership still appears local, immediately before the completion query.         |
| `afterComplete`  | PostgreSQL committed success, but the worker process has not yet observed a normal return from the cycle. |

## Health model

`Queue.health()` reports:

- state counts and ready/scheduled/active depth;
- expired leases and oldest ready age;
- total, table, and index bytes by relation;
- estimated live/dead tuples and modifications since analyze;
- HOT update ratio and vacuum timestamps;
- oldest open transaction age and current lock wait count;
- PostgreSQL notification queue usage.

These are diagnostic signals, not alert thresholds. Long-run validation must record them over time alongside workload rates and PostgreSQL settings.

## Development database lifecycle

There is no incremental migration system during this validation phase. `sql/schema.sql` is canonical. After a schema change, recreate the dedicated database:

```bash
export DATABASE_URL=postgres://ironshift:ironshift@localhost:5432/ironshift_test
pnpm db:reset
```

The reset tool requires an explicit URL, a database name ending in `_test`, confirmation from the package script, and localhost unless `IRONSHIFT_ALLOW_REMOTE_RESET=1` is deliberately set.

## Architectural invariants

1. Accepted enqueue data and its initial dispatch projection commit atomically.
2. A job is never claimed from `job` or `job_current`.
3. Handler code never runs while a claim transaction is open.
4. A lease is valid only for its exact worker, fence token, and unexpired interval.
5. Retry and recovery create a new attempt. They never mutate an old attempt into a new one.
6. Every closed attempt has immutable history.
7. A stale fence cannot complete, fail, heartbeat, or recover a newer attempt.
8. Notifications may reduce latency but never establish durability or ownership.
9. Benchmark results are evidence only when workload, settings, raw JSON, and semantic differences are disclosed.

## Deliberate limitations

- No enqueue idempotency key is implemented yet.
- Ready ordering is FIFO per queue. Priority is not implemented.
- Retention functions exist, but no scheduler invokes them.
- The conventional benchmark prototype covers the success path and is not fully semantics-equivalent.
- There is no dedicated notification listener, multi-process scheduler leader, UI, OpenTelemetry package, or framework integration.
- The reset-and-install workflow is suitable for validation, not production schema evolution.

## Further reading

- [Feature support matrix](features.md)
- [Protocol reference](mvp-protocol.md)
- [Benchmark runbook](benchmarking.md)
- [Product viability evaluation](research/postgres-queue-product-viability-evaluation.md)
- [Architecture and product research](research/postgres-queue-architecture-and-product-strategy.md)
