# Enqueueing a job in the same transaction as your data

Your handler inserts an order, then enqueues "send confirmation email". If the insert and the
enqueue commit separately, one of them will eventually happen without the other: an order with
no email, or an email for an order that rolled back.

Workhorse closes that gap because a job is a row in your own PostgreSQL database. Enqueue
inside your open transaction, and PostgreSQL commits the order and the job together — or rolls
both back together. There is no outbox table to build and no window where only one exists.

## With node-postgres

`Queue.enqueue` accepts your open transaction client as its final argument. Anything with a
pg-compatible `query` method works, so a `PoolClient` inside an explicit transaction is enough:

```ts
const client = await pool.connect();

try {
  await client.query("BEGIN");
  await client.query("INSERT INTO account (id, email) VALUES ($1, $2)", [id, email]);
  await queue.enqueue("account.created", { accountId: id }, {}, client);
  await client.query("COMMIT");
} catch (error) {
  await client.query("ROLLBACK");
  throw error;
} finally {
  client.release();
}
```

`Queue.enqueueMany` takes the same transaction argument, so a fan-out created by one request
commits or rolls back as a unit with the row that caused it.

## With Psycopg

Python has no transaction argument. `Queue` binds the connection you give it, and the transaction
belongs to that connection. Open a transaction on the connection, enqueue through a `Queue` built
on the same connection, and the two writes share it:

```python
with connection.transaction():
    connection.execute("INSERT INTO account (id, email) VALUES (%s, %s)", (id, email))
    Queue(connection).enqueue("account.created", {"accountId": id})
```

If the block raises, Psycopg rolls back, and the job goes with your row.

A worker needs a connection of its own, in autocommit mode. `Worker` raises `ValueError` if you
hand it anything else, so that mistake is loud. The quiet mistake is sharing one connection between
a worker and the code that enqueues: a Psycopg connection serializes its work, so the two take
turns instead of running together, and nothing reports it. Give each its own connection.

Autocommit and an explicit transaction are not in conflict. `connection.transaction()` opens a real
transaction block on an autocommit connection, which is why the example above is correct on the same
connection style a worker requires.

## With pgx

Go has no transaction argument either. An executor wraps whatever you already hold, and
`NewPGXExecutor` accepts a `pgx.Tx` as readily as a pool:

```go
tx, err := pool.Begin(ctx)
_, err = tx.Exec(ctx, "INSERT INTO account (id, email) VALUES ($1, $2)", id, email)
queue := workhorse.NewQueue(workhorse.NewPGXExecutor(tx), "default")
_, err = queue.Enqueue(ctx, "account.created", map[string]any{"accountId": id})
err = tx.Commit(ctx)
```

`NewSQLExecutor` does the same for the standard library, and accepts a `*sql.Tx`. Either way the
queue reads and writes through the handle you passed, so your commit covers the job.

## With an ORM provider

If your TypeScript application talks to PostgreSQL through an ORM, use that ORM's Workhorse
package instead of managing a raw client next to it. Python and Go have no equivalent package, so
they pass their own connection or transaction as the sections above show. Each provider wraps the database object you
already own and exposes `forTransaction`, which returns a `Queue` bound to your open
transaction. The provider never commits, rolls back, or closes that transaction — your ORM
stays in charge, and Workhorse rides along on the transaction's own connection.

Drizzle, with `createDrizzleAdapter` from `@stablemates/workhorse-drizzle`:

```ts
const db = drizzle({ client: pool });
const workhorse = createDrizzleAdapter(db, { close: () => pool.end() });

await db.transaction(async (tx) => {
  await tx.insert(accounts).values({ id, email });
  await workhorse.forTransaction(tx).enqueue("account.created", { accountId: id });
});
```

Prisma, with `createPrismaAdapter` from `@stablemates/workhorse-prisma`:

```ts
const prisma = new PrismaClient();
const workhorse = createPrismaAdapter(prisma, { close: () => prisma.$disconnect() });

await prisma.$transaction(async (tx) => {
  await tx.account.create({ data: { id, email } });
  await workhorse.forTransaction(tx).enqueue("account.created", { accountId: id });
});
```

TypeORM, with `createTypeOrmAdapter` from `@stablemates/workhorse-typeorm`:

```ts
const workhorse = createTypeOrmAdapter(dataSource, { close: () => dataSource.destroy() });

await dataSource.transaction(async (manager) => {
  await manager.insert(Account, { id, email });
  await workhorse.forTransaction(manager).enqueue("account.created", { accountId: id });
});
```

Kysely, with `createKyselyAdapter` from `@stablemates/workhorse-kysely`:

```ts
const workhorse = createKyselyAdapter(db, { close: () => db.destroy() });

await db.transaction().execute(async (trx) => {
  await trx.insertInto("account").values({ id, email }).execute();
  await workhorse.forTransaction(trx).enqueue("account.created", { accountId: id });
});
```

If the transaction callback throws, the ORM rolls back, and the job disappears with your data.
If it commits, the job is durable and a worker can claim it.

## What the transaction covers

The transaction covers durable acceptance only. Your handler runs later, on a worker, outside
any application transaction — so its external effects still need their own protection, which is
what [delivery guarantees](030-delivery-guarantees.md) are about.

One more boundary: an adapter closes nothing it did not create. Your database, pool, or client
stays open until you close it yourself, or until you hand the adapter a `close` callback and
call `close` on the adapter.

## Next

- [210-enqueue-idempotency.md](210-enqueue-idempotency.md) — stop a retried request from creating two jobs
- [030-delivery-guarantees.md](030-delivery-guarantees.md) — why the handler still needs idempotency
- [010-jobs-and-state.md](010-jobs-and-state.md) — what the committed row actually is

---

Exact adapter guarantees, error translation, and notification wiring:
[`architecture.md`](../architecture.md#what-an-adapter-must-guarantee).
