# Drizzle

> Adapt a node-postgres Drizzle database and enqueue jobs inside caller-owned transactions.

Your application already writes through Drizzle. When a request inserts an account and enqueues a
follow-up job, those two writes must commit together — a job for a row that rolled back is a bug,
and a committed row with no job is a silent gap. `@workhorse/drizzle` closes that gap: it converts
Drizzle's database and transaction objects into the core `Queryable` protocol, so `Queue.enqueue`
runs inside the same transaction as your Drizzle writes.

Workhorse stays outside your Drizzle migration graph and keeps its own schema lifecycle. Drizzle
owns your tables; Workhorse owns its versioned SQL functions.

## Create the adapter

Install the integration beside the Drizzle and node-postgres packages your application uses.

```bash
pnpm add @workhorse/drizzle drizzle-orm pg
```

Pass the Drizzle database to `createDrizzleAdapter`.

```ts
import { createDrizzleAdapter } from "@workhorse/drizzle";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const db = drizzle({ client: pool });

const workhorse = createDrizzleAdapter(db, {
  close: () => pool.end(),
});
```

The returned `WorkhorseAdapter` exposes `database`, `queue`, `forTransaction`, `createWorker`, and
`close`. It gives worker processes one stable surface without adding Drizzle to core.

## Enqueue inside a Drizzle transaction

This is the pattern the adapter exists for. Call `forTransaction` with the transaction object. The
returned `Queue` sends its SQL through that transaction, so the job follows the surrounding commit
or rollback.

```ts
await db.transaction(async (tx) => {
  await tx.insert(account).values({ id: accountId, email });
  await workhorse.forTransaction(tx).enqueue("account.created", {
    accountId,
  });
});
```

If the callback throws, Drizzle rolls back both the account and the job. Nothing outside the
transaction ever sees a half-committed pair. A queue created from the adapter's default `queue`
property remains outside that caller transaction — use it for enqueues that stand alone.

## Create workers from the same adapter

`workhorse.createWorker` uses the adapter's default queue and database connection, so a worker
process needs no second wiring path.

```ts
const worker = workhorse.createWorker();
worker.handle("account.created", handleAccountCreated);
await worker.run();
```

Use `drizzleQueryable` directly when you need a custom `Queue` but do not want the adapter
lifecycle.

Database execution failures become `DrizzleQueryError`, which retains the SQL statement, PostgreSQL
code when available, and original cause. Typed Workhorse conflicts — idempotency, checkpoint, and
wait errors — remain their core error classes, so your handling code never needs to unwrap them.

## Keep resource ownership explicit

Unless you supply `close`, the adapter leaves caller-owned resources open. Add that hook only when
the adapter owns the pool, because `adapter.close` may run during process shutdown or failed
startup. If your application created the pool for other work, keep closing it yourself.

Install the Workhorse schema with the core deployment tools. Drizzle should not generate or migrate
Workhorse's versioned SQL functions — the schema is a versioned protocol, not application tables.

## Next

- [Enqueue and transactions](/docs/enqueue) — understand the transaction guarantee
- [Worker processes](/docs/worker-processes) — run handlers outside the web tier
- [Installation](/docs/installation) — install the schema outside Drizzle migrations

---

Exact adapter boundary and transactional enqueue semantics:
[architecture reference](https://github.com/stablemates/workhorse/blob/main/docs/architecture.md#system-context).
