# `@stablemates/workhorse-typeorm`

The TypeORM provider for enqueuing Workhorse jobs through TypeORM transactions.

> **Public beta:** Workhorse is usable for evaluation and early production adoption, but 0.x minor
> releases may break compatibility, including the schema. There is no upgrade path between 0.x
> releases; ordered migrations begin at 1.0.0.

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
Pass a `pg` pool as `notificationPool` for `LISTEN/NOTIFY`; otherwise workers poll. Database errors
become `TypeOrmQueryError`, with the original error in `cause` and its PostgreSQL driver code copied
to `code` when available.

## Next

- Read the [TypeORM integration guide](https://workhorse.run/docs/typeorm) and
  [API reference](https://workhorse.run/docs/api).
- Browse the [repository](https://github.com/stablemates/workhorse) or report a problem in
  [GitHub issues](https://github.com/stablemates/workhorse/issues).

## License

Apache-2.0. See `LICENSE` and `NOTICE` in the package.
