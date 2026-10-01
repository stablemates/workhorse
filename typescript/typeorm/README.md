# `@stablemates/workhorse-typeorm`

The TypeORM provider for enqueuing Workhorse tasks through TypeORM transactions.

> **Public beta:** Workhorse is usable for evaluation and early production adoption. A 0.x minor
> release may change behaviour, so read the changelog before you upgrade. It will not ask you to
> recreate your database: migrations are ordered, and inside a major line a migration only adds, so
> a running deployment upgrades in place. The one exception is migration 0025: a database from
> before 0.5.0 crosses it offline, with the
> [0.5.0 upgrade steps](https://github.com/stablemates/workhorse/blob/main/CHANGELOG.md#050--2026-09-28).
> The upgrade from 0.5 to 0.6 only adds.

## Install

```bash
npm install @stablemates/workhorse @stablemates/workhorse-typeorm typeorm pg
```

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
(`dataSource.driver.master`), so initialize the data source before you create one. Database errors
become `TypeOrmQueryError`, with the original error in `cause` and its PostgreSQL driver code copied
to `code` when available.

## Next

- Read the [TypeORM integration guide](https://workhorse.run/docs/typeorm) and
  [API reference](https://workhorse.run/docs/api).
- Browse the [repository](https://github.com/stablemates/workhorse) or report a problem in
  [GitHub issues](https://github.com/stablemates/workhorse/issues).

## License

Apache-2.0. See `LICENSE` and `NOTICE` in the package.
