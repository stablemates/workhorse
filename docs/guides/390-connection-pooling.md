# Can I put a connection pooler in front of Workhorse?

Yes. Every queue operation works through session-mode and transaction-mode pooling alike. The one
feature that needs a dedicated session is the wake-hint listener, and losing it only costs
latency: polling stays the correctness mechanism.

## What breaks under transaction pooling?

Transaction pooling hands a client a different server session for each transaction. Anything that
lives on a session — a `LISTEN`, a session-level advisory lock, a `SET` — either stops working or
leaks onto a pooled backend the next client inherits.

Workhorse uses none of those for correctness. Enqueue, claim, heartbeat, settle, schema
installation, and migration all work, because every statement is self-contained and every lock the
schema takes is transaction-scoped. A caller-owned transaction commits and rolls back queue writes
normally, so [transactional enqueue](200-transactional-enqueue.md) is unaffected.

## What does the listener need?

The listener holds a dedicated connection for `LISTEN workhorse_tasks`. The pooler decides whether a
notification can reach it. Session-mode PgBouncer delivers normally. Transaction-mode PgBouncer
accepts the `LISTEN` and then detaches the server session, so the hint is accepted and never
delivered — nothing errors, and the worker keeps dispatching on its fallback poll. PgCat fails in
every mode: it holds a notification until the client sends another query, which an idle listener
never does.

To keep wake hints, give the worker a pool that reaches PostgreSQL without those poolers — direct,
or session-mode PgBouncer. Drizzle and TypeORM workers use the ORM's own pool. The Prisma and
Kysely adapters take a `pool` for exactly this. A `Queue` built on a queryable without `connect()`
has no listener, and its worker logs one warning when it starts.

## How do I budget connections?

Where the listener connection comes from depends on the language. TypeScript, Go, and Ruby workers
on one pool share one listener, which holds one pooled connection however many workers subscribe.
A Python worker takes its own listener connection from the supplied pool. A Rust worker opens its
own listener connection outside the pool, from the `listen_config` it is given. When a TypeScript
or Go pool is too small to spare a connection, the worker polls instead of listening. Behind any
pooler that cannot deliver notifications, the listener connection is held without delivering
anything. That connection still counts against the pooler's client cap. For every language except
Rust, it also counts against the client pool.

Heartbeats need headroom of their own. If handlers hold every pooled connection, a heartbeat queued
behind them never runs, and every lease lapses at once. Every worker therefore keeps a dedicated
heartbeat connection. TypeScript, Go, and Ruby workers on one pool share one heartbeat connection.
A Python worker and a Rust worker each take their own from the pool. Budget that connection on top
of the listener and whatever handlers take. If the pool cannot spare it, or states no size, the
worker refuses to start and says why. Set `sharedHeartbeats` to send heartbeats through the shared
pool instead, and accept that busy handlers can then delay renewal. The heartbeat connection runs
only self-contained statements, so it works behind a transaction-mode pooler. Go names that opt-out
`SharedHeartbeats`, and Python, Rust, and Ruby name it `shared_heartbeats`.

To size a pool for several workers, count what each language holds before handlers take anything.
Workers on one TypeScript, Go, or Ruby pool hold the listener and the heartbeat connection once,
however many workers there are. Python workers hold both once per worker. Rust workers hold one
heartbeat connection per worker inside the pool. Their listener connections sit outside the pool,
so count them against the server's or the pooler's connection limit instead.

On a fast-tier queue, a busy worker in any language splits its slots into cohorts, and each cohort
can hold a connection of its own. When the pool states its size, the worker picks no more cohorts
than the pool has connections left after the listener and the heartbeat. A larger pool therefore
lets a busy worker overlap more round trips.

## What is unsafe?

Giving a worker a pool behind a transaction-mode pooler or PgCat, because the hints die silently. Session-level advisory locks under transaction pooling, because exclusion stops holding
between clients and grants leak onto pooled backends. Any session state a client leaves behind,
because the next client to borrow that backend inherits it. One PgCat-only detail: its
configuration names each pool, so a client can only reach a database the pooler was configured
for.

## Next

- [How do I run workers?](310-workers.md)
- [How does enqueue stay transactional?](200-transactional-enqueue.md)
- [Who owns a task right now?](020-leases-and-fences.md)

Exact lock names, listener behavior, connection budgets, and lane coverage:
[architecture reference](../architecture/overview.md#connection-poolers).
