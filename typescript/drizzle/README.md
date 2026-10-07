# `@stablemates/workhorse-drizzle`

The Drizzle ORM provider for enqueuing Workhorse tasks through Drizzle transactions.

> **Public beta:** Workhorse is usable for evaluation and early production adoption. A 0.x minor
> release may change behaviour, so read the changelog before you upgrade. It will not ask you to
> recreate your database: migrations are ordered, and inside a major line a migration only adds, so
> a running deployment upgrades in place. The one exception is migration 0025: a database from
> before 0.5.0 crosses it offline, with the
> [0.5.0 upgrade steps](https://github.com/stablemates/workhorse/blob/main/CHANGELOG.md#050--2026-09-28).
> The upgrade from 0.5 to 0.6 only adds.

## Install

```bash
npm install @stablemates/workhorse @stablemates/workhorse-drizzle drizzle-orm pg
```

## Enqueue in a transaction

```ts
import { Pool } from "@stablemates/workhorse";
import { createDrizzleAdapter } from "@stablemates/workhorse-drizzle";
import { drizzle } from "drizzle-orm/node-postgres";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const db = drizzle({ client: pool });
const workhorse = createDrizzleAdapter(db, { close: () => pool.end() });

await db.transaction(async (tx) => {
  // Application writes through tx...
  await workhorse.forTransaction(tx).enqueue("email.send", { recipient: "a@example.com" });
});
```

## Use a transaction queue only inside its transaction

Create the queue from `forTransaction(tx)` inside the callback and drop it when the callback
returns. Drizzle gives the adapter no signal when a transaction ends, so the adapter cannot
invalidate a queue that outlives it. Knex differs: its adapter rejects a completed transaction.

Suppose a callback stores `workhorse.forTransaction(tx)` in a variable, and Drizzle commits and
releases the connection. A later enqueue through that variable runs on the released connection:

- When the connection sits idle in the pool, the enqueue commits on its own.
- When another `db.transaction` has borrowed the connection, the enqueue joins that transaction and
  follows its commit or rollback.

Neither outcome belongs to the original transaction, and Workhorse reports no error for either.

## Package boundary

The adapter never closes caller-owned database resources unless `close` is configured.
[Workhorse core](https://workhorse.run/docs/installation) owns schema installation and changes.
Database errors are rethrown as `DrizzleQueryError`, with the original error in `cause` and its
PostgreSQL code copied to `code` when available.

## Next

- Read the [Drizzle integration guide](https://workhorse.run/docs/drizzle) and
  [API reference](https://workhorse.run/docs/api).
- Browse the [repository](https://github.com/stablemates/workhorse) or report a problem in
  [GitHub issues](https://github.com/stablemates/workhorse/issues).

## License

Apache-2.0. See `LICENSE` and `NOTICE` in the package.
