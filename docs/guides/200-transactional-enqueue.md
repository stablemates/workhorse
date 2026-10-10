# How do I enqueue a task in the same transaction as my data?

<!-- scenario-names: acc-7, account.created -->

Your code inserts an account, then enqueues "send a welcome email". If the insert and the enqueue
commit separately, one of them will eventually happen without the other: an account with no email,
or an email for an account that rolled back.

Workhorse closes that gap because a task is a row in your own PostgreSQL database. Enqueue inside
your open transaction, and PostgreSQL commits the account and the task together, or rolls both back
together. There is no outbox table to build and no window where only one exists.

## One account, one task, one commit

> **Example.** A signup request creates account `acc-7` and asks for an `account.created` task.
>
> 1. **The transaction opens.** The app server begins a transaction and inserts the `acc-7` row.
> 2. **The enqueue.** The app server enqueues `account.created` through the same transaction.
>    Workhorse writes the task's rows in that transaction. No worker can see them yet, because they
>    are not committed.
> 3. **The commit.** The app server commits. The account row and the task become visible at the same
>    moment. PostgreSQL delivers the wake-up notification to listening workers only now, and a
>    worker claims the task.

Now take the same request, but a later statement fails after step 2. The app server rolls back.
PostgreSQL discards the account row and the task together. No worker ever sees the task, so no email
goes out for an account that does not exist.

Compare two separate commits. The app server commits `acc-7`, then its process dies before the
enqueue. The account exists, and nothing will ever send its email.

The rule: pass the open transaction to the enqueue call, and commit once. Each SDK below takes that
transaction in its own way.

<details>
<summary>Reference: what one enqueue writes</summary>

- One `enqueue_batch_v1` call writes `task`, optional `task_dependency` edges, `task_runtime` or a
  policy-selected terminal outcome, and acceptance events in the caller's transaction.
- `NOTIFY workhorse_tasks` is delivered at commit. It is coalesced to one notification per distinct
  queue that gained ready work.
- A batch holds at most 1,000 requests. Any invalid member rolls back the entire batch.
- No Workhorse client commits, rolls back, or closes a transaction, connection, or pool it was
  given.

