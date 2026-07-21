# Feature support matrix

This document is the authoritative snapshot of what the Ironshift validation MVP supports today. It describes implemented behavior, not a production-readiness claim.

## Status definitions

- **Supported:** implemented, exposed through the current SQL or TypeScript contract, and covered by the live-PostgreSQL integration suite where applicable.
- **Partial:** a useful primitive exists, but important operational, semantic, or product behavior is still missing.
- **Not supported:** no stable implementation or public contract exists. Applications must not assume the capability.

## At a glance

| Supported core                                 | Partial today                                      | Not supported today                                |
| ---------------------------------------------- | -------------------------------------------------- | -------------------------------------------------- |
| Transactional immediate/delayed enqueue        | One-handler-at-a-time worker instances             | Priorities and enqueue idempotency                 |
| FIFO `SKIP LOCKED` claims                      | Polling despite emitted `NOTIFY` hints             | Cron, cancellation, deadlines, progress            |
| Leases, heartbeats, fencing, recovery          | Per-worker scheduling and graceful stop            | Concurrency policies and rate limiting             |
| Immediate/delayed retries and terminal failure | Manual partition lifecycle                         | Dead letters, redrive, dependencies, workflows     |
| Append-only events and attempt history         | Point-in-time health without a consistent snapshot | UI, RBAC, OpenTelemetry, framework/ORM adapters    |
| Health JSON and crash-boundary tests           | Success-path benchmark baseline                    | Production migrations and compatibility guarantees |

## Core job and dispatch features

| Feature                                       | Status        | Current behavior and limits                                                                                                                                             |
| --------------------------------------------- | ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Stable job identity                           | Supported     | Every accepted job receives one UUID that remains stable across all attempts, events, leases, and lookups.                                                              |
| JSON payloads                                 | Supported     | JSON-compatible payloads are stored durably in `job.payload` and returned after claim. Runtime schema validation and payload size limits are not included.              |
| Named job types                               | Supported     | `job_type` routes claimed work to handlers registered with `Worker.handle()`. Missing handlers close the attempt as an ordinary failure.                                |
| Named queues                                  | Supported     | Enqueue and claim accept a queue name. FIFO ordering is isolated per queue.                                                                                             |
| FIFO ordering                                 | Supported     | `ready_job.sequence` orders currently ready work within a queue. Scheduled or retried attempts receive a new sequence when they become ready.                           |
| Immediate enqueue                             | Supported     | Jobs whose `runAt` is now or in the past enter `ready_job`.                                                                                                             |
| Delayed enqueue                               | Supported     | Future jobs enter `scheduled_job` and become ready through bounded promotion.                                                                                           |
| Bounded scheduled promotion                   | Supported     | `promote_v1(limit)` moves due rows with `FOR UPDATE SKIP LOCKED`; each worker performs promotion before claim.                                                          |
| Transactional enqueue with application writes | Supported     | Passing an active `pg.PoolClient`/`Queryable` makes `enqueue_v1` participate in the caller transaction. Ironshift does not begin or commit that transaction.            |
| Multi-worker claims                           | Supported     | `FOR UPDATE SKIP LOCKED` prevents workers from blocking behind or claiming the same ready row.                                                                          |
| Single-process handler registry               | Supported     | A worker maps job types to TypeScript handlers. Dynamic discovery or dependency injection integration is not included.                                                  |
| Worker concurrency                            | Partial       | One `Worker` instance executes one handler at a time. Concurrency is achieved by running multiple worker instances; there is no per-worker concurrency setting or pool. |
| Multiple queues per worker                    | Partial       | A worker instance claims one configured queue. Applications can construct several workers, but there is no one-worker multi-queue policy.                               |
| Priority jobs                                 | Not supported | Ready ordering is FIFO only; no priority column or ordering rule exists.                                                                                                |
| Job uniqueness/idempotency keys               | Not supported | Repeating enqueue creates another job. There is no unique job key, deduplication scope, or retention contract.                                                          |
| Debounce or throttle-on-enqueue               | Not supported | Every accepted enqueue creates durable work.                                                                                                                            |
| Batch enqueue API                             | Not supported | Callers may use SQL or their own transaction loop, but no stable batch API is exposed.                                                                                  |

