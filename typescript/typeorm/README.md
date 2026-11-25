# `@stablemates/workhorse-typeorm`

The TypeORM provider for enqueuing Workhorse tasks through TypeORM transactions.

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
npm install @stablemates/workhorse @stablemates/workhorse-typeorm typeorm pg
```

Install the Workhorse schema with [Workhorse core](https://workhorse.run/docs/installation) before
the first enqueue. If the schema is missing, the queue refuses the enqueue.

## Enqueue in a transaction

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

## Package boundary

The adapter never destroys a caller-owned data source unless `close` is configured.
[Workhorse core](https://workhorse.run/docs/installation) owns schema installation and changes.
Workers take their heartbeat and `LISTEN/NOTIFY` connections from the data source's own pool
(`dataSource.driver.master`), so initialize the data source before you create one. Set `poolSize`
to at least 3. As an alternative, give a `pg` pool with `max` set to at least 3 as `pool`. Without a
usable pool, `createWorker()` throws. Database errors
become `TypeOrmQueryError`, with the original error in `cause` and its PostgreSQL driver code copied
to `code` when available.

## Next

- Read the [TypeORM integration guide](https://workhorse.run/docs/typeorm) and
  [API reference](https://workhorse.run/docs/api).
- Browse the [repository](https://github.com/stablemates/workhorse) or report a problem in
  [GitHub issues](https://github.com/stablemates/workhorse/issues).

## License

Apache-2.0. See `LICENSE` and `NOTICE` in the package.
