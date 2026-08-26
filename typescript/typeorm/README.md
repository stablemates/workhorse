# `@stablemates/workhorse-typeorm`

Workhorse is a public beta. It is usable for evaluation and early production adoption, but any
minor release may break compatibility, including the schema. There is no upgrade path between 0.x
releases; ordered migrations begin at 1.0.0.

TypeORM provider for Workhorse's PostgreSQL protocol.

```ts
import { createTypeOrmAdapter } from "@stablemates/workhorse-typeorm";

const workhorse = createTypeOrmAdapter(dataSource, { close: () => dataSource.destroy() });

await dataSource.transaction(async (manager) => {
  // Application writes through manager...
  await workhorse.forTransaction(manager).enqueue("email.send", {
    recipient: "a@example.com",
  });
});
```

The adapter never destroys a caller-owned data source unless `close` is configured. Pass a
node-postgres pool as `notificationPool` when workers should use `LISTEN/NOTIFY`; otherwise they poll.
Database errors become `TypeOrmQueryError`, with the original error in `cause` and the PostgreSQL
driver error code copied to `code` when available.
