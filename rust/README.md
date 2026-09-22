# Rust workspace

The canonical Cargo workspace is rooted at `Cargo.toml` and contains the client crate in `rust/`,
the worker lifecycle crate in `rust/workhorse-worker/`, and durable context crate in
`rust/workhorse/`. The integration tests in `rust/tests/` load the shared `protocol/v1` fixtures.

The PostgreSQL tests in `rust/tests/postgres.rs`, `rust/tests/enqueue_postgres.rs`, and
`rust/tests/protocol_conformance.rs` exercise the real `workhorse-client` adapter. Each one creates a
scratch database from `DATABASE_URL_TEST`, installs `sql/schema/current.sql`, and drops the database afterward.
`pnpm db:sweep` finds any scratch database that a failed teardown leaves behind.

Without `DATABASE_URL_TEST` a local `pnpm rust:test` skips those tests and prints the reason.
`pnpm rust:integration` and any run with `CI` set fail instead. A database that is set but
unreachable always fails.

`rust/tests/protocol_conformance.rs` executes every `protocol/v1` fixture through the Rust
adapters. A fixture that the Rust lane cannot pass yet belongs on
`rust/tests/conformance/expected-unsupported.json` with the Issue that owns the gap. The runner fails
when an unlisted fixture does not pass, and when a listed fixture passes. A Rust Supported cell in
`docs/parity.md` cites passing fixtures or one test function that `pnpm rust:integration` runs.
`pnpm parity:check` rejects any other evidence.

Run the scoped checks from the repository root:

```sh
pnpm rust:format:check
pnpm rust:clippy
pnpm rust:test
pnpm rust:integration
pnpm rust:release-check
```
