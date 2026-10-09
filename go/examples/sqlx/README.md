# Go sqlx transaction recipe

This example uses `github.com/jmoiron/sqlx`, the Go library, not Rust SQLx.
It uses the existing Workhorse `NewSQLExecutor`; it introduces no adapter package or SQL protocol.

## Pinned baseline and execution

The maintained proof uses sqlx v1.4.0, pgx stdlib v5.11.0, Go 1.26.9, and local PostgreSQL 18.6.
The dependency pins live in `go/go.mod` and `go/go.sum`.
Applications install sqlx themselves; it is not required by Workhorse's core source.

Use a disposable PostgreSQL database with the Workhorse schema already installed.
Apply the companion `go/examples/sqlc/schema.sql` business migration; both recipes use `recipe_order` for comparison.
From a configured checkout:

```sh
WORKHORSE_DATABASE_URL="$DISPOSABLE_DATABASE_URL" pnpm exec tsx scripts/with-env.ts \
  go -C go run ./examples/sqlx
WORKHORSE_REQUIRE_DATABASE=1 pnpm exec tsx scripts/with-env.ts \
  go -C go test -count=1 -v ./examples/sqlx
```

The CLI writes a fixed UUID and prints its committed task UUID. Use a fresh schema for each repeat.
The fixture creates and drops a dedicated scratch database and invokes the CLI too.
The existing `pnpm go:test` discovers this fixture through `./...`; there is no second integration CI suite.

## Borrow the underlying transaction

`database.BeginTxx` returns a `*sqlx.Tx` containing the underlying `*sql.Tx` as `tx.Tx`.
`writeOrder` uses `tx.NamedExecContext` for business SQL and `NewQueue(NewSQLExecutor(tx.Tx), "recipes")` for enqueue.
sqlx may bind names in business queries. Do not pass Workhorse's SQL through `Named`, `Rebind`, or a formatter.
The executor already sends PostgreSQL positional parameters through pgx stdlib.

The application owns commit, rollback, PostgreSQL savepoints, and database closure.
sqlx supplies no nested transaction abstraction here; the fixture exercises explicit nested savepoints.
Releasing a savepoint never commits the outer transaction.
Keep the context used by `BeginTxx` alive until the transaction ends: `database/sql` rolls back if that context is cancelled.
A separately cancelled in-flight statement can leave the transaction aborted or its connection unusable.
Rollback with the owner and start a fresh transaction; do not promise savepoint recovery after driver cancellation.

The fixture proves physical PID/transaction identity, independent invisibility, joint outcomes, ownership,
native JSONB/UUID/nullable values, batch order, structured SQLSTATE and typed Workhorse errors.
It covers savepoint recovery after an ordinary SQL error, pre-cancelled calls, a blocked real enqueue's cancellation,
fresh-transaction recovery, and application rollback on a client-side contract rejection.

Only pgx stdlib is tested. Other sqlx drivers, Rust SQLx, hosted providers, and poolers are outside this proof.
Run a dedicated worker with its own pgx pool, never a request's `*sql.Tx`.

See [the public Go sqlx appendix](https://workhorse.run/docs/go-sqlx) and
[transactional enqueue](https://workhorse.run/docs/enqueue) for the ownership contract.
