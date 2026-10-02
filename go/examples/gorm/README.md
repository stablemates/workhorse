# GORM transactional enqueue

Use the application's GORM transaction to accept a task beside its business row.
This is a recipe using Workhorse's existing `NewSQLExecutor` and `NewQueue`, not another adapter or Go module.

## Run the example

The fixture pins GORM `v1.31.2`, `gorm.io/driver/postgres` `v1.6.3`, and its actual driver, pgx `v5.11.0`.
The PostgreSQL dialector uses pgx through `database/sql`.
Install the Workhorse schema in a disposable application database before running the example.
Manage application tables through your application's migrations, not Workhorse's schema lifecycle.
For this example, create:

```sql
CREATE TABLE orders (id text PRIMARY KEY, email text NOT NULL);
```

From the repository root, supply that database URL and a new order ID:

```sh
WORKHORSE_DATABASE_URL=postgres://localhost/application \
  pnpm exec tsx scripts/with-env.ts go -C go run ./examples/gorm order-42 person@example.com
```

The command prints the committed task ID. Reusing the order ID fails on the primary key.
It neither installs the Workhorse schema nor runs a worker.
In a configured development checkout, use your checkout's database explicitly:

```sh
pnpm exec tsx scripts/with-env.ts sh -c \
  'WORKHORSE_DATABASE_URL="$DATABASE_URL_PRIMARY" go -C go run ./examples/gorm order-42 person@example.com'
```

The development database also needs the `orders` table and Workhorse schema first.
Never point the recipe or tests at production.

## Ownership and limits

`createOrder` enters `db.WithContext(ctx).Transaction` and calls `acceptOrder` with the callback's `tx`.
Business writes use `tx.Create`; enqueue adapts `tx.Statement.ConnPool` directly.
Return every error from the callback, including client-side payload validation errors.
Returning `nil` after a failed enqueue could commit a business row without its task.
The task ID is returned only after GORM reports a successful commit.

GORM owns begin, commit, rollback, savepoints, and connection return.
Workhorse does not open another connection or close the transaction or pool.
Construct each queue inside its transaction scope; never cache or reuse it afterward.
The executable closes its application pool at process exit, not through the executor.

Both `PrepareStmt: false` and `PrepareStmt: true` are covered.
The latter passes GORM's `*gorm.PreparedStmtTX` wrapper without unwrapping it.
Nested `Transaction` calls use GORM savepoints; keep `DisableNestedTransaction` disabled if you require that behavior.
Cancellation returns an error and the callback rolls back; do not recover by committing an aborted transaction.

Workhorse sends the generated PostgreSQL protocol directly through `QueryContext` with positional parameters.
Task writes do not pass through GORM model callbacks, associations, or its model SQL builder.
Connection-pool and driver wrappers can still intercept these raw calls.
Your business `Create` still runs normal GORM callbacks.
Keep Workhorse's schema outside `AutoMigrate`.
Other dialects, alternative PostgreSQL drivers, poolers, and untested version combinations are not proved by this fixture.

Run workers separately with a worker-owned pgx pool, as in `../dedicated-worker`.
Atomicity covers business data and durable task acceptance, not a later handler's external effects.

## Verification

```sh
WORKHORSE_REQUIRE_DATABASE=1 pnpm exec tsx scripts/with-env.ts \
  go -C go test -count=1 -v ./examples/gorm
```

The test refuses non-loopback targets and creates a per-process scratch database derived from `DATABASE_URL_TEST`.
It installs `sql/schema/current.sql` there and drops that database during cleanup.
It never resets or writes application data in the checkout's test database.
CI sets `WORKHORSE_REQUIRE_DATABASE=1` for `pnpm go:test`, which includes the example in its Go/PostgreSQL lane.

For both prepared-statement settings, the tests prove:

- Matching backend PID and transaction ID for the business write and SQL executor, plus the task row's transaction ID.
- A distinct observer sees neither row before commit, both after commit, and neither after callback rollback.
- An inner savepoint rollback removes its business row and task while the outer transaction can continue and commit.
- Pre-cancelled and blocked in-flight enqueue calls return errors and discard the business row.
- Returning a client-side enqueue rejection rolls back the recipe's business write.
- JSONB binds, UUID decoding, nullable reasons, and batch result ordering survive the pgx SQL driver and prepared wrapper.
- PostgreSQL SQLSTATE `P1001` retains structured conflict details; a raw driver error retains SQLSTATE `22012`.
- The executor makes no begin, commit, rollback, or close calls, and task writes invoke no GORM model callbacks.

The prepared-statement fixture also runs the actual executable against its scratch database.
The catalog calls this a documented recipe because its verified tier represents separate adapter packages.

See [the public GORM setup page](../../../site/content/docs/gorm.mdx),
[GORM transactions](https://gorm.io/docs/transactions.html), and
[GORM's PostgreSQL driver](https://gorm.io/docs/connecting_to_the_database.html#PostgreSQL).
