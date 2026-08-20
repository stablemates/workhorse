# `@workhorse-js/prisma`

Prisma ORM provider for Workhorse's PostgreSQL protocol.

```ts
import { PrismaClient } from "@prisma/client";
import { createPrismaAdapter } from "@workhorse-js/prisma";

const prisma = new PrismaClient();
const workhorse = createPrismaAdapter(prisma, { close: () => prisma.$disconnect() });

await prisma.$transaction(async (tx) => {
  // Application writes through tx...
  await workhorse.forTransaction(tx).enqueue("email.send", { recipient: "a@example.com" });
});
```

The adapter never disconnects a caller-owned Prisma client unless `close` is configured. Pass a
node-postgres pool as `notificationPool` when workers should use `LISTEN/NOTIFY`; otherwise they poll.
Database errors become `PrismaQueryError`, with the original error in `cause` and a nested PostgreSQL
error code copied to `code` when Prisma exposes one.
