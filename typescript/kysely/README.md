# `@stablemates/workhorse-kysely`

Workhorse is a public beta. It is usable for evaluation and early production adoption, but any
minor release may break compatibility, including the schema. There is no upgrade path between 0.x
releases; ordered migrations begin at 1.0.0.

Kysely provider for Workhorse's PostgreSQL protocol.

```ts
import { createKyselyAdapter } from "@stablemates/workhorse-kysely";

const workhorse = createKyselyAdapter(database, {
  notificationPool: pool,
  close: () => database.destroy(),
});

await database.transaction().execute(async (transaction) => {
  // Application writes through transaction...
  await workhorse.forTransaction(transaction).enqueue("email.send", {
    recipient: "a@example.com",
  });
});
```

The adapter never destroys a caller-owned Kysely database unless `close` is configured. Pass the
node-postgres pool used by `PostgresDialect` as `notificationPool` when workers should use
`LISTEN/NOTIFY`; otherwise they poll. Database errors become `KyselyQueryError`, with the original
error in `cause` and the PostgreSQL error code copied to `code` when available.
