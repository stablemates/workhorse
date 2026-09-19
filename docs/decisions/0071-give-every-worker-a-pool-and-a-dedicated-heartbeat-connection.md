# ADR 0071: Give every worker a pool and a dedicated heartbeat connection

- **Status:** Accepted
- **Date:** 2026-09-18
- **Related:** SM-808, SM-825, SM-804, [ADR 0070](0070-publish-the-verified-sqlalchemy-transaction-accessor.md)

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

Only workers use the dedicated connections, so the adapter option goes away:

- Drizzle keeps finding its pool through `$client`.
- TypeORM finds its pool through `dataSource.driver.master`, the node-postgres `Pool` its
  `PostgresDriver` creates. An integration test pins that accessor, as ADR 0070 pins SQLAlchemy's.
- Kysely keeps its pool in a private field, and Prisma's engine has no node-postgres pool. Both
  pass one to the worker: `createWorker({ pool })`.

The internal `notificationConnectionIdentity` and `notificationConnectionCapacity` fields are
replaced by one internal reference to the pool. The pool's identity and `options.max` supply both
values.

## Consequences

Every default setup either reserves a heartbeat connection or fails at start with the fix in the
message. The risk can no longer be present without the operator knowing.

The TypeScript quickstart, Drizzle, TypeORM, and Go examples do not change. Python setups change
from a connection to a pool, and `psycopg_pool` becomes a dependency of the Python worker. Kysely
and Prisma workers need a node-postgres pool passed to `createWorker`.

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
- **Rename `notificationPool` instead of removing it.** Rejected: the pool is a worker concern, and
  two of the four adapters can find it without any option.
