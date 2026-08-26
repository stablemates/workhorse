# `@stablemates/workhorse-drizzle`

Workhorse is a public beta. It is usable for evaluation and early production adoption, but any
minor release may break compatibility, including the schema. There is no upgrade path between 0.x
releases; ordered migrations begin at 1.0.0.

Drizzle ORM provider for Workhorse's PostgreSQL protocol.

```ts
import { createDrizzleAdapter } from "@stablemates/workhorse-drizzle";
import { Pool } from "@stablemates/workhorse";
import { drizzle } from "drizzle-orm/node-postgres";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const db = drizzle({ client: pool });
const workhorse = createDrizzleAdapter(db, { close: () => pool.end() });

await db.transaction(async (tx) => {
  // Application writes through tx...
  await workhorse.forTransaction(tx).enqueue("email.send", { recipient: "a@example.com" });
});
```

The adapter never closes caller-owned database resources unless `close` is configured. Database
errors are rethrown as `DrizzleQueryError` with the original error in `cause` and its PostgreSQL
error code copied to `code` when available.
