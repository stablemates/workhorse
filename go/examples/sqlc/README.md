# sqlc transaction recipe

This is an application example, not a Workhorse adapter or a second SQL protocol.
sqlc generates only `recipe_order` queries. Workhorse keeps its existing generated protocol catalogue.

## Pinned baseline

- sqlc v1.31.1, using `sql_package: pgx/v5`.
- pgx v5.11.0, inherited from `go/go.mod`.
- Go 1.26.9 and PostgreSQL 18.6 in the local maintained proof.

`schema.sql`, `queries.sql`, and `sqlc.yaml` own the business-query source.
`generated/` is checked in and is never edited by hand.
From a configured checkout:

```sh
pnpm go:sqlc:generate
pnpm go:sqlc:check
WORKHORSE_REQUIRE_DATABASE=1 pnpm exec tsx scripts/with-env.ts \
  go -C go test -count=1 -v ./examples/sqlc
```

The generation commands use the official sqlc release binary, not a substitute or an unpinned installation.
The script pins the version and each supported platform's archive SHA256 from the official release metadata.
It verifies the archive and binary version, then generates in a temporary directory.
Check mode compares the exact file inventory and bytes without changing checked-in output.
Linux and macOS on amd64 and arm64 are supported by this generation command.
The verified archive cache lives under the operating system's temporary directory; a cold run needs GitHub access and `tar`.
The existing static CI lane checks generation once; the existing Go suite compiles and runs the fixture once per change.
sqlc is not an SDK runtime dependency.

## Run the executable

Use a disposable PostgreSQL database with the Workhorse schema already installed.
Apply `go/examples/sqlc/schema.sql` as its business migration, then run from the repository root:

```sh
WORKHORSE_DATABASE_URL="$DISPOSABLE_DATABASE_URL" pnpm exec tsx scripts/with-env.ts \
  go -C go run ./examples/sqlc
```

The CLI writes a fixed example UUID and prints the committed task UUID.
Run it once per fresh business schema; a duplicate order is an error, not a deduplication recipe.
The maintained fixture creates and drops its own scratch database instead of touching a developer's test database.

## Transaction boundary

`writeOrder` calls `queries.WithTx(tx).CreateOrder` and `NewQueue(NewPGXExecutor(tx), "recipes")` with the same `pgx.Tx`.
The caller owns begin, commit, rollback, savepoints, and pool shutdown.
`createOrder` returns every error before commit and uses an uncancelled cleanup context for rollback.
Return client-side contract failures too: they do not automatically abort PostgreSQL's transaction.
Never retain the queue or bound queries after the transaction ends.

The proof checks backend PID, current transaction identity, the task's `xmin`, and an independent observer.
It exercises joint commit/rollback, nested PostgreSQL savepoints, native UUID/JSONB/nullable text, ordered batches,
nullable enqueue reasons, structured database errors, core conflict translation, and lifecycle ownership.
A controlled scratch-only trigger blocks a real enqueue for cancellation; rollback removes the business row and task.
A fresh transaction then succeeds. Pre-cancelled calls are tested separately.
The fixture also runs the actual CLI and verifies its committed pair.

Only the pgx/v5 code generation mode is tested here, not sqlc's `database/sql` mode or custom type overrides.
This does not certify other drivers, generators, hosted providers, or poolers.
Run workers separately with their own pool; do not lend a request transaction to a worker.

See [the public sqlc appendix](https://workhorse.run/docs/sqlc) and
[transactional enqueue](https://workhorse.run/docs/enqueue) for the ownership contract.
