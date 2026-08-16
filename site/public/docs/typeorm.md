# TypeORM

> Adapt a TypeORM data source and enqueue jobs through transactional entity managers.

Your application already writes through TypeORM. When a request saves an entity and enqueues a
follow-up job, those two writes must commit together — a job for a row that rolled back is a bug,
and a committed row with no job is a silent gap. `@workhorse/typeorm` closes that gap: it converts
TypeORM data sources and transactional entity managers into the core `Queryable` protocol, so
`Queue.enqueue` runs inside the same transaction as your entity writes.

Workhorse keeps its schema lifecycle outside TypeORM migrations. TypeORM owns your entities;
Workhorse owns its versioned SQL functions.

## Create the adapter

Install the integration beside TypeORM.

```bash
pnpm add @workhorse/typeorm typeorm
```

Pass an initialized data source to `createTypeOrmAdapter`. The close callback is optional because
the adapter does not destroy caller-owned data sources by default.

```ts
import { createTypeOrmAdapter } from "@workhorse/typeorm";

const workhorse = createTypeOrmAdapter(dataSource, {
  close: () => dataSource.destroy(),
});
```

The returned `WorkhorseAdapter` exposes `database`, `queue`, `forTransaction`, `createWorker`, and
`close` — one stable surface for both request handlers and worker processes.

## Enqueue inside a transaction

This is the pattern the adapter exists for. Call `forTransaction` with the callback's entity
manager. The queue sends its SQL through that manager, so the job follows the surrounding commit or
rollback.

```ts
await dataSource.transaction(async (manager) => {
  const account = await manager.save(Account, { email });
  await workhorse.forTransaction(manager).enqueue("account.created", {
    accountId: account.id,
  });
});
```

If the callback throws, TypeORM rolls back both writes. Nothing outside the transaction ever sees a
half-committed pair. The adapter's default queue remains outside that transaction — use it for
enqueues that stand alone.

## Enable notification-assisted workers

TypeORM does not expose its internal node-postgres pool as a stable API. Supply a separate
caller-owned pool as `notificationPool` when workers should reserve a connection for
`LISTEN/NOTIFY` and pick up new jobs immediately. Without it, workers use bounded polling and keep
the same durable behavior — jobs still run, just on the polling cadence.

Database execution failures become `TypeOrmQueryError`, which retains the statement, original
cause, and PostgreSQL driver code. Typed Workhorse conflicts — idempotency, checkpoint, and wait
errors — remain their core error classes.

## Keep resource ownership explicit

Unless you supply `close`, the adapter leaves the data source initialized. Add that hook only when
the adapter owns the data source, because `adapter.close` may run during process shutdown or failed
startup.

Install the Workhorse schema with the core deployment tools. TypeORM migrations should not manage
Workhorse's versioned SQL functions — the schema is a versioned protocol, not application entities.

## Next

- [Enqueue and transactions](/docs/enqueue) — understand the transaction guarantee
- [Workers](/docs/workers) — configure polling and handlers
- [Installation](/docs/installation) — install the schema outside TypeORM migrations

---

Exact adapter boundary and transaction ownership:
[architecture reference](https://github.com/stablemates/workhorse/blob/main/docs/architecture.md#system-context).
