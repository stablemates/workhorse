# Rust workspace

The canonical Cargo workspace is rooted at `Cargo.toml` and contains the client crate in `rust/`,
the worker lifecycle crate in `rust/workhorse-worker/`, and durable context crate in
`rust/workhorse/`. The integration tests in `rust/tests/` load the shared `protocol/v1` fixtures.

The PostgreSQL tests in `rust/tests/postgres.rs` and the request, schedule, and contract test
exercise the real `workhorse-client` adapter. Each one creates a scratch database from
`DATABASE_URL_TEST`, installs `sql/schema/current.sql`, and drops the database afterward.
`pnpm db:sweep` finds any scratch database that a failed teardown leaves behind.

Without `DATABASE_URL_TEST` a local `pnpm rust:test` skips those tests and prints the reason.
`pnpm rust:integration` and any run with `CI` set fail instead. A database that is set but
unreachable always fails.

Interpreter and failure fixture execution remains Planned in the parity registry until the
corresponding public adapter operations are exposed. Runtime fixtures remain Planned until the
worker lifecycle and durable context adapters expose a fixture runner.

Run the scoped checks from the repository root:

```sh
pnpm rust:format:check
pnpm rust:clippy
pnpm rust:test
pnpm rust:integration
pnpm rust:release-check
```