More detail: [Task lifecycle: Batch write order](../architecture/lifecycle.md#batch-write-order) and [Task lifecycle: Batch validation](../architecture/lifecycle.md#batch-validation).

</details>

## With node-postgres

A Node.js app server handles the `acc-7` signup.

1. It borrows a `PoolClient` from its pool and runs `BEGIN`.
2. It inserts the account row and passes the same client to `Queue.enqueue`.
3. It runs `COMMIT`. If any step throws, it rolls back instead. Either way it releases the
   client.

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

`Queue.enqueueMany` takes the same transaction argument. A fan-out created by one request then
commits or rolls back as a unit with the row that caused it.

<details>
<summary>Reference: TypeScript transaction argument</summary>

| Method                                                   | Last argument                                                                 |
| -------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `enqueue(type, payload, options, transaction)`           | `transaction: Queryable`; defaults to the database the `Queue` was built with |
| `enqueueWithResult(type, payload, options, transaction)` | Same                                                                          |
| `enqueueMany(requests, transaction)`                     | Same                                                                          |
| `enqueueManyWithResults(requests, transaction)`          | Same                                                                          |

`Queryable` is the structural contract that `pg` `Pool` and `PoolClient` share: one
`query(text, values)` method.

More detail: [Overview: Connections and clients](../architecture/overview.md#connections-and-clients).

</details>

## With Psycopg

A Python app server handles the same signup.

1. It opens `connection.transaction()` and inserts the account row.
2. It enqueues through `Queue(connection)`, built on that same connection.
3. The `with` block ends. Psycopg commits both writes, or rolls both back if the block raised.

Python has no transaction argument. `Queue` binds the connection you give it, and the transaction
belongs to that connection. Open a transaction on the connection, enqueue through a `Queue` built
on the same connection, and the two writes share it:

```python
with connection.transaction():
    connection.execute("INSERT INTO account (id, email) VALUES (%s, %s)", (id, email))
    Queue(connection).enqueue("account.created", {"accountId": id})
```

If the block raises, Psycopg rolls back, and the task goes with your row.

A worker takes a connection pool, not a connection. Give `Worker` a Psycopg `ConnectionPool` whose
connections use autocommit mode. `AsyncWorker.from_psycopg` and `AsyncWorker.from_asyncpg` take the
matching async pools. The worker borrows a connection for each statement and returns it afterwards.
It also [reserves pool connections of its own](390-connection-pooling.md#how-do-i-budget-connections),
so size the pool for them.

Your enqueue code can borrow a connection from that same pool. Open the transaction on the borrowed
connection, and build the `Queue` on it as the example does. Autocommit and an explicit transaction
are not in conflict. `connection.transaction()` opens a real transaction block on an autocommit
connection.

<details>
<summary>Reference: Python clients and pools</summary>

| Python client              | Takes                                                              |
| -------------------------- | ------------------------------------------------------------------ |
| `Queue`                    | A caller-owned Psycopg connection                                  |
| `AsyncQueue`               | A Psycopg `AsyncConnection` or an asyncpg `Connection`             |
| `Worker`                   | A Psycopg `ConnectionPool` whose connections use `autocommit=True` |
| `AsyncWorker.from_psycopg` | A Psycopg `AsyncConnectionPool`                                    |
| `AsyncWorker.from_asyncpg` | An asyncpg `Pool`                                                  |

- The clients never call `commit`, `rollback`, or `close`.
- Unless `shared_heartbeats` is set, a worker reserves one pool connection for heartbeat rounds.
- The listener holds another pool connection while it listens.
- If a Psycopg heartbeat or listener connection lacks `autocommit=True`, the worker raises
  `ValueError`.

More detail: [Schema and SQL protocol: Pool connections](../architecture/schema-and-protocol.md#pool-connections).

</details>

## With pgx

A Go service handles the `acc-7` signup.

1. It begins a transaction on its pool.
2. It inserts the account row, wraps the transaction in an executor, and enqueues through a queue
   built on that executor.
3. It commits. If any step returns an error first, the deferred rollback discards both writes.

Go has no transaction argument either. An executor wraps whatever you already hold, and
`NewPGXExecutor` accepts a `pgx.Tx` as readily as a pool:

```go
func createAccount(ctx context.Context, pool *pgxpool.Pool, id, email string) error {
	tx, err := pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)

	if _, err := tx.Exec(ctx, "INSERT INTO account (id, email) VALUES ($1, $2)", id, email); err != nil {
		return err
	}
	queue := workhorse.NewQueue(workhorse.NewPGXExecutor(tx), "default")
	if _, err := queue.Enqueue(ctx, "account.created", map[string]any{"accountId": id}); err != nil {
		return err
	}
	return tx.Commit(ctx)
}
```

When any step fails, the function returns before `Commit`. The deferred `Rollback` then discards
the account row, and no task exists without it.

`NewSQLExecutor` does the same for the standard library, and accepts a `*sql.Tx`. Either way the
queue reads and writes through the handle you passed, so your commit covers the task.

<details>
<summary>Reference: Go executors</summary>

| Constructor      | Accepts                                |
| ---------------- | -------------------------------------- |
| `NewPGXExecutor` | `pgx.Tx`, `*pgx.Conn`, `*pgxpool.Pool` |
| `NewSQLExecutor` | `*sql.Tx`, `*sql.Conn`, `*sql.DB`      |

Both close the result rows they open. They never commit, roll back, or close a caller-owned
transaction, connection, pool, or database.

More detail: [Schema and SQL protocol: Module and executors](../architecture/schema-and-protocol.md#module-and-executors).

</details>

## With tokio-postgres

A Rust service handles the same signup.

1. It opens a transaction on its client.
2. It inserts the account row and enqueues through a queue built on that transaction.
3. It commits. If an error returns first, dropping the transaction rolls both writes back.

Rust has no transaction argument either. `Queue::new` accepts a `tokio_postgres` client or
transaction, or their `deadpool_postgres` counterparts. Pass it the transaction:

```rust
let transaction = client.transaction().await?;
transaction.execute("INSERT INTO account (id, email) VALUES ($1, $2)", &[&id, &email]).await?;
Queue::new(&transaction, "default")
    .enqueue("account.created", &json!({ "accountId": id }), EnqueueOptions::default())
    .await?;
transaction.commit().await?;
```

If an error returns before `commit`, dropping the transaction rolls it back, and the task goes
with your row.

<details>
<summary>Reference: Rust executors</summary>

The sealed `Executor` trait covers:

- `tokio_postgres::Client` and `tokio_postgres::Transaction`;
- `deadpool_postgres::Pool`, `deadpool_postgres::Object`, and `deadpool_postgres::Transaction`;
- a reference to any of them.

A transaction executor makes every call part of the caller's transaction. The client never
commits, rolls back, or closes what the caller owns.

More detail: [Schema and SQL protocol: Crate and executors](../architecture/schema-and-protocol.md#crate-and-executors).

</details>

## With pg

A Ruby service handles the same signup.

1. It opens a transaction block on its connection.
2. Inside the block, it inserts the account row and enqueues through a queue built on that
   transaction.
3. The block ends, and the gem commits both writes. If the block raises, it rolls both back.

Ruby has no transaction argument either. `Queue.new` accepts a `PG::Connection`, a
`ConnectionPool`, or the connection inside `transaction`. Pass it the transaction:

```ruby
connection.transaction do |transaction|
  transaction.exec_params("INSERT INTO account (id, email) VALUES ($1, $2)", [id, email])
  Stablemates::Workhorse::Queue.new(transaction).enqueue("account.created", {"accountId" => id})
end
```

If the block raises, the `pg` gem rolls the transaction back, and the task goes with your row.
A Rails application can pass an `ActiveRecordExecutor` instead, and the queue joins the open
Active Record transaction.

<details>
<summary>Reference: Ruby executors</summary>

- `Queue.new(executor, default_queue: "default")` accepts a `PG::Connection`, a `ConnectionPool` of
  them, or any object whose `with` yields a `PG::Connection`.
- `ActiveRecordExecutor.new(model)` runs statements on the connection the model holds. Inside a
  `transaction`, that is the connection holding the transaction.
- The Active Job adapter uses `ActiveRecordExecutor.new(ActiveRecord::Base)` when it receives no
  executor. Its enqueue joins the caller's transaction when `enqueue_after_transaction_commit` is
  false.

More detail: [Schema and SQL protocol: Active Job adapter](../architecture/schema-and-protocol.md#active-job-adapter).

</details>

## With an ORM provider

A TypeScript service that uses Drizzle handles the same signup.

1. It opens a transaction through Drizzle.
2. Inside it, the service inserts the account row through the ORM, and enqueues through a queue
   that the Workhorse adapter binds to that same transaction.
3. The callback returns, and Drizzle commits both writes. If the callback throws, Drizzle rolls
   both back.

If your TypeScript application talks to PostgreSQL through an ORM, use that ORM's Workhorse
package instead of managing a raw client next to it. Python, Go, Rust, and Ruby have no equivalent
package, so they pass their own connection or transaction as the sections above show.

Each provider wraps the database object you already own and exposes `forTransaction`. That method
returns a `Queue` bound to your open transaction. The provider never commits, rolls back, or closes
that transaction. Your ORM stays in charge, and Workhorse runs on the transaction's own connection.

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

If the transaction callback throws, the ORM rolls back, and the task disappears with your data.
If it commits, the task is durable and a worker can claim it.

<details>
<summary>Reference: ORM adapters</summary>

| Package                          | Factory                |
| -------------------------------- | ---------------------- |
| `@stablemates/workhorse-drizzle` | `createDrizzleAdapter` |
| `@stablemates/workhorse-prisma`  | `createPrismaAdapter`  |
| `@stablemates/workhorse-typeorm` | `createTypeOrmAdapter` |
| `@stablemates/workhorse-kysely`  | `createKyselyAdapter`  |
| `@stablemates/workhorse-knex`    | `createKnexAdapter`    |

Each adapter exposes `queue` and `admin`.

- `forTransaction(transaction)` returns a `Queue` bound to the caller's transaction.
- `adminForTransaction(transaction)` returns the matching `Admin`.
- Neither commits, rolls back, disconnects, or destroys the transaction.
- A failed statement throws an error that extends `QueryError`. It keeps `statement`, the original
  `cause`, and the SQLSTATE in `code`. Core uses that code to raise typed errors such as
  `EnqueueIdempotencyConflictError`.

More detail: [Overview: What an adapter must guarantee](../architecture/overview.md#what-an-adapter-must-guarantee).

</details>

## What the transaction covers

In the story, the commit made the `account.created` task durable together with `acc-7`. It did not
send the email. A worker sends it later, outside any application transaction. If that worker crashes
after sending and before completing, another worker sends it again. So the handler's external
effects still need their own protection, which [delivery guarantees](030-delivery-guarantees.md)
describe. The transaction covers durable acceptance only.

One more boundary: an adapter closes nothing it did not create. Your database, pool, or client
stays open until you close it yourself. You can also hand the adapter a `close` callback and call
`close` on the adapter.

<details>
<summary>Reference: resource ownership</summary>

- An adapter closes nothing it did not create.
- `WorkhorseAdapter.close()` invokes the configured `close` callback at most once, however many
  times it is called.
- Without a `close` callback, `close()` does nothing.

More detail: [Overview: What an adapter must guarantee](../architecture/overview.md#what-an-adapter-must-guarantee).

</details>

## Next

- [210-enqueue-idempotency.md](210-enqueue-idempotency.md) — stop a retried request from creating two tasks
- [030-delivery-guarantees.md](030-delivery-guarantees.md) — why the handler still needs idempotency
- [010-tasks-and-state.md](010-tasks-and-state.md) — what the committed row actually is

---

Exact adapter guarantees, error translation, and notification wiring:
[`architecture/overview.md`](../architecture/overview.md#what-an-adapter-must-guarantee).
