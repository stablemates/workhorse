# `@stablemates/workhorse-prisma`

The Prisma ORM provider for enqueuing Workhorse tasks through Prisma transactions.

> Workhorse follows Semantic Versioning from 1.0.0. A 1.x minor or patch release does not break a
> governed surface, such as the API of this package. Read [what 1.0.0
> promises](https://workhorse.run/docs/compatibility#know-what-100-promises) and the changelog
> before you upgrade. A release does not make you create your database again. Migrations are
> ordered, and inside a major line a migration only adds. Thus, a running deployment upgrades in
> place.
> Migration 0025 is the one exception. If your database is from a release before 0.5.0, upgrade it
> offline with [these steps](https://workhorse.run/docs/installation#upgrade-a-04x-database-offline).

## Install

```bash
npm install @stablemates/workhorse @stablemates/workhorse-prisma @prisma/client
```

Install the Workhorse schema with [Workhorse core](https://workhorse.run/docs/installation) before
the first enqueue. If the schema is missing, the queue refuses the enqueue.

The adapter supports Prisma Client 6 and 7. Prisma 7 requires a driver adapter, such as
`@prisma/adapter-pg`, in the `PrismaClient` constructor.

## Enqueue in a transaction

```ts
import { PrismaClient } from "@prisma/client";
import { createPrismaAdapter } from "@stablemates/workhorse-prisma";

// On Prisma 7: new PrismaClient({ adapter: new PrismaPg({ connectionString }) })
const prisma = new PrismaClient();
const workhorse = createPrismaAdapter(prisma, { close: () => prisma.$disconnect() });

await prisma.$transaction(async (tx) => {
  // Application writes through tx...
  await workhorse.forTransaction(tx).enqueue("email.send", { recipient: "a@example.com" });
});
```

## Package boundary

The adapter never disconnects a caller-owned Prisma client unless `close` is configured.
[Workhorse core](https://workhorse.run/docs/installation) owns schema installation and changes.
A process that runs workers passes a `pg` pool with a maximum size (`max`) of at least 3 as `pool`.
Workers take their heartbeat and `LISTEN/NOTIFY` connections from it. Without that pool,
`createWorker()` throws an error that names the step. Database errors
become `PrismaQueryError`, with the original error in `cause` and a nested PostgreSQL code copied to
`code` when Prisma exposes one. On Prisma 7, the code comes from the error that the driver adapter
reported.

## Next

- Read the [Prisma integration guide](https://workhorse.run/docs/prisma) and
  [API reference](https://workhorse.run/docs/api).
- Browse the [repository](https://github.com/stablemates/workhorse) or report a problem in
  [GitHub issues](https://github.com/stablemates/workhorse/issues).

## License

Apache-2.0. See `LICENSE` and `NOTICE` in the package.
