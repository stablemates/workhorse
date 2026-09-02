# `@stablemates/workhorse-kysely`

The Kysely provider for enqueuing Workhorse jobs through Kysely transactions.

> **Public beta:** Workhorse is usable for evaluation and early production adoption, but 0.x minor
> releases may break compatibility, including the schema. There is no upgrade path between 0.x
> releases; ordered migrations begin at 1.0.0.

## Install

```bash
npm install @stablemates/workhorse @stablemates/workhorse-kysely kysely pg
```

## Enqueue in a transaction

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

## Package boundary

The adapter never destroys a caller-owned Kysely database unless `close` is configured.
[Workhorse core](https://workhorse.run/docs/installation) owns schema installation and changes.
Pass the `pg` pool used by `PostgresDialect` as `notificationPool` for `LISTEN/NOTIFY`; otherwise
workers poll. Database errors become `KyselyQueryError`, with the original error in `cause` and its
PostgreSQL code copied to `code`.

## Next

- Read the [Kysely integration guide](https://workhorse.run/docs/kysely) and
  [API reference](https://workhorse.run/docs/api).
- Browse the [repository](https://github.com/stablemates/workhorse) or report a problem in
  [GitHub issues](https://github.com/stablemates/workhorse/issues).

## License

Apache-2.0. See `LICENSE` and `NOTICE` in the package.
