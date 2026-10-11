# How do I enqueue a task in the same transaction as my data?

<!-- scenario-names: acc-7, account.created -->

Your application often writes data and enqueues a task for the same request. For example, it
inserts an account and enqueues a task that sends a welcome email. If the two writes commit
separately, one write can occur without the other. Then you get an account with no email, or an
email for an account that does not exist.

A task is a row in your own PostgreSQL database, so you can enqueue it in your open transaction.
Then PostgreSQL commits the account and the task together, or it rolls back both. You do not need
an outbox, a separate table of records that a second process sends.

## Enqueue a task in your transaction

**Example.** A signup request creates the account `acc-7`. It also enqueues an `account.created`
task.

1. The app server inserts the row for `acc-7` in an open transaction.
2. The app server enqueues `account.created` in the same transaction. No worker can see the task
   yet, because the transaction is not committed.
3. The app server commits. The account row and the task become visible at the same time.
4. PostgreSQL sends a wake-up notification to the workers that listen. A worker claims the task.

To enqueue in your transaction, give the open transaction to the enqueue call. Then commit one
time.

```ts
await client.query("BEGIN");
await client.query("INSERT INTO account (id, email) VALUES ($1, $2)", [id, email]);
await queue.enqueue("account.created", { accountId: id }, {}, client);
await client.query("COMMIT");
```

Each SDK takes the transaction in a different way. The sections below show each SDK.

<details>
<summary>Reference: what one enqueue writes</summary>

- One `enqueue_batch_v1` call writes `task`, optional `task_dependency` edges, `task_runtime` or a
  policy-selected terminal outcome, and acceptance events. It writes all of them in the transaction
  of the caller.
- PostgreSQL delivers `NOTIFY workhorse_tasks` at commit. Workhorse coalesces it to one
  notification for each distinct queue that gained ready work.
- A batch holds at most 1,000 requests.

