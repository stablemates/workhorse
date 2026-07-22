# Feature support matrix

This is the authoritative implementation snapshot for schema version 2. “Supported” means exposed through the current SQL or TypeScript contract and covered by live PostgreSQL integration tests where applicable.

## At a glance

| Supported core                                 | Partial today                          | Not supported today                            |
| ---------------------------------------------- | -------------------------------------- | ---------------------------------------------- |
| Transactional immediate/delayed batch enqueue  | One-handler-at-a-time worker instances | Priorities and enqueue idempotency             |
| FIFO `SKIP LOCKED` claims                      | Polling despite `NOTIFY` hints         | Cron, cancellation, deadlines, progress        |
| Leases, heartbeats, fencing, recovery          | Manual partition lifecycle             | Concurrency policies and rate limiting         |
| Immediate/delayed retries and terminal failure | Point-in-time health snapshot          | Dead letters, redrive, dependencies, workflows |
| Live runtime plus immutable outcomes           | Success-path comparative baseline      | UI, RBAC, OpenTelemetry, framework adapters    |
| Append-only events and attempt history         | Clean-install schema only              | Online production migration guarantees         |

## Core job and dispatch

| Feature                           | Status        | Current behavior and limits                                                                                                               |
| --------------------------------- | ------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Stable job identity               | Supported     | One immutable `job` UUID persists across attempts, events, runtime, and outcome.                                                          |
| JSON payload and named type       | Supported     | Payload and type are immutable in `job`; runtime validation and payload size policy are application concerns.                             |
| Named queues                      | Supported     | Enqueue and claim accept queue names.                                                                                                     |
| FIFO ordering                     | Supported     | Ready runtimes use a monotonic sequence. Batch-ready jobs receive sequences in input order; promotion/retry assigns a new ready sequence. |
| Immediate and delayed enqueue     | Supported     | Due jobs enter ready runtime; future jobs enter scheduled runtime.                                                                        |
| Atomic batch enqueue              | Supported     | Up to 1,000 mixed requests share one classification timestamp, return IDs in order, and roll back together.                               |
| Transactional application enqueue | Supported     | An active `Queryable`/`PoolClient` controls the transaction.                                                                              |
| Coalesced wake notifications      | Supported     | One commit-delivered notification is emitted per distinct queue gaining ready work. Polling remains authoritative.                        |
| Bounded promotion                 | Supported     | `promote_v1` uses the selective scheduled index and `FOR UPDATE SKIP LOCKED`.                                                             |
| Multi-worker claim                | Supported     | `claim_v1` locks one FIFO ready runtime and changes it to active with one state update.                                                   |
| Single mutable live row           | Supported     | Scheduled, ready, and active state are mutually exclusive shapes in `job_runtime`.                                                        |
| Selective dispatch indexes        | Supported     | Separate partial indexes cover ready, scheduled, and active-expiry access paths.                                                          |
| Priorities                        | Not supported | Ordering is FIFO only.                                                                                                                    |
| Enqueue idempotency               | Not supported | Repeating enqueue creates another identity.                                                                                               |

## Ownership, retry, and failure

| Feature                            | Status        | Current behavior and limits                                                                       |
| ---------------------------------- | ------------- | ------------------------------------------------------------------------------------------------- |
| Lease ownership                    | Supported     | Active runtime stores worker, fence, acquisition, heartbeat, and expiry.                          |
| Global fencing                     | Supported     | Each claim allocates a monotonic fence; stale generations cannot mutate a newer lifecycle.        |
| Heartbeat                          | Supported     | CAS update requires job, active state, worker, fence, and unexpired ownership.                    |
| Expiry recovery                    | Supported     | Bounded cooperative recovery locks expired active runtimes and requeues or terminally fails them. |
| Immediate/delayed retry            | Supported     | `fail_v1` increments attempt and CAS-updates the same runtime to ready or scheduled.              |
| Retry budget                       | Supported     | Exhaustion atomically removes runtime and creates failed outcome.                                 |
| Terminal success                   | Supported     | Completion atomically removes runtime and creates succeeded outcome plus attempt/event history.   |
| Terminal failure                   | Supported     | Handler exhaustion or lease exhaustion creates immutable failed outcome.                          |
| Immutable terminal materialization | Supported     | Terminal jobs occupy `job_outcome`, not dispatch indexes.                                         |
| Dead-letter queue and redrive      | Not supported | Failed outcomes are queryable but no DLQ projection or redrive API exists.                        |
| Backoff policy                     | Partial       | Caller supplies retry delay; exponential backoff and jitter are not productized.                  |

## History, reads, and observability

| Feature                            | Status        | Current behavior and limits                                                                                                                           |
| ---------------------------------- | ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Lifecycle events                   | Supported     | Every lifecycle boundary appends `job_event`.                                                                                                         |
| Closed attempt history             | Supported     | Success, terminal failure, retry, and lease expiry append immutable `attempt_history`.                                                                |
| Monthly history partitions         | Supported     | Explicit create and completed-month retirement functions remain available with default fallback partitions.                                           |
| Current/terminal lookup            | Supported     | `Queue.getJob(id)` coalesces the sole live runtime or terminal outcome into the stable `JobSnapshot` shape.                                           |
| Queue health                       | Supported     | Reports schema version 2; live and terminal state counts; runtime depths; expired active rows; oldest ready age; relation and PostgreSQL diagnostics. |
| Crash-boundary harness             | Supported     | Worker failpoints model process loss before and after handler/completion boundaries.                                                                  |
| Job/outcome retention              | Not supported | Immutable identity and terminal outcomes are not automatically archived or deleted.                                                                   |
| Consistent health snapshot         | Partial       | Diagnostics are independent read-only queries and statistics can lag.                                                                                 |
| OpenTelemetry and metrics endpoint | Not supported | Consumers must instrument calls externally.                                                                                                           |

## Runtime and product boundaries

| Feature                                     | Status        | Current behavior and limits                                                                   |
| ------------------------------------------- | ------------- | --------------------------------------------------------------------------------------------- |
| TypeScript Queue/Worker API                 | Supported     | Existing public interfaces remain stable across the architecture pivot.                       |
| Versioned SQL API                           | Supported     | Existing `_v1` function names and signatures remain stable; installed schema version is 2.    |
| Graceful worker stop                        | Supported     | Stop prevents further claims and waits for in-flight work.                                    |
| Worker concurrency                          | Partial       | One worker runs one handler at a time; scale with multiple instances.                         |
| Online v1 to v2 migration                   | Not supported | The canonical schema is clean-install only. Operators need a separately engineered migration. |
| Compatibility write views                   | Not supported | Legacy write relations are intentionally absent to avoid dual-write semantics.                |
| Exactly-once effects                        | Not supported | Delivery is at least once; applications need idempotency or outbox/inbox patterns.            |
| Cron, workflows, dependencies, cancellation | Not supported | No stable contracts exist.                                                                    |
| UI, RBAC, multi-tenancy                     | Not supported | The validation MVP exposes database and TypeScript protocols only.                            |
