# Can I put a connection pooler in front of Workhorse?

<!-- scenario-names: shop, order.fulfill, w1, email, billing, order-42 -->

Yes. Every queue operation works through session-mode and transaction-mode pooling alike. The one
feature that needs a dedicated session is the wake-hint listener, and losing it only costs
latency: polling stays the correctness mechanism.

## What breaks under transaction pooling?

An app called `shop` reaches PostgreSQL through PgBouncer in transaction mode. Transaction pooling
hands a client a different server session for each transaction. This is what one order does.

1. **The order.** A request handler opens a transaction, inserts order `order-42`, and enqueues
   `order.fulfill` inside it. PgBouncer keeps one server session for the whole transaction. The
   commit writes the order and the task together.
2. **The claim.** A worker claims the task. That statement runs on whichever server session
   PgBouncer lends it.
3. **The heartbeat and the completion.** Later statements for the same task run on other server
   sessions. Nothing breaks, because the lease and fence token live in the task's runtime row, not
   in a session.
4. **The migration.** A deployment step migrates the schema through the same pooler. Each step is
   one script that opens and commits its own transaction, and its lock ends with that transaction.

Anything that lives on a session — a `LISTEN`, a session-level advisory lock, a `SET` — either
stops working under transaction pooling or leaks onto a server session that the next client
inherits. Workhorse uses none of those for correctness. Enqueue, claim, heartbeat, settle, schema
installation, and migration all work, because every statement is self-contained and every lock the
schema takes is transaction-scoped. A caller-owned transaction commits and rolls back queue writes
normally, so [transactional enqueue](200-transactional-enqueue.md) is unaffected.

<details>
<summary>Reference: operations under each pooler</summary>

`typescript/core/test/integration-pooling.test.ts` runs each case as a separate lane: direct, then
PgBouncer and PgCat, each with `pool_mode = session` and `pool_mode = transaction`.

| Operation                                                    | Every lane                               |
| ------------------------------------------------------------ | ---------------------------------------- |
| Enqueue, claim, settle, heartbeat, operator reads            | Works.                                   |
| Transactional enqueue inside a caller-owned transaction      | Works.                                   |
| `installSchema`, `migrateSchema`, `contractSchema`           | Works.                                   |
| Maintenance tick and every SQL `pg_(try_)advisory_xact_lock` | Works. The locks are transaction-scoped. |
| `LISTEN`/`NOTIFY` wake hints on `workhorse_tasks`            | Direct and PgBouncer session mode only.  |

**Statements.** No production code path issues `SET`, holds a cursor, or takes a session-level
advisory lock.

**Locks.** Every Workhorse advisory lock uses `pg_advisory_xact_lock`, `pg_try_advisory_xact_lock`,
or `pg_advisory_xact_lock_shared`. That includes the schema-migration lock.

**Schema operations.**

- `installSchema` sends `schema.sql` as one multi-statement simple query.
- Each migration step is one `BEGIN`…`COMMIT` script. It takes its transaction-scoped lock behind
  `SET LOCAL lock_timeout`.

