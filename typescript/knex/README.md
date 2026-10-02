# `@stablemates/workhorse-knex`

The optional PostgreSQL Knex adapter makes a business write and a Workhorse enqueue commit together.
Objection uses the same adapter because its transactions are Knex transactions.

**Public beta:** Workhorse is usable for evaluation and early production adoption.
A 0.x minor release may change behaviour. Read the changelog before upgrading.
For upgrades, inside a major line a migration only adds: a running deployment upgrades in place.
The exception is migration 0025, crossed offline when upgrading from before 0.5.0.

## Install

```bash
npm install @stablemates/workhorse @stablemates/workhorse-knex knex@3.3.0 pg@8.23.0
```

This package is part of the next Workhorse release train. A source checkout can use its workspace package.
The verified baseline is Knex 3.3.0 and pg 8.23.0, with Objection 3.1.5 for the recipe.
Only PostgreSQL with `client: "pg"` is supported. Other versions and drivers are not certified.

## Enqueue in a transaction

```ts
import knex from "knex";
import { createKnexAdapter } from "@stablemates/workhorse-knex";

const database = knex({ client: "pg", connection: process.env.DATABASE_URL });
const workhorse = createKnexAdapter(database);
await database.transaction(async (transaction) => {
  const [account] = await transaction("account").insert({ email: "a@example.com" }).returning("id");
  await workhorse.forTransaction(transaction).enqueue("account.created", { accountId: account.id });
});
await database.destroy();
```

The caller owns commit, rollback, savepoints, and Knex destruction.
Without an explicit `close` option, closing the adapter does not destroy Knex.
Do not use the pool queue inside an application transaction. Use its exact transaction handle.
The adapter does not verify that a supplied transaction targets the same database as the base executor.

## Native SQL and limits

`knexQueryable` sends native PostgreSQL text and positional values through
`raw(statement).options({ text: statement, values: [...values] })`.
The maintained fixture proves the route against the released packages, not just options precedence.
It covers literals, comments, dollar quotes, JSON operators, repeated binds, and out-of-order binds.
No parameter interpolation or private connection extraction occurs.

Knex `postProcessResponse` hooks are rejected before execution, including later configuration changes.
One native result with object rows is required. Multi-statement arrays and transformed result shapes fail.
Custom clients, patched execution, and listeners that mutate query configuration are outside the verified boundary.
Native values retain pg's default parsers. Result metadata is synthetic: `rowCount` is the row count,
`command` is empty, `oid` is zero, and `fields` is empty.
`KnexQueryError` retains the statement, original `cause`, and PostgreSQL SQLSTATE in `code`.
Completed transaction handles fail through Knex's completion guard; they never become pooled queries.

## Dedicated workers

Run workers in a separate process with a separately configured compatible node-postgres pool.
Do not lend a transaction or extract Knex's internal pool for worker sessions.
An adapter's explicit `pool` option is for dedicated heartbeat and listener connections, not ordinary enqueue execution.
Without that option, a worker refuses to start unless `sharedHeartbeats` is explicitly selected.
Use Workhorse core's `Queue` and `defineWorkerProcess` for the separate worker process.

[Workhorse core](https://workhorse.run/docs/installation) owns schema installation and changes.
See the [Knex guide](https://workhorse.run/docs/knex), [Objection recipe](https://workhorse.run/docs/objection),
and [maintained example](https://github.com/stablemates/workhorse/blob/main/typescript/examples/objection.ts).
Upstream source: [Knex PostgreSQL execution](https://github.com/knex/knex/blob/3.3.0/lib/dialects/postgres/index.js)
and [transaction completion guards](https://github.com/knex/knex/blob/3.3.0/lib/execution/transaction.js).

## License

Apache-2.0. See `LICENSE` and `NOTICE` in the package.