## Ownership, execution, and delivery semantics

| Feature                                   | Status        | Current behavior and limits                                                                                                                                                            |
| ----------------------------------------- | ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Durable active leases                     | Supported     | Claim creates one lease with worker ID, attempt number, fence token, acquisition time, heartbeat time, and expiry.                                                                     |
| Monotonic fencing                         | Supported     | Every claim allocates a new `bigint` fence token. Heartbeat, completion, failure, and recovery verify the active generation.                                                           |
| Heartbeats                                | Supported     | The worker periodically extends the exact matching unexpired lease. Rejection aborts the handler's cooperative signal.                                                                 |
| Expired-lease recovery                    | Supported     | Bounded recovery closes expired attempt history and creates a new attempt or terminally fails the job. Multiple recoverers cooperate with `SKIP LOCKED`.                               |
| Stale worker rejection                    | Supported     | A worker with an expired or replaced fence cannot heartbeat, complete, or fail the newer attempt.                                                                                      |
| Handler execution outside DB transactions | Supported     | The claim query commits before user code runs. No claim row lock or application transaction spans handler execution.                                                                   |
| At-least-once execution                   | Supported     | Crashes after claim or after an external effect can cause the handler to run again. This is the explicit delivery contract.                                                            |
| Exactly-once queue completion             | Partial       | PostgreSQL accepts completion once for the current lease/fence. This does not make external effects exactly once.                                                                      |
| Exactly-once external effects             | Not supported | Payments, email, HTTP, and similar effects require provider idempotency keys, outbox/inbox, or compensation.                                                                           |
| Cooperative lease-loss signal             | Supported     | Handler context includes an `AbortSignal` that is aborted after heartbeat rejection/error. Handler code must observe it voluntarily.                                                   |
| User-requested cancellation               | Not supported | There is no cancel API, cancellation request state, or cancellation event.                                                                                                             |
| Job timeout/deadline                      | Not supported | There is no durable execution deadline or forced timeout policy. Lease expiry only handles missing heartbeats.                                                                         |
| Graceful worker stop                      | Partial       | `Worker.stop()` prevents another loop iteration after current work ends. An external run signal stops idle polling, but does not currently propagate into the active handler's signal. |
| Process signals and lifecycle hooks       | Not supported | No built-in SIGTERM/SIGINT wiring, readiness endpoint, drain timeout, or framework lifecycle adapter exists.                                                                           |

## Retry and failure features

| Feature                       | Status        | Current behavior and limits                                                                          |
| ----------------------------- | ------------- | ---------------------------------------------------------------------------------------------------- |
| Maximum attempts              | Supported     | Each job stores `max_attempts` from 1 to 100. The first claim counts as attempt 1.                   |
| Immediate retry               | Supported     | A failed or expired attempt can insert the next attempt directly into `ready_job`.                   |
| Delayed retry                 | Supported     | Positive retry delay places the next attempt in `scheduled_job`.                                     |
| Attempt-dependent retry delay | Supported     | `WorkerOptions.retryDelayMs` may be a function of the current one-based attempt.                     |
| Default exponential backoff   | Not supported | The default delay is zero. No built-in exponential policy, cap, or jitter exists.                    |
| Terminal failure state        | Supported     | A job enters `failed` when its attempt budget is exhausted.                                          |
| Normalized errors             | Supported     | JavaScript errors are stored as JSON name/message/stack envelopes; non-Error throws are stringified. |
| Dedicated dead-letter queue   | Not supported | Terminal failures remain in `job_current`; there is no separate DLQ projection or queue policy.      |
| Redrive                       | Not supported | Failed jobs cannot be moved back to ready through a supported API.                                   |
| Retry by operator             | Not supported | There is no administrative retry action or audit record.                                             |

