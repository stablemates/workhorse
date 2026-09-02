# `@stablemates/workhorse-drizzle`

The Drizzle ORM provider for enqueuing Workhorse jobs through Drizzle transactions.

> **Public beta:** Workhorse is usable for evaluation and early production adoption. A 0.x minor
> release may change behaviour, so read the changelog before you upgrade. It will not ask you to
> recreate your database: migrations are ordered, and inside a major line a migration only adds, so
> a running deployment upgrades in place.

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
