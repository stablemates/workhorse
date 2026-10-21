# ADR 0071: Give every worker a pool and a dedicated heartbeat connection

- **Status:** Accepted
- **Date:** 2026-09-18
- **Related:** SM-808, SM-825, SM-804, SM-827,
  [ADR 0070](0070-publish-the-verified-sqlalchemy-transaction-accessor.md)
- **Amended:** 2026-09-19 (SM-827): Kysely and Prisma take the pool as an adapter option, not as a
  `createWorker` argument.
- **Amended:** 2026-09-30 (SM-1059): Python and Rust workers each take their own heartbeat
  connection. The section on the shared heartbeat connection records the exception. Superseded by
  the 2026-10-21 amendment.
- **Amended:** 2026-10-21 (SM-1565): Every SDK shares one listener connection and one heartbeat
  connection for each pool identity. The amendment at the end of this record states the rules, the
  measured envelope, and the acceptance thresholds.

## Context

A worker renews each task's lease with heartbeats. A heartbeat that waits behind busy handlers
lets every lease lapse at once. Peers then reclaim the tasks and run their handlers a second time.

On 2026-09-18 the three SDKs disagreed about where heartbeats run:

- The TypeScript worker reserves one heartbeat connection per pool (PR #121). It needs `connect()`
  and a known capacity of at least 3. Otherwise it silently heartbeats through the shared queryable.
- The Python worker takes one autocommit connection, not a pool. It opens a dedicated heartbeat
  connection only through the optional `heartbeat_connection_factory` (SM-804). Without the
  factory, heartbeats silently share the worker connection.
- The Go worker heartbeats through its `pgxpool` pool. Its only dedicated connection is the
  listener.

A silent fallback hides the risk from the one person who can remove it. Python cannot remove it
alone: psycopg's connection info omits the password, so the worker cannot open a second connection
from the first one.

The ORM adapters add a second inconsistency. Drizzle finds its node-postgres pool through
`$client`. Prisma, TypeORM, and Kysely take an optional `notificationPool`, named for the listener,
which PR #121 also used for heartbeats.

Workhorse is a public beta with no production installation, so none of this needs a transition
release.

## Decision

### Every worker takes a pool

A worker receives a connection pool in all three SDKs. It takes its dedicated connections from that
pool and runs every other statement on a connection it borrows for that one statement.

- **TypeScript:** `Queue` over a node-postgres `Pool`, as today.
- **Python:** `Worker` takes a `psycopg_pool.ConnectionPool`. `AsyncWorker.from_psycopg` takes a
  `psycopg_pool.AsyncConnectionPool`, and `AsyncWorker.from_asyncpg` takes an `asyncpg.Pool`.
  `heartbeat_connection_factory` and `notification_connection_factory` are removed.
- **Go:** `NewWorker` takes a `*pgxpool.Pool`, as today.

`Queue` keeps taking a connection or transaction, so an enqueue can join the caller's transaction.
ADR 0070 depends on that, and this decision does not change it.

### Each pool lends one dedicated heartbeat connection

Every worker on one pool shares one heartbeat connection, the way workers share the listener. This
supersedes the "one extra connection per worker" wording in SM-808's first decision comment.
PR #121 found that a per-worker reservation deadlocks several workers on a small pool.

The 2026-10-21 amendment supersedes the next paragraph, which the 2026-09-30 amendment added. The
paragraph stays as the record of that amendment.

TypeScript, Go, and Ruby workers share the connection this way. Python and Rust workers do not. A
Python worker takes its own heartbeat connection and its own listener connection from its pool. A
Rust worker takes its own heartbeat connection from its pool and opens its listener outside the
pool. Each such worker therefore adds its own connections to the budget. The minimum pool of 3
still applies to every worker that reserves one.

Each heartbeat round on that connection is bounded by the heartbeat interval. A round that exceeds
the bound, or whose statement fails, destroys the connection. The next round takes a fresh one
from the pool. The connection holds no session state, so it works behind a transaction-mode
pooler.

### A worker that cannot reserve refuses to start

A worker whose pool cannot lend the heartbeat connection fails at construction. The pool must have
a known capacity of at least 3: the listener, the heartbeat connection, and one statement. The
error names the pool size it found, the size it needs, and the opt-out.

The opt-out is one contract name, cased per language: `sharedHeartbeats` in TypeScript,
`shared_heartbeats` in Python, and `SharedHeartbeats` in Go. With it set, heartbeat rounds borrow
from the shared pool like any other statement. Small pools and single connections then run as they
did before this decision.

A TypeScript `WorkerQueueApi` that is not a Workhorse `Queue` is exempt. It chooses its own
transport, so the worker has no pool to check.

### Failed rounds retry, and a watchdog bounds lease loss

All three SDKs adopt the rules the TypeScript worker already follows:

- A heartbeat round that throws leaves every task running. The next round retries.
- Each attempt keeps a local lease watchdog. It measures from the moment the claim or heartbeat
  request was sent. After one lease without an accepted renewal, it submits `lease_expired`, stops
  the heartbeat, and aborts the handler. Settlement records `lease_lost` without calling `fail_v1`.

### The listener stays best-effort, but never silent

The listener is exempt from the refusal. Polling remains the correctness mechanism, so a missing
listener costs latency, not correctness. Every SDK logs one warning when a worker starts without a
listener. Go already does. TypeScript and Python add the warning.

### The Python worker borrows per statement

The Python worker runs every statement through a single-statement `rows()` call on an autocommit
connection. No worker path uses a transaction or session state, except `LISTEN` on the listener
connection. The pooled executor therefore borrows a connection for one statement and returns it
immediately.

Claims, settlement, checkpoints, progress, sleeps, waits, and child runs all use that executor. A
handler never holds a pooled connection while its own code runs. A durability call waits for the
pool only while other statements are running, never on another handler's code. Dispatch cannot
starve, because every borrow lasts one statement.

`concurrency` does not raise the floor of 3. A pool of `concurrency + 3` lets the dispatcher and
every handler run a statement at the same time. A smaller pool queues statements briefly. A borrow
that exceeds the pool's own checkout timeout raises inside the call that made it. A handler's
durability call then fails its attempt like any other handler error.

This replaces the current model, in which one connection serializes every statement for up to 100
handler threads.

### `notificationPool` is removed

The option named only the listener, and two adapters no longer need it:

- Drizzle keeps finding its pool through `$client`.
- TypeORM finds its pool through `dataSource.driver.master`, the node-postgres `Pool` its
  `PostgresDriver` creates. An integration test pins that accessor, as ADR 0070 pins SQLAlchemy's.
- Kysely keeps its pool in a private field, and Prisma's engine has no node-postgres pool. Both
  take one through the adapter option `pool`.

The first draft of this decision passed that pool to `createWorker({ pool })` instead. A
`defineWorkerProcess` configuration builds its pool inside `adapter()` and closes it through the
adapter's `close` hook. It passes static worker options to `createWorker`, so the pool could reach
the worker only from module scope. The adapter owns the pool's lifetime, so the adapter takes it.

The internal `notificationConnectionIdentity` and `notificationConnectionCapacity` fields are
replaced by one internal reference to the pool. The pool's identity and `options.max` supply both
values.

## Consequences

Every default setup either reserves a heartbeat connection or fails at start with the fix in the
message. The risk can no longer be present without the operator knowing.

The TypeScript quickstart, Drizzle, TypeORM, and Go examples do not change. Python setups change
from a connection to a pool, and `psycopg_pool` becomes a dependency of the Python worker. Kysely
and Prisma adapters need a node-postgres pool passed as `pool`.

The Python worker gains parallel statements. A pool sized for `concurrency` lets handlers
checkpoint while others run, which one serialized connection could not do.

Every pool gives up one connection to heartbeats. Operators budget it on top of the listener and
the handlers, as guide 390 states.

Test fixtures change in every SDK. Fixtures that build a worker on a small pool or a single
connection must either grow the pool or set the opt-out. The per-SDK tickets carry that work.

## Alternatives considered

- **Keep the silent fallback and document it.** Rejected: the risk stays invisible where it matters.
- **Require a dedicated connection with no opt-out.** Rejected: small pools, single connections, and
  test fixtures would have no way to run.
- **Derive a Python heartbeat connection from the worker's connection.** Rejected: psycopg's
  connection info omits the password.
- **Keep per-connection Python factories and make them mandatory.** Rejected: each dedicated
  connection needs its own argument, and the Python worker would stay serialized on one connection.
- **Rename `notificationPool` on every adapter.** Rejected: Drizzle and TypeORM find their pool
  without any option, so only Kysely and Prisma take one.
- **Pass the pool to `createWorker({ pool })`.** Rejected in the amendment: a worker process
  configuration could then reach the pool only from module scope.

## Amendment: every SDK shares one listener and one heartbeat connection per pool (2026-10-21)

A worker holds two connections that handlers cannot use: the listener connection and the heartbeat
connection. The 2026-09-30 amendment (SM-1059) let each Python and Rust worker take its own
heartbeat connection. It gave no engineering reason. The JVM worker also takes one listener
connection for each worker (ADR 0103). SM-1565 measured the effect of these exceptions. This
amendment supersedes the 2026-09-30 amendment and states one rule for every SDK.

**Example.** Two Python workers start on a psycopg pool of 4.

1. Each worker takes one listener connection and one heartbeat connection from the pool.
2. The two workers hold all 4 connections.
3. A claim waits for a connection. After 30 s, psycopg raises `PoolTimeout`, and the worker stops.

SM-1004 fixed the same defect in Go and Ruby. The rules below apply to every SDK. These issues apply
them:

| SDK        | Issue   |
| ---------- | ------- |
| JVM        | SM-1569 |
| Python     | SM-1571 |
| Rust       | SM-1572 |
| TypeScript | SM-1575 |
| Go         | SM-1576 |
| Ruby       | SM-1577 |

Until each of those issues ships, its SDK keeps the budget and the startup behavior that
`docs/architecture/overview.md` states.

### The rules

In these rules, I is the heartbeat interval. L is the lease duration. B is the round bound, default
7.5 s. W is the worker count. C is the task count per worker. A pool identity is the key that an SDK
uses to find the workers that share one pool. The rules are the final rule set of the SM-1565 design
decision, word for word.

1. Each pool identity has one shared listener connection and one shared heartbeat connection. The
   Rust listener connection sits outside the pool. Both scheduler designs stay allowed: per-worker
   rounds, or one coordinator for all workers.
2. The measured envelope: one shared listener connection and one shared heartbeat connection
   sustained 64 workers × 25 leases per worker, on a pool of 20, on one lightly loaded development
   machine, in TypeScript, Go, and Ruby. The JVM baseline at 64 workers measured pool starvation
   from unbounded acquisition, not scheduler capacity. The JVM capacity statement waits for a
   passing post-fix 64 × 25 run. Behavior beyond this envelope is not measured. This is not a
   production capacity claim.
3. The startup budget is max(I, 5 s). The 5 s floor is a design choice. Within this budget, in
   order: the worker reserves the heartbeat connection; then the worker borrows one ordinary
   connection, runs the compatibility query, and returns that connection at once. If either step
   fails, the worker refuses to start, and the error names the pool, the budget, and the opt-out.
   The listener stays best effort: a failure logs one warning, the worker polls, and a background
   retry continues.
4. Where the pool reports a maximum size, a pool identity needs at least 3 connections, and a
   worker on a smaller pool refuses to start unless the opt-out is set. Where the size is unknown,
   the readiness check in rule 3 is the check. The readiness check proves current headroom only. It
   does not prove future availability or the total budget of one physical pool across wrappers.
5. A reserved-connection acquisition at runtime completes inside the round bound B, default 7.5 s.
   The ADR 0105 busy-retry deadlines stay. No reserved acquisition uses the pool's own timeout as
   its bound.
6. A worker claims no task, ordinary or fused, while its pool identity holds no usable heartbeat
   reservation. A failed renewal or a temporary round lock is not loss of readiness. A fused
   completion runs with a zero claim limit while the gate is closed. Replacement acquisition starts
   at once, retries with backoff capped at I, and runs also when no worker holds an active task.
   When the replacement is ready, dispatch wakes at once.
7. A connection that arrives after its wait timed out or was cancelled gets one settled owner,
   which adopts or disposes of it. Repeated timeouts do not accumulate pending acquisitions or
   helper threads. A stopping worker releases only its own subscription. A shared resource closes
   when its last user releases it.
8. The total stop time is the shutdown grace plus the SDK's documented unwind window. Every wait on
   the stop path carries a deadline derived from the grace.
9. Identity. Python: the pool object, per domain (psycopg sync, psycopg async, asyncpg), in a weak
   registry, with the event-loop refusal. JVM: the exact `DataSource` reference, in a registry with
   identity semantics; a registry value must not retain the pool; a wrapper is its own domain, with
   the documented four-connection note. Rust: the manager address, with the recorded deadpool
   dependency, a weak registry value, generation-tagged cleanup, and the identity and lifetime tests
   in part (b) of this comment.
10. A startup reservation failure ends a run that previously continued. The ADR amendment and each
    SDK changelog state this behavior change.
11. The acceptance thresholds are the healthy, refill, fault, driver, and cell rules in part (d) of
    this comment. SM-1568 records them with this rule set.

In rules 9 and 11, "this comment" is the comment "Design decision, amended (claude-fable-5-1, high)"
on SM-1565. The section "The Rust pool identity depends on deadpool" records part (b). The section
"Acceptance thresholds" records part (d).

### Scope of rules 3 to 6

Rules 3 to 6 are the reservation, readiness, and claim-gate rules. They apply to workers that use
the dedicated heartbeat connection. A worker with the opt-out has no reserved heartbeat connection,
and rules 3 to 6 do not apply to it. The opt-out is `sharedHeartbeats` in TypeScript,
`SharedHeartbeats` in Go, `shared_heartbeats` in Python, Rust, and Ruby, and
`sharedHeartbeats(true)` on the JVM. With it set, heartbeat rounds borrow a connection for each
statement, as the section "A worker that cannot reserve refuses to start" states. A TypeScript
`WorkerQueueApi` that is not a Workhorse `Queue` stays exempt, as that section also states.

### Why the rules have this form

**Rule 1.** Each SDK keeps its scheduler. TypeScript and Go send one round for each worker, and the
rounds queue on the shared connection. Ruby and the JVM use one coordinator for all workers on the
pool identity. This record constrains the connection count, the round bound, the retry rules, and
the acquisition bounds. It does not constrain the scheduler. Python and Rust use the scheduler that
fits their runtime. The Rust listener connection stays outside the pool, because a pooled
tokio-postgres connection cannot deliver notifications. If two Rust workers on one pool identity
give different `listen_config` values, the second worker refuses to start. `sharedHeartbeats: true`
stays a workaround for small pools. It is not a production target.

**Rule 3.** Startup owns no lease, so I alone is too short at small intervals. The runtime round
bound B does not apply to startup. A documented startup-timeout option can come later. It is not in
this scope.

**Rule 4.** Two reserved acquisitions cannot prove a floor of three. A pool with a maximum size of 2
gives both reserved connections and then leaves no connection for registration or claims. The
ordinary borrow in rule 3 shows that one more connection is free now. Rust keeps the static floor of
3 from ADR 0074, although its listener connection is outside the pool. The docs recommend a pool of
3 plus the number of concurrent statements. No SDK checks this recommendation.

**Rule 5.** A pool timeout can be longer than the lease. In the JVM baseline, the heartbeat waited
for a pool connection before its round bound applied. The pool timeout was 30 s, and the lease was
3 s.

**Rule 6.** One missing heartbeat connection pauses new claims for every worker on the pool
identity. Existing attempts continue until their lease watchdogs end. This pause stops a worker from
taking leases that it cannot renew. Claims do not wait for the next regular round after the
replacement is ready.

**Rule 8.** A process that cannot stop also cannot drain. An unbounded stop path thus turns a full
pool into an operational incident. On the stop path, every asyncpg `acquire()` call of the worker
gets an explicit timeout. A psycopg acquisition gets a deadline below the grace. The Rust startup
compatibility wait observes the shutdown signal and a timeout.

### The pool identity of each SDK

| SDK        | Pool identity                                                                                    |
| ---------- | ------------------------------------------------------------------------------------------------ |
| TypeScript | The node-postgres `Pool` object.                                                                 |
| Go         | The `*pgxpool.Pool` object.                                                                      |
| Ruby       | The pool object.                                                                                 |
| Python     | The pool object, in a weak registry, in each of three domains. The domains do not share.         |
| Rust       | The address of the reference that `Pool::manager()` returns.                                     |
| JVM        | The exact `DataSource` object, by reference identity. The registry never compares with `equals`. |

**Python.** The three domains are the psycopg `ConnectionPool`, the psycopg `AsyncConnectionPool`,
and the `asyncpg.Pool`. The shared connections of the sync domain must be thread safe. In an async
domain, the shared listener and heartbeat run on the event loop of the pool. If a worker reaches
the pool from a different event loop, the worker refuses to start. A weak registry does not extend
the life of the pool. Object identity is also the rule of the three SDKs that already share.

**JVM.** The worker does not unwrap a `DataSource`. A wrapper object is its own pool identity, with
its own budget of two reserved connections. The Spring Boot starter gives the same `DataSource`
bean reference to every worker and queue that it builds. One worker on a wrapper and one worker on
its delegate thus hold four reserved connections on one physical pool. The docs must state this.
An unwrap cannot be complete, because wrappers can nest. A wrong merge of two pool identities is
worse than a documented extra budget.

### The Rust pool identity depends on deadpool

The Rust key is the address of the reference that `Pool::manager()` returns. This key depends on a
property of deadpool that its public signature does not promise. deadpool 0.13 stores `PoolInner`
in an `Arc`, clones share that allocation, and `manager()` returns a reference into it. Thus clones
of one pool share, and two pools that a caller builds separately for one database do not share.

These controls apply to the key:

- The ADR and a code comment record the dependency.
- A unit test asserts the property itself: two clones of one pool give one address, and two
  separate pools give two addresses. A deadpool upgrade that breaks the property fails this test,
  not production.
- The registry value holds a weak pool reference, so a registry entry does not keep an unused pool
  alive. A running worker owns a pool clone, and that clone keeps the address valid while the entry
  is in use.
- Cleanup removes the entry before the last retained clone drops. Each entry carries a generation
  tag, so an old cleanup cannot delete a new entry.
- Lifetime tests cover: failed startup, cancellation, a dropped run, the last subscription release,
  rapid pool recreation at one address, and repeated run and stop cycles.

An explicit handle was rejected. A handle needs a default for `Worker::new(pool, options)`. A
fallback to the address key keeps the dependency in the default path, so the handle removes no
risk. A private default handle removes sharing from plain construction, so the defect stays for
every existing caller. An explicit optional handle can come later without a breaking change, if a
deadpool version removes the property.

### A startup reservation failure now ends a run

Rule 10 changes existing behavior. Before this amendment, some SDKs ignored a failed startup
reservation of the heartbeat connection and continued. Go and Rust tried the reservation for I and
ignored a failure. TypeScript started the reservation without waiting for it. Ruby and the JVM
acquired the heartbeat connection only after a task registration.

After this amendment, a worker that cannot reserve its heartbeat connection within the startup
budget refuses to start, and the run ends. A transient reservation failure can thus end a run that
earlier continued. Each SDK issue in the table above states this change in its changelog entry.

### Evidence

SM-1566 added the internal benchmark `pnpm benchmark:connection-budget`. It runs one probe process
for each SDK and reads the connection count, the lease renewal age, and the lease loss from the
database. The baseline ran on `main` at commit 27453404, before any fix, with one SDK at a time.
The recorded maximum of the 1-minute load was 1.55. SM-1565 records the results, a validation of
the data, and the design decision.

In the table, W × C is the number of workers and the concurrency of each worker. The pool has 20
connections. I is 1 s, and L is 3 s.

| SDK                  | Baseline result                                                                             |
| -------------------- | ------------------------------------------------------------------------------------------- |
| TypeScript, Go, Ruby | At 64 × 25, all 1600 leases stay live. No lease loss, no expired active task.               |
| Python, 3 domains    | One listener connection for each worker fills the pool at 16 workers. Claims stop.          |
| Rust                 | One heartbeat connection for each worker fills the pool at 64 workers. No claim starts.     |
| JVM                  | One listener connection for each worker fills the pool. Leases expire, and tasks run again. |

Per-worker rounds (TypeScript, Go) and one coordinator for all workers (Ruby) passed at the
measured envelope with similar margins. The JVM baseline at 64 workers measured pool starvation
from unbounded acquisition, not scheduler capacity. The JVM capacity statement waits for a passing
post-fix 64 × 25 run. The data gives no reason to force one scheduler norm.

The JVM result is a correctness defect, not a capacity limit. Peers claimed the expired tasks
again, so a task can run twice.

In the TypeScript, Go, and Ruby cells at 64 × 25, the sampled minimum lease margin was about 2 s. A
rerun did not repeat the two outliers of the baseline. The margin is a sampled value. It is not
spare throughput of the connection, and it does not prove a tolerance for 2 s of failure.

The benchmark did not measure these conditions:

- Network latency between the worker and the database.
- A database under load.
- More than 64 workers on one pool identity, or more than 25 leases for each worker.
- PgBouncer in transaction mode, or another pooler.
- Different heartbeat intervals on one pool identity.
- Several processes on one database.
- Replacement of a heartbeat connection after a failure.
- Sustained completion and refill, and database statements from handlers.
- Tasks of the fast tier.
- The shared Python and Rust implementations, which do not exist yet.
- The JVM scheduler at 64 workers with a shared listener connection.
- The full latency of a heartbeat round, and the queue on the shared connection. The database
  sample every 250 ms can miss a short peak.

A production capacity claim stays out of the scope of SM-1565.

### Acceptance thresholds

SM-1574 runs the benchmark again on every SDK after the fixes. SM-1570 adds the completion-and-refill
cells and one fault cell. These thresholds are part (d) of the SM-1565 design decision, word for
word.

The thresholds split into healthy held-task cells, healthy completion-and-refill cells, and fault
cells. The age and margin thresholds are test criteria for healthy cells. They are not runtime
rules: at runtime, ADR 0071 permits retries until one lease ends, and ADR 0105 permits busy rounds
until that end.

A healthy held-task cell passes only when all of these hold:

1. Final live leases equal W × C. Zero recorded lease losses. Zero expired active tasks in every
   sample.
2. The maximum sampled renewal age is below 2 × I. The minimum sampled lease margin is above I.
3. Reserved backends per pool identity: at most one listener and one heartbeat connection. The Rust
   listener session sits outside the pool. Pool occupancy counts and lifecycle tests corroborate the
   observed roles.
4. Zero worker errors and zero sample errors. The probe exits on SIGTERM within the driver deadline.
   A SIGKILL fails the cell.

A healthy completion-and-refill cell passes only when all of these hold:

1. Every expected task completes exactly once, with one attempt. Zero active tasks and zero ready
   tasks remain at the end. Zero recorded lease losses and zero expired active tasks.
2. The probe sets its polling interval to 1 s. While the heartbeat reservation is ready, ready tasks
   exist, and a worker has a free slot, no claim gap exceeds 5 s. Pauses, policy limits, and
   intentionally held claims do not count toward a gap.
3. Rules 3 and 4 of the held-task cell also apply.

A fault cell (forced heartbeat loss or an unreachable database) does not use the healthy
thresholds. It passes only when all of these hold:

1. No claim of any kind during the outage.
2. Lease loss stays inside the watchdog bound that ADR 0071 and ADR 0105 state.
3. After the database is reachable, the first new claim occurs within 2 × I. The claim does not wait
   for the next regular round slot.
4. No reserved connection remains open after recovery beyond the one listener and one heartbeat
   connection.

Driver deadline: the driver sets each probe's shutdown grace explicitly. The driver's kill deadline
is that grace, plus the SDK's documented unwind window, plus 5 s.

Cells: keep 64 × 1 and 64 × 25 for every SDK, the Python and Rust boundary cells (2 × 1 on a pool of
4, 16 × 1, 16 × 25), and the small-pool refill cells. A failed cell can rerun once, with the anomaly
recorded. A second failure fails the acceptance.

### Consequences of this amendment

- An operator budgets two reserved connections for each pool identity, not for each worker. The
  Rust listener connection is outside the pool.
- On the JVM, each `DataSource` wrapper adds its own two reserved connections.
- No reserved acquisition waits for the timeout of the pool.
- A worker without a usable heartbeat reservation claims no task, so it cannot take a lease that it
  cannot renew.
- A startup reservation failure ends the run, as rule 10 states.
- Each issue in the table above changes the connection budget, the startup, or the shutdown of one
  SDK. Each issue ships with its own changelog entry.

### Alternatives considered in this amendment

- **Keep one connection of each kind for each Python and Rust worker.** Rejected: the baseline
  shows that several workers on a small pool hold every connection, and claims stop.
- **Require one heartbeat scheduler.** Rejected: the data gives no reason to force one scheduler
  norm.
- **Give Rust an explicit shared handle.** Rejected: no default for `Worker::new` removes the risk
  and also keeps sharing. The section on the Rust pool identity states the reasons.
- **Unwrap a JVM `DataSource` to find the physical pool.** Rejected: wrappers can nest, and a wrong
  merge of two pool identities is worse than an extra budget.
- **Check the JVM size with the two reserved acquisitions.** Rejected: a pool of 2 passes that check
  and leaves no connection for claims.
- **Use one heartbeat interval as the startup deadline.** Rejected: startup owns no lease, and I can
  be 100 ms.
- **Rely on the timeout of the pool.** Rejected: a pool timeout can be longer than the lease, as
  the JVM baseline shows.
- **Resume claims after a fixed time without a heartbeat connection.** Rejected: the worker could
  then take leases that it cannot renew.