## Scheduling and workflow features

| Feature                             | Status        | Current behavior and limits                                                                                                   |
| ----------------------------------- | ------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| One-time future scheduling          | Supported     | `runAt` schedules one job attempt for a future timestamp.                                                                     |
| Scheduler process                   | Partial       | Every worker runs bounded promotion before claim. There is no dedicated scheduler role, leadership protocol, or drift metric. |
| Cron/recurring schedules            | Not supported | No cron parser, recurring schedule table, backfill, or missed-run policy exists.                                              |
| Dependencies                        | Not supported | Jobs cannot wait on other job outcomes.                                                                                       |
| Workflows/DAGs                      | Not supported | No workflow identity, dependency graph, replay, versioning, or orchestration API exists.                                      |
| Durable sleep                       | Not supported | There is no workflow timer primitive beyond scheduling a separate job attempt.                                                |
| Signals/events to running workflows | Not supported | No durable signal or message primitive exists.                                                                                |
| Child jobs/result handles           | Not supported | No parent-child relationship or durable child result wait exists.                                                             |
| Progress reporting                  | Not supported | No progress field, progress event API, or heartbeat payload exists.                                                           |

## History and retention features

| Feature                                | Status        | Current behavior and limits                                                                                                        |
| -------------------------------------- | ------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Append-only lifecycle events           | Supported     | Enqueue, promotion, claim, retry, expiry, success, and failure append `job_event` rows.                                            |
| Immutable attempt history              | Supported     | Success, retry, terminal failure, and lease expiry close one immutable `attempt_history` row.                                      |
| Event details                          | Supported     | Event-specific JSON metadata includes fences, worker IDs, timing, next state/attempt, and errors where relevant.                   |
| Monthly time partitions                | Supported     | Event and attempt history are range-partitioned by `occurred_at`; current and next month partitions are created at schema install. |
| Default history partitions             | Supported     | Default partitions prevent an insert failure when an explicit month partition is missing.                                          |
| Manual partition creation              | Supported     | `create_history_partitions_v1(month)` creates event and attempt partitions for one month.                                          |
| Manual bulk partition retirement       | Supported     | `retire_history_month_v1(month)` drops both partitions for a completed month and rejects current/future months.                    |
| Automatic partition maintenance        | Not supported | No scheduler pre-creates future partitions or checks rows trapped in defaults.                                                     |
| Automatic retention policy             | Not supported | No configured age, archival step, detach phase, or scheduled drop exists.                                                          |
| Job definition/current-state retention | Not supported | Terminal `job` and `job_current` rows are not automatically archived or deleted.                                                   |
| History compaction/rollups             | Not supported | No aggregate statistics or long-term compacted history tables exist.                                                               |

## Query, diagnostics, and observability features

