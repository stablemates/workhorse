# Ironshift architecture

Ironshift is a PostgreSQL-backed durable queue whose correctness-sensitive lifecycle transitions live in versioned SQL functions. The TypeScript `Queue` and `Worker` remain thin protocol clients.

## Design objective

Dispatch cost should scale with live work, not lifetime completed work. Schema version 2 therefore stores:

- immutable accepted identity and payload in `job`
- exactly one mutable `job_runtime` row only while a job is scheduled, ready, or active
- exactly one immutable `job_outcome` row after success or terminal failure
- append-only, time-partitioned `job_event` and `attempt_history`

No compatibility write views are installed for the version 1 projection tables.

## System context

```mermaid
flowchart LR
  App[Application transaction] -->|enqueue_many_v1 / enqueue_v1| PG[(PostgreSQL)]
  Deploy[Deployment] -->|PgCronScheduler.sync| PG
  Deploy -->|schedule_in_database / prune| Cron[(postgres.cron)]
  Cron -->|fire_schedule_v1 / maintain_v1| PG
  Worker[TypeScript Worker] -->|claim / heartbeat| PG
  PG -->|payload + attempt + fence| Worker
  Worker -->|handler outside SQL transaction| Effects[External effects]
  Worker -->|complete_v1 / fail_v1| PG
  Health[Health and scenarios] -->|read runtime + outcome + statistics| PG
```

PostgreSQL is the durable authority. A worker owns a job only while the active `job_runtime` row matches its worker ID and fence token and has not expired.

## Data model

```mermaid
erDiagram
  job ||--o| job_runtime : "live lifecycle"
  job ||--o| job_outcome : "terminal lifecycle"
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
  schedule_definition {
    text namespace PK
    text schedule_name PK
    text cron_expression
    text queue_name
    text job_type
    jsonb payload
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

Insert-only identity, routing, payload, retry budget, and acceptance time. Dispatch reads payload only after a runtime row has been claimed.

### `job_runtime`

The only mutable lifecycle relation. Its check constraint makes state-specific fields mutually exclusive:

- `scheduled`: `run_at` is populated; ready and ownership fields are null
- `ready`: `ready_at` and FIFO `sequence` are populated; ownership fields are null
- `active`: worker, acquisition, heartbeat, expiry, and positive fence are populated; ready placement fields are null

Retry and recovery increment `current_attempt` while moving the same row back to ready or scheduled. Heartbeats update only the matching active generation.

Selective indexes keep unrelated states out of each access path:

| Index                            | Predicate             | Purpose                                                     |
| -------------------------------- | --------------------- | ----------------------------------------------------------- |
| `job_runtime_ready_idx`          | `state = 'ready'`     | Queue-local FIFO claims by `(queue_name, sequence, job_id)` |
| `job_runtime_scheduled_idx`      | `state = 'scheduled'` | Bounded due promotion by `(run_at, job_id)`                 |
| `job_runtime_expired_active_idx` | `state = 'active'`    | Bounded recovery by `(expires_at, job_id)`                  |

The table uses fillfactor 70 because heartbeat and lifecycle updates are intentional churn. State changes can still require index maintenance when rows enter or leave a partial index.

### `job_outcome`

Insert-only terminal state. Completion or terminal failure deletes the active runtime row and inserts the outcome in one transaction. Succeeded rows contain `result`; failed rows contain `error`. Terminal jobs no longer occupy dispatch indexes.

### History

`job_event` is the append-only lifecycle audit. `attempt_history` contains one immutable row for every closed attempt, including retry, lease expiry, success, and terminal failure. Both remain range-partitioned by month with default partitions and the existing partition create/retire functions.

### Declarative schedules

`schedule_definition` is the target database's desired-state record for one deployment namespace. It stores validated cron text, a typed Ironshift job definition, and a monotonically increasing revision, never arbitrary SQL. Removed definitions are disabled rather than deleted so occurrence history remains attributable.

`schedule_occurrence` provides one durable key per `(namespace, schedule_name, occurrence_at)` second. `fire_schedule_v1` inserts that key and enqueues through `enqueue_v1` in one transaction. A repeated fire for the same second returns the existing job ID instead of creating another job.

pg_cron metadata remains in the cluster's configured `postgres` database. Its generated commands contain only revision-fenced calls to `fire_schedule_v1` or bounded calls to `maintain_v1`. Names include target database and namespace, allowing deploy synchronization and reset tooling to prune only entries they own.

## Atomic lifecycle

```mermaid
stateDiagram-v2
  [*] --> ready: enqueue due
  [*] --> scheduled: enqueue future
  scheduled --> ready: promote
  ready --> active: claim
  active --> active: heartbeat
  active --> ready: fail/recover, immediate retry
  active --> scheduled: fail/recover, delayed retry
  active --> succeeded: complete
  active --> failed: exhausted fail/recovery