More detail: [Overview: Connection poolers](../architecture/overview.md#connection-poolers).

</details>

## What does the listener need?

Suppose worker `w1` reaches PostgreSQL through PgBouncer in transaction mode.

1. **At start** the worker sends `LISTEN workhorse_tasks`. PgBouncer returns success, then releases
   the server session.
2. **A moment later** the app enqueues a task. PostgreSQL sends the notification, but no server
   session is listening for `w1`. Nothing arrives, and nothing errors.
3. **At the next fallback poll** the worker asks for work, claims the task, and runs it. The task
   ran correctly, only later than it could have.

The listener holds a dedicated connection for `LISTEN workhorse_tasks`. When a task becomes ready,
PostgreSQL sends a notification on that channel, and the worker claims at once instead of waiting
for its next poll. The pooler decides whether that notification arrives.

Session-mode PgBouncer delivers notifications normally. PgCat fails in either mode: it holds a
notification until the client sends another query, which an idle listener never does. In every
failing case the worker still reports that it is listening, and it keeps dispatching on its
fallback poll.

To keep wake hints, give the worker a pool that reaches PostgreSQL without those poolers — direct,
or session-mode PgBouncer. Drizzle and TypeORM workers use the ORM's own pool. The Prisma and
Kysely adapters take a `pool` for exactly this.

A `Queue` built on a queryable with neither `connect()` nor an attached pool has no listener. Its
worker polls and logs one warning when it starts. It also has no pool to reserve a heartbeat
connection from, so its worker needs `sharedHeartbeats`, described below.

<details>
<summary>Reference: listener behavior and polling</summary>

**Behavior by pooler**

| Pooler and mode               | Behavior                                                                                                   |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------- |
| PgBouncer session mode        | Delivers `NOTIFY` normally.                                                                                |
| PgBouncer in transaction mode | Accepts `LISTEN`, returns success, then releases the server connection. No notification is ever delivered. |
| PgCat, either pool mode       | Relays a buffered notification only with the client's next query result.                                   |

No error reaches `onNotificationError` in the failing cases. `Queue.supportsTaskNotifications()`
checks the pool's shape, not its pooling mode, so it still reports the capability.

**Pool source for the listener (TypeScript)**

| Adapter        | Pool source     |
| -------------- | --------------- |
| Drizzle        | `$client`       |
| TypeORM        | `driver.master` |
| Prisma, Kysely | `pool` option   |

**Polling-only cases (TypeScript)**

- A queryable without a pool stays polling-only.
- A pool whose capacity is 1 stays polling-only.
- When `Worker.run()` starts with no subscription, it logs `workhorse.worker.polling_only` at warn
  level once.

**Fallback poll.** A notification-capable `Worker.run()` polls every 5,000 ms by default, with ±10%
jitter. An explicit `pollMs` replaces that base.

More detail: [Operations and CLI: Polling-only cases](../architecture/operations.md#polling-only-cases).

</details>

## How do I budget connections?

Two TypeScript workers, `email` and `billing`, run in one process on one node-postgres pool.

1. **`email` starts.** It takes one pooled connection for the shared listener and one for the shared
   heartbeat connection.
2. **`billing` starts.** It joins the same listener and the same heartbeat connection. It takes no
   new connection.
3. **Both run handlers.** Claims and handlers use whatever the pool has left.

Where the listener connection comes from depends on the language. TypeScript, Go, and Ruby workers
on one pool share one listener, which holds one pooled connection however many workers subscribe.
A Python worker takes its own listener connection from the supplied pool. A Rust worker opens its
own listener connection outside the pool, from the `listen_config` it is given. When a TypeScript
or Go pool is too small to spare a connection, the worker polls instead of listening.

Behind any pooler that cannot deliver notifications, the listener connection is held without
delivering anything. That connection still counts against the pooler's client cap. For every
language except Rust, it also counts against the client pool.

The heartbeat connection follows the same split. TypeScript, Go, and Ruby workers on one pool share
one heartbeat connection. A Python worker and a Rust worker each take their own from the pool.

To size a pool for several workers, count what each language holds before handlers take anything.
Workers on one TypeScript, Go, or Ruby pool hold the listener and the heartbeat connection once,
however many workers there are. Python workers hold both once per worker. Rust workers hold one
heartbeat connection per worker inside the pool. Their listener connections sit outside the pool,
so count them against the server's or the pooler's connection limit instead.

<details>
<summary>Reference: connections each language holds</summary>

| Language   | Listener connection                                                                                                                                   | Heartbeat connection                                                         |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| TypeScript | One `TaskNotificationHub` per pool, holding one pooled connection. Skipped when `options.max` is 1 or less.                                           | One shared heartbeat connection per pool.                                    |
| Go         | One `taskNotificationHub` per `*pgxpool.Pool`. Polls instead when `MaxConns` is below 2.                                                              | One shared heartbeat connection per pool, held by `holdHeartbeatConnection`. |
| Ruby       | One `Worker::Listener.shared(pool)` per pool object, holding one pool connection.                                                                     | One `Worker::Heartbeat.dedicated(pool)` per pool object.                     |
| Python     | One per `Worker` or `AsyncWorker`, from the supplied Psycopg or asyncpg pool.                                                                         | One per `Worker` or `AsyncWorker`, from the same pool.                       |
| Rust       | One per worker, opened by `notifications::listen` from `WorkerOptions::listen_config`, outside the pool. Expected only when `max_size` is at least 2. | One per worker, from the pool.                                               |

TypeScript and Go key both shared connections by the pool object.

More detail: [Overview: Connection budgets per language](../architecture/overview.md#connection-budgets-per-language).

</details>

## Why does the heartbeat need its own connection?

A worker with concurrency 8 shares a pool with its handlers. Each handler holds a pooled connection
for a slow report query.

1. **All connections are busy.** Every pooled connection is held by a handler.
2. **A heartbeat round is due.** If the heartbeat had to borrow from the same pool, it would queue
   behind the handlers.
3. **The leases lapse.** The queued heartbeat does not run in time, so every lease lapses at once.
   The worker signals each handler to stop, and recovery puts every task back in the queue.

So every worker keeps a dedicated heartbeat connection, and the heartbeat never waits for the shared
pool. Budget that connection on top of the listener and whatever handlers take. If the pool cannot
spare it, or states no size, the worker refuses to start and says why.

Set `sharedHeartbeats` to send heartbeats through the shared pool instead, and accept that busy
handlers can then delay renewal. Go names that opt-out `SharedHeartbeats`, and Python, Rust, and
Ruby name it `shared_heartbeats`. The heartbeat connection runs only self-contained statements, so
it works behind a transaction-mode pooler.

<details>
<summary>Reference: heartbeat reservation</summary>

**Minimum pool.** A dedicated heartbeat connection needs a pool of at least 3 connections in every
language. That leaves room for the listener and one claim.

**Refusal (TypeScript).** The `Worker` constructor throws when the `Queue` cannot lend the
connection. The message names the reason and the opt-out:

- the queue's database has no `connect()` and no attached pool;
- the pool's size is unknown;
- the pool allows fewer than 3 connections.

A custom `WorkerQueueApi` that is not a `Queue` is not checked.

**Refusal in other languages.** Python raises `ValueError` when the pool capacity is unknown or
below 3. Go's `NewWorker` and Rust's worker constructor return an error when the pool maximum is
below 3. Ruby raises unless the pool size is an integer of at least 3.

| Language   | Opt-out             |
| ---------- | ------------------- |
| TypeScript | `sharedHeartbeats`  |
| Go         | `SharedHeartbeats`  |
| Python     | `shared_heartbeats` |
| Rust       | `shared_heartbeats` |
| Ruby       | `shared_heartbeats` |

**Bounded rounds.** The TypeScript worker bounds each round on the reserved connection by
`heartbeatMs`. A round that exceeds the bound, or fails, destroys the connection, and the next
round connects a new one. The connection runs only `heartbeat_many_v1` and never issues `SET`.

More detail: [Task lifecycle: Heartbeat connection](../architecture/lifecycle.md#heartbeat-connection).

</details>

## How does pool size affect a fast-tier worker?

A [fast-tier](305-fast-tier.md) queue skips the bookkeeping that durable execution needs. On such a
queue, a busy worker splits its slots into cohorts: fixed shares of its slots that each batch their
own completions. Each cohort can hold a connection of its own, so one cohort's handlers keep running
while another cohort's completion waits.

Take a TypeScript worker with high concurrency on a fast-tier queue.

1. **On a small pool** the listener and the heartbeat connection take two connections. The worker
   picks only as many cohorts as the remaining connections allow.
2. **On a larger pool** more connections remain, so the worker picks more cohorts. More completion
   round trips can overlap.

This holds in every language when the pool states its size. An explicit `cohorts` option is never
capped.

<details>
<summary>Reference: default cohorts</summary>

`defaultDispatchCohorts(concurrency, spareConnections)` picks:

- 1 below concurrency 8;
- otherwise `ceil(concurrency / 8)`, clamped to 2 through 8;
- then capped at the spare connections, and never below 1.

**Spare connections**

| Language     | Spare connections                                                                                            |
| ------------ | ------------------------------------------------------------------------------------------------------------ |
| TypeScript   | `options.max`, minus 1 for the listener when notifications are supported, minus 1 unless `sharedHeartbeats`. |
| Go           | `MaxConns`, minus 1 unless `PollingOnly`, minus 1 unless `SharedHeartbeats`.                                 |
| Python, Ruby | Pool size, minus 1 for the listener, minus 1 unless `shared_heartbeats`.                                     |
| Rust         | `max_size`, minus 1 unless `shared_heartbeats`. The listener sits outside the pool.                          |

In TypeScript, pools of 3, 4, 6, and 10 connections give a concurrency-64 worker 1, 2, 4, and 8
cohorts. A TypeScript database with an attached pool, such as a Prisma or Kysely adapter, runs
statements outside that pool, so its default is not capped.

More detail: [Fast tier: Dispatch cohorts](../architecture/fast-tier.md#dispatch-cohorts).

</details>

## What is unsafe?

A team moves its worker pool behind PgCat to save connections. Nothing fails. Tasks still run, but
every wake hint is lost, and each task waits for the fallback poll. The same happens behind
transaction-mode PgBouncer.

Three things are unsafe:

- **A worker pool behind a transaction-mode pooler or PgCat.** The wake hints die silently.
- **Session-level advisory locks under transaction pooling.** Exclusion stops holding between
  clients, and grants leak onto pooled backends.
- **Session state a client leaves behind.** The next client to borrow that backend inherits it.

One PgCat-only detail: its configuration names each pool, so a client can only reach a database the
pooler was configured for.

<details>
<summary>Reference: unsafe cases by pooler</summary>

| Case                                                                | PgBouncer transaction | PgCat session             | PgCat transaction         |
| ------------------------------------------------------------------- | --------------------- | ------------------------- | ------------------------- |
| `LISTEN`/`NOTIFY` wake hints                                        | Never delivered       | Held until the next query | Held until the next query |
| Session-level `pg_advisory_lock`/`pg_advisory_unlock`               | Unsafe                | Works                     | Unsafe                    |
| Session state (`SET`, SQL `PREPARE`/`DEALLOCATE`, temporary tables) | Unsafe                | Works                     | Unsafe                    |

Session advisory locks pin to whichever server session ran them, and they outlive the client
checkout. Under transaction pooling, a second client can acquire a held key. The session forms
exist only in Workhorse test harnesses.

PgCat's `pgcat.toml` names each pool statically. A client URL's database name must match a
configured pool.

More detail: [Overview: Advisory locks](../architecture/overview.md#advisory-locks).

</details>

## Next

- [How do I run workers?](310-workers.md)
- [How does enqueue stay transactional?](200-transactional-enqueue.md)
- [Who owns a task right now?](020-leases-and-fences.md)

Exact lock names, listener behavior, connection budgets, and lane coverage:
[architecture reference](../architecture/overview.md#connection-poolers).
