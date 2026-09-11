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

A worker holds one dedicated connection for `LISTEN workhorse_jobs`. The pooler decides whether a
notification can reach it. Session-mode PgBouncer delivers normally. Transaction-mode PgBouncer
accepts the `LISTEN` and then detaches the server session, so the hint is accepted and never
delivered — nothing errors, and the worker keeps dispatching on its fallback poll. PgCat fails in
every mode: it holds a notification until the client sends another query, which an idle listener
never does.

To keep wake hints, give the listener a connection that reaches PostgreSQL without those poolers —
direct, or session-mode PgBouncer. The ORM adapters take a `notificationPool` for exactly this.
A `Queue` built on a queryable without `connect()` stays polling-only.

## How do I budget connections?

A notification-capable pool holds one connection for the listener no matter how many workers share
it, so a listening pool needs room for the listener plus claims. A pool capped at one connection
polls instead of listening. Behind any pooler that cannot deliver notifications the listener slot
is held without delivering anything, which is budget spent on both the client pool and the
pooler's client cap.

## What is unsafe?

Pointing `notificationPool` at a transaction-mode pooler or at PgCat, because the hints die
silently. Session-level advisory locks under transaction pooling, because exclusion stops holding
between clients and grants leak onto pooled backends. Any session state a client leaves behind,
because the next client to borrow that backend inherits it. One PgCat-only detail: its
configuration names each pool, so a client can only reach a database the pooler was configured
for.

## Next

- [How do I run workers?](310-workers.md)
- [How does enqueue stay transactional?](200-transactional-enqueue.md)
- [Who owns a job right now?](020-leases-and-fences.md)

Exact lock names, listener behavior, and lane coverage:
[architecture reference](../architecture.md#connection-poolers).