```

### Enqueue

`enqueue_many_v1` parses and validates at most 1,000 requests against one timestamp. One statement inserts `job`, `job_runtime`, and `enqueued` events. Input ordinality controls returned IDs and ready sequence allocation. Any invalid member rolls back the entire batch. Commit-delivered `NOTIFY ironshift_jobs` is coalesced to one notification per distinct queue that gained ready work.

### Promotion

`promote_v1` locks a bounded due set with `FOR UPDATE SKIP LOCKED`, updates those runtime rows from scheduled to ready, assigns new FIFO sequences, appends events, and emits a wake hint.

Production promotion is coordinated by a namespaced pg_cron maintenance job. `maintain_v1` calls bounded promotion, bounded expired-lease recovery, and bounded schedule-occurrence retention once per configured interval. Workers default to external maintenance and therefore issue only the claim query; `maintenance: "worker"` retains the old cooperative behavior as an explicit fallback.

### Claim

`claim_v1` selects one queue-local ready row by FIFO sequence with `SKIP LOCKED`. One runtime update changes it to active and installs worker, global fence, acquisition, heartbeat, and expiry data. The claim event is appended before the function returns identity and payload. No transaction remains open while user code runs.

### Heartbeat

`heartbeat_v1` is a compare-and-set update over job ID, active state, worker ID, fence token, and unexpired lease. `false` means ownership is stale.

### Retry and recovery

`fail_v1` locks the matching unexpired active generation. If budget remains, a compare-and-set runtime update increments the attempt and places the row in ready or scheduled state. Otherwise it deletes runtime and inserts a failed outcome. In both cases it closes attempt history and appends an event atomically.

`recover_expired_v1` cooperatively locks expired active rows in bounded batches. It performs the same increment-and-requeue or delete-and-outcome transition using the observed fence and expiry as CAS guards. Old workers cannot later complete because their active generation no longer exists.

### Terminal transitions

`complete_v1` and exhausted failure consume only the matching unexpired active row. Runtime deletion, outcome insertion, attempt closure, and event append commit or roll back together.

## Read models and health

`Queue.getJob(id)` joins immutable `job` to both lifecycle relations and coalesces the one that exists, preserving the public `JobSnapshot` shape. Health state counts union runtime and outcome. Ready, scheduled, active, expired-active, and oldest-ready metrics come directly from `job_runtime`.

## Delivery semantics

Ironshift provides durable at-least-once execution. A process can die after an external effect but before completion commits, or after completion commits but before observing the response. Applications must use idempotency keys or transactional outbox/inbox patterns for non-idempotent effects.

Schedule occurrence deduplication prevents duplicate enqueue for one supplied occurrence second. pg_cron-generated calls use the observed execution second because pg_cron does not expose its planned slot to the target command. This does not change handler delivery semantics: a scheduled job can still execute more than once after a worker crash.

## Deployment synchronization

`PgCronScheduler.sync()` is a desired-state reconciler:

1. It validates stable namespace and schedule names plus queue job definitions.
2. It preflights extension, schema, metadata-read, scheduling, and unscheduling privileges.
3. It atomically upserts target definitions and optionally deactivates omitted names.
4. It holds a target-wide metadata-database session lock and target namespace lock across the full reconciliation, then transactionally creates or updates named pg_cron jobs.
5. It prunes only current-role jobs with the exact target-database and namespace prefix.

Target and cron metadata databases cannot share one PostgreSQL transaction. The target definition commits first; cron reconciliation then converges. Every material definition change increments a revision embedded in the generated command. A failed cron update therefore leaves accepted desired state while the old command becomes a no-op, which is safe to retry on the next deployment. Definition row locking also makes a disable deployment wait for a fire that already began before returning.

## Operational limits

- The canonical schema is a clean-install artifact, not an online version 1 to version 2 migration.
- pg_cron 1.6+ must be installed and preloaded in the cluster's configured metadata database.
- The deploy role needs `USAGE` and metadata reads on `cron`, plus execution of `schedule_in_database` and `unschedule(bigint)`.
- pg_cron must be able to authenticate as the target role; suspended serverless compute pauses schedules.
- `schedule_occurrence` defaults to 30-day retention with at most 10,000 deletions per maintenance run; pg_cron run-history retention remains administrator-owned.
- Provider-specific setup and compatibility requirements are documented in `docs/pg-cron-requirements.md` and checked by `pnpm pg-cron:check`.
- Schedules have one-second precision and use the cluster-wide pg_cron timezone, for which UTC is recommended.
- Runtime updates centralize churn in one relation and require vacuum and HOT-update validation under sustained heartbeat load.
- `NOTIFY` is a wake hint. Polling remains the correctness mechanism.
- History partition creation and retirement remain an explicit policy even though runtime maintenance is scheduled.
- Retention for immutable `job` and `job_outcome` is not automated.