| Feature                          | Status        | Current behavior and limits                                                                                                               |
| -------------------------------- | ------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Current job lookup               | Supported     | `Queue.getJob(id)` joins immutable identity with `job_current`.                                                                           |
| Durable result lookup            | Supported     | Successful JSON results are available through the current snapshot. Result validation and size limits are not included.                   |
| Queue depth diagnostics          | Supported     | Health reports ready, scheduled, active, expired, and current-state counts.                                                               |
| Oldest ready age                 | Supported     | Health reports milliseconds since the oldest attempt entered `ready_job`.                                                                 |
| Relation storage diagnostics     | Supported     | Health reports total/table/index bytes per Ironshift relation.                                                                            |
| PostgreSQL churn diagnostics     | Supported     | Health reports live/dead tuple estimates, modifications since analyze, HOT ratio, and vacuum timestamps.                                  |
| Transaction/lock diagnostics     | Supported     | Health reports oldest other transaction age and current lock-wait count.                                                                  |
| Notification queue usage         | Supported     | Health reports PostgreSQL's global async notification queue usage fraction.                                                               |
| Machine-readable health output   | Supported     | The health CLI emits JSON and exits with code 2 when expired leases exist.                                                                |
| Consistent health snapshot       | Not supported | Health subqueries execute concurrently and can observe slightly different instants.                                                       |
| `LISTEN/NOTIFY` wake-up listener | Partial       | SQL emits notifications after ready-producing transitions, but the worker does not listen; indexed polling is the only runtime wake path. |
| OpenTelemetry traces             | Not supported | No producer/consumer spans, trace propagation, metrics, or log correlation package exists.                                                |
| Time-series metrics/exporter     | Not supported | Health is point-in-time JSON only; no Prometheus, OTLP, or persistent metric rollups exist.                                               |
| Dashboard/admin UI               | Not supported | No web UI, job browser, charts, or administrative actions exist.                                                                          |
| Payload redaction                | Not supported | Payloads, results, and errors are returned as stored.                                                                                     |
| RBAC/authentication/CSRF         | Not supported | There is no administrative HTTP surface to secure yet.                                                                                    |
| Administrative audit log         | Not supported | Lifecycle events exist, but there are no operator actions or operator identity records.                                                   |

## Database and integration features

| Feature                                   | Status        | Current behavior and limits                                                                                                                    |
| ----------------------------------------- | ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| PostgreSQL as the only durable dependency | Supported     | Queue identity, dispatch, leases, and history live in PostgreSQL.                                                                              |
| PostgreSQL 15+ development target         | Partial       | The schema is designed for PostgreSQL 15+, but the current validation ran on PostgreSQL 18 and no version matrix exists.                       |
| Canonical schema installation             | Supported     | `sql/schema.sql` creates the validation schema and versioned transition functions.                                                             |
| Guarded test database reset               | Supported     | `pnpm db:reset` requires an explicit URL, `_test` database suffix, confirmation, and localhost unless explicitly overridden.                   |
| Incremental production migrations         | Not supported | Development recreates the database after schema changes. There is no upgrade/downgrade migration chain.                                        |
| `pg` Pool and PoolClient                  | Supported     | The TypeScript client uses a minimal `Queryable` compatible with node-postgres pools and transaction clients.                                  |
| ORM transaction adapters                  | Not supported | No Prisma, Drizzle, Kysely, Knex, or Sequelize package exists. A compatible raw query handle may work but is not a supported adapter.          |
| Framework lifecycle adapters              | Not supported | No NestJS, Fastify, Express, Next.js, or other framework package exists.                                                                       |
| Other language clients                    | Not supported | SQL functions are callable directly, but no stable cross-language protocol or maintained client exists.                                        |
| PgBouncer compatibility contract          | Not supported | Transaction/session pooling modes have not been validated. Polling avoids a listener dependency, but no formal compatibility guarantee exists. |
| Read-replica operation                    | Not supported | Claims and transitions require the primary. Replica reads, lag behavior, and failover are not designed or tested.                              |
| Serverless worker support                 | Not supported | Long-running worker lifecycle and connection behavior have not been adapted or validated for serverless platforms.                             |
| PostgreSQL-compatible databases           | Not supported | CockroachDB, YugabyteDB, Aurora DSQL, and other compatibility layers have not been tested.                                                     |
| Payload encryption/compression            | Not supported | JSON is stored directly in PostgreSQL. Applications must encrypt or encode before enqueue if required.                                         |
| Tenant isolation                          | Not supported | There is no tenant column, row-level security policy, fairness rule, or tenant-scoped API.                                                     |

## Benchmark and validation tooling

