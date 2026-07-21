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

## Failure injection

The worker exposes failpoints at `afterClaim`, `beforeHandler`, `afterHandler`, `beforeComplete`, and `afterComplete`. `InjectedCrashError` bypasses normal failure handling so committed database state matches a process that disappeared at that boundary. The integration test suite exercises all five points.

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

- [Protocol reference](mvp-protocol.md)
- [Benchmark runbook](benchmarking.md)
- [Product viability evaluation](research/postgres-queue-product-viability-evaluation.md)
- [Architecture and product research](research/postgres-queue-architecture-and-product-strategy.md)
