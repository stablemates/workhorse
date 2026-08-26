# `@stablemates/workhorse-prisma`

The Prisma ORM provider for enqueuing Workhorse jobs through Prisma transactions.

> **Public beta:** Workhorse is usable for evaluation and early production adoption, but 0.x minor
> releases may break compatibility, including the schema. There is no upgrade path between 0.x
> releases; ordered migrations begin at 1.0.0.

## Install

```bash
npm install @stablemates/workhorse @stablemates/workhorse-prisma @prisma/client
```

## Enqueue in a transaction

```ts
import { PrismaClient } from "@prisma/client";
import { createPrismaAdapter } from "@stablemates/workhorse-prisma";

const prisma = new PrismaClient();
const workhorse = createPrismaAdapter(prisma, { close: () => prisma.$disconnect() });

await prisma.$transaction(async (tx) => {
  // Application writes through tx...
  await workhorse.forTransaction(tx).enqueue("email.send", { recipient: "a@example.com" });
});
```

## Package boundary

The adapter never disconnects a caller-owned Prisma client unless `close` is configured. Workhorse
core owns schema installation and changes. Pass a `pg` pool as `notificationPool` for
`LISTEN/NOTIFY`; otherwise workers poll. Database errors become `PrismaQueryError`, with the original
error in `cause` and a nested PostgreSQL code copied to `code` when Prisma exposes one.

## Next

- Read the [Prisma integration guide](https://workhorse.run/docs/prisma) and
  [API reference](https://workhorse.run/docs/api).
- Browse the [repository](https://github.com/stablemates/workhorse) or report a problem in
  [GitHub issues](https://github.com/stablemates/workhorse/issues).

## License

Apache-2.0. See `LICENSE` and `NOTICE` in the package.