| Feature                             | Status        | Current behavior and limits                                                                                                                         |
| ----------------------------------- | ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Conventional mutable-table baseline | Supported     | The benchmark runs a simple mutable job table success path and retains terminal rows between rounds.                                                |
| Hybrid projection benchmark         | Supported     | The benchmark bulk-enqueues then sequentially claims/completes hybrid jobs while retaining history across rounds.                                   |
| Throughput measurement              | Supported     | Reports end-to-end completed jobs per second per design/round.                                                                                      |
| Claim latency percentiles           | Supported     | Reports nearest-rank p50, p95, and p99 from client-observed claim calls. Raw samples are not retained.                                              |
| WAL measurement                     | Supported     | Reports WAL location difference per round. Other cluster writes can contaminate it.                                                                 |
| Relation/dead tuple measurement     | Supported     | Reports total relation bytes and estimated dead tuples after each round.                                                                            |
| Executable claim plans              | Supported     | Captures `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` against a populated ready set.                                                                   |
| JSON report files                   | Supported     | `--output` writes the complete report while stdout also receives JSON.                                                                              |
| Benchmark CLI help                  | Supported     | `pnpm benchmark -- --help` documents current options.                                                                                               |
| Semantics-equivalent comparison     | Not supported | The conventional baseline does not yet implement equivalent lease, retry, recovery, and history behavior. Absolute cross-design claims are invalid. |
| Concurrent-worker benchmark         | Not supported | The current workload is sequential and does not measure contention scaling.                                                                         |
| Future-schedule benchmark           | Not supported | No large delayed-backlog/promotion scenario exists.                                                                                                 |
| Heartbeat benchmark                 | Not supported | No frequent-heartbeat workload exists.                                                                                                              |
| Held cleanup horizon benchmark      | Not supported | No held transaction or replication-slot scenario exists.                                                                                            |
| Dashboard-load isolation benchmark  | Not supported | No concurrent analytical/health query workload exists.                                                                                              |
| Partition-retirement benchmark      | Not supported | Functions exist, but detach/drop time and lock impact are not measured.                                                                             |
| PgQue reference benchmark           | Not supported | The external event-stream reference is not integrated.                                                                                              |
| 100-million-transition evidence run | Not supported | The harness can be scaled manually, but no committed result or automated long-run suite satisfies the viability gate.                               |

## Testing and quality tooling

| Feature                              | Status        | Current behavior and limits                                                                                                                                                                        |
| ------------------------------------ | ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Live PostgreSQL integration tests    | Supported     | The suite validates transactions, scheduling, exclusive claims, fencing, heartbeat, retries, terminal failure, recovery, worker execution, all crash failpoints, health, and partition retirement. |
| Deterministic crash failpoints       | Supported     | Tests can crash at `afterClaim`, `beforeHandler`, `afterHandler`, `beforeComplete`, and `afterComplete`.                                                                                           |
| Fence-corruption rollback tests      | Supported     | Tests prove retry and recovery roll back if lease and current projection generations disagree.                                                                                                     |
| OXC formatting and linting           | Supported     | `pnpm format`, `format:check`, `lint`, and `lint:fix` use Oxfmt and Oxlint.                                                                                                                        |
| TypeScript strict checking           | Supported     | `pnpm typecheck` uses strict TypeScript configuration.                                                                                                                                             |
| Full local check command             | Supported     | `pnpm check` runs format check, lint, typecheck, and tests.                                                                                                                                        |
| CI workflow                          | Not supported | No hosted CI configuration is committed.                                                                                                                                                           |
| Multi-PostgreSQL-version matrix      | Not supported | Tests currently run against the developer's host PostgreSQL only.                                                                                                                                  |
| Fault injection below the worker API | Not supported | There is no network proxy, PostgreSQL process kill, disk-full, WAL, or failover harness.                                                                                                           |

## Production-readiness summary

Ironshift currently supports the narrow correctness core needed to validate the hybrid storage model. It does **not** yet support the feature breadth, schema evolution, security, operational automation, compatibility testing, or sustained evidence required for production adoption.

The recommended next work remains evidence, not breadth: make benchmark semantics equivalent, add the missing stress scenarios, run sustained churn experiments, and validate the design with real workload shapes before implementing product features from the unsupported list.