More detail: [Task lifecycle: Batch write order](../architecture/lifecycle.md#batch-write-order) and [Task lifecycle: Batch validation](../architecture/lifecycle.md#batch-validation).

</details>

## Roll back the task with your data

**Example.** A signup request for `acc-7` does the same steps, but a later statement fails.

1. The app server inserts the row for `acc-7` and enqueues `account.created` in one transaction.
2. A later statement in the same transaction fails.
3. The app server rolls back the transaction. PostgreSQL discards the account row and the task
   together.
4. No worker sees the task, so no email goes to an account that does not exist.

If the app server uses two separate commits, the result is different. The app server commits
`acc-7`, and then its process stops before the enqueue. The account exists, but no task sends its
email.

Workhorse does not commit or roll back your transaction. Your code controls the transaction, so
your rollback also removes the task.

<details>
<summary>Reference: rollback and ownership</summary>

- Any invalid member rolls back the entire batch.
- No Workhorse client commits, rolls back, or closes a transaction, connection, or pool that it
  receives.

More detail: [Task lifecycle: Batch validation](../architecture/lifecycle.md#batch-validation) and [Overview: What an adapter must guarantee](../architecture/overview.md#what-an-adapter-must-guarantee).

</details>

## Pass a node-postgres transaction client

`Queue.enqueue` accepts your open transaction client as its last argument. Any object with a
pg-compatible `query` method can be this argument. Thus a `PoolClient` in an explicit transaction
is sufficient.

To enqueue in a node-postgres transaction:

1. Get a `PoolClient` from your pool.
2. Run `BEGIN` on the client.
3. Insert the account row through the client.
4. Give the same client to `Queue.enqueue`.
5. Run `COMMIT`. If a step throws an error, run `ROLLBACK` instead.
6. Release the client in all cases.

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

`Queue.enqueueMany` takes the same transaction argument. Thus a group of tasks from one request
commits or rolls back together with the row that caused it.

<details>
<summary>Reference: TypeScript transaction argument</summary>

| Method                                                   | Last argument                                                                 |
| -------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `enqueue(type, payload, options, transaction)`           | `transaction: Queryable`; defaults to the database the `Queue` was built with |
| `enqueueWithResult(type, payload, options, transaction)` | Same                                                                          |
| `enqueueMany(requests, transaction)`                     | Same                                                                          |
| `enqueueManyWithResults(requests, transaction)`          | Same                                                                          |

`Queryable` is the structural contract that `pg` `Pool` and `PoolClient` share. It has one
`query(text, values)` method.

More detail: [Overview: Connections and clients](../architecture/overview.md#connections-and-clients).

</details>

## Enqueue on a Psycopg connection in a transaction

Python has no transaction argument. `Queue` binds the connection that you give it, and the
transaction belongs to that connection. Thus a `Queue` on the same connection shares your
transaction.

To enqueue in a Psycopg transaction:

1. Open `connection.transaction()`.
2. Insert the account row on the connection.
3. Enqueue through `Queue(connection)`, on the same connection.

```python
with connection.transaction():
    connection.execute("INSERT INTO account (id, email) VALUES (%s, %s)", (id, email))
    Queue(connection).enqueue("account.created", {"accountId": id})
```

When the `with` block ends, Psycopg commits both writes. If the block raises an exception, Psycopg
rolls back both writes.

A worker takes a connection pool, not a connection.
Python's `Worker` takes a Psycopg `ConnectionPool` whose connections use autocommit mode.
`AsyncWorker.from_psycopg` and `AsyncWorker.from_asyncpg` take the matching async pools. The worker borrows a connection for each
statement and then returns it. The worker also [keeps some pool connections for
itself](390-connection-pooling.md#how-do-i-budget-connections). Make the pool large enough for these
connections.

Your enqueue code can borrow a connection from the same pool. Open the transaction on the borrowed
connection, and build the `Queue` on it, as the code shows. Autocommit mode does not prevent an
explicit transaction. `connection.transaction()` opens a real transaction block on an autocommit
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
- `Worker` borrows one connection for each statement and returns it after the statement.
- Unless `shared_heartbeats` is set, a worker reserves one pool connection for heartbeat rounds.
- The listener holds another pool connection while it listens.
- If a Psycopg heartbeat or listener connection lacks `autocommit=True`, the worker raises
  `ValueError`.

More detail: [Schema and SQL protocol: Synchronous worker](../architecture/schema-and-protocol.md#synchronous-worker) and [Schema and SQL protocol: Pool connections](../architecture/schema-and-protocol.md#pool-connections).

</details>

## Wrap a pgx transaction in an executor

Go has no transaction argument. An executor wraps the database handle that you already have.
`NewPGXExecutor` accepts a `pgx.Tx`, and it also accepts a pool.

To enqueue in a pgx transaction:

1. Start a transaction on your pool.
2. Insert the account row through the transaction.
3. Wrap the transaction with `NewPGXExecutor`.
4. Build a queue on the executor with `NewQueue`.
5. Enqueue the task through that queue.
6. Commit the transaction.

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

If a step fails, the function returns before `Commit`. Then the deferred `Rollback` discards the
account row and the task together.

`NewSQLExecutor` does the same for the standard library. It accepts a `*sql.Tx`. With both
executors, the queue reads and writes through the handle that you give it. Thus your commit
includes the task.

<details>
<summary>Reference: Go executors</summary>

| Constructor      | Accepts                                |
| ---------------- | -------------------------------------- |
| `NewPGXExecutor` | `pgx.Tx`, `*pgx.Conn`, `*pgxpool.Pool` |
| `NewSQLExecutor` | `*sql.Tx`, `*sql.Conn`, `*sql.DB`      |

Both executors close the result rows that they open. They never commit, roll back, or close a
caller-owned transaction, connection, pool, or database.

More detail: [Schema and SQL protocol: Module and executors](../architecture/schema-and-protocol.md#module-and-executors).

</details>

## Build a queue on a tokio-postgres transaction

Rust has no transaction argument. `Queue::new` accepts a `tokio_postgres` client or transaction. It
also accepts the matching `deadpool_postgres` types.

To enqueue in a tokio-postgres transaction:

1. Open a transaction on your client.
2. Insert the account row through the transaction.
3. Build a queue on the transaction with `Queue::new`.
4. Enqueue the task through that queue.
5. Commit the transaction.

```rust
let transaction = client.transaction().await?;
transaction.execute("INSERT INTO account (id, email) VALUES ($1, $2)", &[&id, &email]).await?;
Queue::new(&transaction, "default")
    .enqueue("account.created", &json!({ "accountId": id }), EnqueueOptions::default())
    .await?;
transaction.commit().await?;
```

If an error returns before `commit`, your code drops the transaction. The drop rolls back the
transaction, so the account row and the task disappear together.

<details>
<summary>Reference: Rust executors</summary>

The sealed `Executor` trait covers:

- `tokio_postgres::Client` and `tokio_postgres::Transaction`;
- `deadpool_postgres::Pool`, `deadpool_postgres::Object`, and `deadpool_postgres::Transaction`;
- a reference to any of them.

A transaction executor makes every call part of the transaction of the caller. The client never
commits, rolls back, or closes what the caller owns.

More detail: [Schema and SQL protocol: Crate and executors](../architecture/schema-and-protocol.md#crate-and-executors).

</details>

## Build a queue on a pg transaction in Ruby

Ruby has no transaction argument. `Queue.new` accepts a `PG::Connection`, a `ConnectionPool`, or
the connection in a `transaction` block.

To enqueue in a pg transaction:

1. Open a `transaction` block on your connection.
2. In the block, insert the account row.
3. Build a queue on the transaction connection with `Queue.new`.
4. Enqueue the task through that queue.

```ruby
connection.transaction do |transaction|
  transaction.exec_params("INSERT INTO account (id, email) VALUES ($1, $2)", [id, email])
  Stablemates::Workhorse::Queue.new(transaction).enqueue("account.created", {"accountId" => id})
end
```

When the block ends, the `pg` gem commits both writes. If the block raises an exception, the `pg`
gem rolls back the transaction, and the task disappears with your row.

A Rails application can give an `ActiveRecordExecutor` to the queue instead. Then the queue joins
the open Active Record transaction.

<details>
<summary>Reference: Ruby executors</summary>

- `Queue.new(executor, default_queue: "default")` accepts a `PG::Connection`, a `ConnectionPool` of
  them, or any object whose `with` yields a `PG::Connection`.
- `ActiveRecordExecutor.new(model)` runs statements on the connection that the model holds. Inside
  a `transaction`, that is the connection that holds the transaction.
- The Active Job adapter uses `ActiveRecordExecutor.new(ActiveRecord::Base)` when it receives no
  executor. Its enqueue joins the transaction of the caller when `enqueue_after_transaction_commit`
  is false.

More detail: [Schema and SQL protocol: Active Job adapter](../architecture/schema-and-protocol.md#active-job-adapter).

</details>

## Use the Workhorse package for your ORM

If your TypeScript application uses an ORM to access PostgreSQL, use the Workhorse package for that
ORM. Do not manage a separate raw client next to the ORM. Python, Go, Rust, and Ruby have no such
package. In these languages, give your own connection or transaction, as the sections above show.

Each provider wraps the database object that you already have. Its `forTransaction` method returns
a `Queue` bound to your open transaction. The provider does not commit, roll back, or close that
transaction. Your ORM controls the transaction, and Workhorse runs on the connection of the
transaction.

To enqueue in an ORM transaction:

1. Open a transaction through the ORM.
2. Insert the account row through the ORM.
3. Get a queue from `forTransaction` with the transaction.
4. Enqueue the task through that queue.
5. Return from the callback, so that the ORM commits both writes.

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

If the transaction callback throws an error, the ORM rolls back, and the task disappears with your
data. If the ORM commits, the task is durable, and a worker can claim it.

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

- `forTransaction(transaction)` returns a `Queue` bound to the transaction of the caller.
- `adminForTransaction(transaction)` returns the matching `Admin`.
- Neither commits, rolls back, disconnects, or destroys the transaction.
- A failed statement throws an error that extends `QueryError`. It keeps `statement`, the original
  `cause`, and the SQLSTATE in `code`. Core uses that code to raise typed errors such as
  `EnqueueIdempotencyConflictError`.

More detail: [Overview: What an adapter must guarantee](../architecture/overview.md#what-an-adapter-must-guarantee).

</details>

## Close the resources that you own

An adapter closes nothing that it did not create. Your database, pool, or client stays open until
you close it. You can also give the adapter a `close` callback. Then call `close` on the adapter to
close your resources.

<details>
<summary>Reference: resource ownership</summary>

- An adapter closes nothing that it did not create.
- `WorkhorseAdapter.close()` calls the configured `close` callback at most once, however many
  times it is called.
- Without a `close` callback, `close()` does nothing.

More detail: [Overview: What an adapter must guarantee](../architecture/overview.md#what-an-adapter-must-guarantee).

</details>

## Protect the effects of the handler separately

The transaction makes the task durable. It does not make the work of the handler occur one time
only.

**Example.** The signup for `acc-7` commits, and the `account.created` task is durable.

1. Later, a worker claims the task, outside any application transaction.
2. The worker sends the welcome email.
3. The worker stops before it completes the task.
4. After the lease of the first worker expires, another worker claims the task. It sends the
   email again.

The transaction covers only the durable acceptance of the task. The external effects of the
handler need their own protection. [Delivery guarantees](030-delivery-guarantees.md) describe this
protection.

<details>
<summary>Reference: delivery after commit</summary>

- Workhorse provides durable at-least-once execution. Enqueue idempotency does not make handler
  execution or external effects exactly once.
- A process can stop after an external effect but before completion commits.
- `recover_expired_v1` locks expired active rows. If the retry policy selects another attempt, it
  requeues the task, and another worker can run the handler again.

More detail: [Task lifecycle: Delivery semantics](../architecture/lifecycle.md#delivery-semantics) and [Task lifecycle: Expired-lease recovery](../architecture/lifecycle.md#expired-lease-recovery).

</details>

## Next

- [210-enqueue-idempotency.md](210-enqueue-idempotency.md) — prevent a repeated request from creating a second task
- [030-delivery-guarantees.md](030-delivery-guarantees.md) — learn why the handler still needs idempotency
- [010-tasks-and-state.md](010-tasks-and-state.md) — learn what the committed row is

---

The architecture reference states the exact adapter guarantees, the error translation, and the
notification wiring:
[`architecture/overview.md`](../architecture/overview.md#what-an-adapter-must-guarantee).
