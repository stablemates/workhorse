# `@ironshift/drizzle`

Drizzle ORM provider for Ironshift's PostgreSQL protocol.

```ts
import { createDrizzleAdapter } from "@ironshift/drizzle";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const db = drizzle({ client: pool });
const ironshift = createDrizzleAdapter(db, { close: () => pool.end() });

await db.transaction(async (tx) => {
  // Application writes through tx...
  await ironshift.forTransaction(tx).enqueue("email.send", { recipient: "a@example.com" });
});
```

The adapter never closes caller-owned database resources unless `close` is configured. Database
errors are rethrown as `DrizzleQueryError` with the original error in `cause` and its PostgreSQL
error code copied to `code` when available.
