# Workhorse for Rust

The Rust SDK is under construction. [ADR 0074](../docs/decisions/0074-shape-the-rust-sdk-as-one-python-shaped-crate.md)
fixes its shape, and the Linear issues SM-877 through SM-885 implement it. Until they land, no crate
here is published and the public API is not stable. SM-877 has landed the `Queue` client, SM-883
the `Admin` client, SM-878 the `Worker` runtime, SM-885 the embedded dashboard backend, and SM-879
the durable `HandlerContext`.

## Target shape

The SDK is one crate rooted at this directory. Its library name is `workhorse`, and it follows the
Python SDK's surface on Tokio.

- `Queue` enqueues, cancels, signals, and synchronizes schedules, policies, budgets, and contracts.
  It takes an executor, so an open transaction makes the enqueue transactional.
- `Worker` takes a `deadpool_postgres::Pool`, registers typed handlers by task type, and runs them
  under a lease with a shared heartbeat connection.
- `HandlerContext` offers checkpoints, durable sleeps, signal and human waits, child tasks, and
  progress. PostgreSQL owns every durable decision.
- `Admin` lists, inspects, and repairs tasks, dead letters, waits, workers, and queues. Every
  control takes an `AdminAudit`.
- The `dashboard` feature adds an embedded dashboard backend. It is a `tower::Service` that axum,
  hyper, or any tower host mounts under its own path.
- `tracing` spans are always on. The `opentelemetry` feature adds metrics and trace propagation.

## Current state

The workspace in the repository-root `Cargo.toml` holds one crate. `rust/` builds the `workhorse`
package, the one crate ADR 0074 publishes.

- `Queue` in `src/queue.rs` and `Admin` in `src/admin.rs` are the ADR 0074 clients.
- `Worker` in `src/worker/` claims, runs, heartbeats, and settles tasks, and drains within a grace
  period. `src/telemetry.rs` holds its spans, metrics, and trace context.
- Every PostgreSQL call goes through the generated `src/sql_catalogue_generated.rs`. The worker's
  `LISTEN` and `UNLISTEN` are the only other statements.
- `HandlerContext` in `src/context.rs`, `src/waits.rs`, and `src/children.rs` gives a handler
  checkpoints, durable sleeps, signal and human waits, child tasks, and progress. A wait that has not
  resolved suspends the task, and the worker releases it without settling.

`Queue` follows the Python client's signatures where the ADR sketch is shorter. The policy and
budget sync methods take a namespace and a `prune` flag and return the stored rows. `cancel` takes an
optional requester, and `sync_contracts` takes the per-type contract map that the worker registers.

The `dashboard` feature compiles `src/dashboard/`. Its service embeds the browser bundle from
`rust/dashboard/`, which `pnpm dashboard-bundle:generate` writes. Its request schemas come from the
generated `src/dashboard/v1_generated.rs`, and its reads call the generated statement catalogue.
`rust/tests/dashboard_conformance.rs` runs the shared `dashboard/v1/conformance.json` fixture through
the service. `rust/tests/dashboard_http.rs` mounts it in an axum router.

The integration tests in `rust/tests/` load the shared `protocol/v1` fixtures.
[`PARITY.md`](PARITY.md) maps the durable operations to their PostgreSQL functions.

The PostgreSQL tests in `rust/tests/postgres.rs`, `rust/tests/enqueue_postgres.rs`,
`rust/tests/client_postgres.rs`, `rust/tests/admin_postgres.rs`, `rust/tests/worker_postgres.rs`,
`rust/tests/durable_postgres.rs`, and `rust/tests/protocol_conformance.rs` exercise the real
`workhorse` adapter. Each one creates a scratch database from `DATABASE_URL_TEST`, installs
`sql/schema/current.sql`, and drops the database afterward.
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
pnpm rust:package-check
pnpm rust:release-check
```

`pnpm rust:package-check` runs `cargo package` with verification. It then builds
`rust/release-consumer/main.rs` in a temporary project outside the workspace. That consumer depends
on the unpacked `.crate` archive, never on the checkout. The check fails when the archive exceeds
10 MB, or when a consumer without the `dashboard` feature resolves an HTTP crate. With
`DATABASE_URL_TEST` set, it enqueues one task into a scratch database and runs it through a
`Worker`. The check then reads back the succeeded outcome. A change to the public API
updates the consumer in the same commit. `pnpm rust:release-check` runs the gates and then this
check. CI packages only committed files; a local run may pass `--allow-dirty`.
