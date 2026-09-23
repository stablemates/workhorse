# Workhorse for Rust

The Rust queue client, operator client, and worker runtime for the Workhorse durable task queue for
PostgreSQL.

> **Public beta:** Workhorse is usable for evaluation and early production adoption. A 0.x minor
> release may change behaviour, so read the
> [changelog](https://github.com/stablemates/workhorse/blob/main/rust/CHANGELOG.md) before you
> upgrade. It will not ask you to recreate your database: migrations are ordered, and inside a major
> line a migration only adds, so a running deployment upgrades in place.

An AI agent should read [the Workhorse documentation index](https://workhorse.run/llms.txt) first.

## Install

```bash
cargo add workhorse@0.4
cargo add tokio --features macros,rt-multi-thread
cargo add serde_json
```

Install the schema once, as a deployment step. The application never installs or migrates it.

```bash
npx --package @stablemates/workhorse@0.4.0 workhorse schema install
```

The machine that runs that deployment step needs Node.js 22 or newer. The application itself needs
no Node.js.

Pin that version to the `workhorse` crate version the application depends on. The two are released
together from one commit, so the numbers match. A schema tool older than the application leaves a
schema the application refuses to start against.

Runtime processes verify compatibility instead of changing the schema. Call
`Queue::assert_compatible` or `Admin::assert_compatible` at startup. A refusal is
`workhorse::Error::Compatibility`, whose `code` names the reason.

Requires Rust 1.89 or newer and PostgreSQL 15 through 18.

## Run one task

```rust
use serde_json::{json, Value};
use workhorse::deadpool_postgres::tokio_postgres::NoTls;
use workhorse::deadpool_postgres::{Manager, Pool};
use workhorse::{Admin, EnqueueOptions, Queue, Worker, WorkerOptions};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let url = std::env::var("DATABASE_URL")?;
    let queue = Queue::connect(&url, "default").await?;
    let enqueued = queue
        .enqueue("email.welcome", &json!({ "to": "ada@example.com" }), EnqueueOptions::default())
        .await?;

    let pool = Pool::builder(Manager::new(url.parse()?, NoTls)).max_size(4).build()?;
    let worker = Worker::new(pool, WorkerOptions::default())?;
    worker.handle("email.welcome", |payload: Value, _context| async move {
        Ok(json!({ "deliveredTo": payload["to"] }))
    });
    worker.run_once().await?; // production uses run_worker_process(&worker)

    let admin = Admin::connect(&url).await?;
    if let Some(task) = admin.get_task(enqueued.task_id).await? {
        println!("{:?} {}", task.state, task.result.unwrap_or_default());
    }
    Ok(())
}
```

Handlers receive at-least-once delivery. Use stable provider idempotency keys around external
effects. `rust/examples/` also holds a transactional enqueue, a dedicated worker process, and an
orchestration of child tasks, signals, and human decisions.

## Package boundary

The crate's library name is `workhorse`, and it follows the Python SDK's surface on Tokio.

- `Queue` enqueues, cancels, signals, and synchronizes schedules, policies, budgets, and contracts.
  `Queue::new` accepts a `tokio_postgres` or `deadpool_postgres` client, pool, or transaction.
  A transaction makes the enqueue part of your commit.
- `Worker` takes a `deadpool_postgres::Pool`, registers typed handlers by task type, and runs them
  under a lease with a shared heartbeat connection. `run_worker_process` drains it on SIGINT or
  SIGTERM.
- `HandlerContext` offers checkpoints, durable sleeps, signal and human waits, child tasks, and
  progress. PostgreSQL owns every durable decision, and an unresolved wait suspends the task.
- `Admin` lists, inspects, and repairs tasks, dead letters, waits, workers, and queues.
- The `dashboard` feature adds an embedded dashboard backend. It is a `tower::Service` that axum,
  hyper, or any tower host mounts under its own path.
- `tracing` spans are always on. The `opentelemetry` feature adds metrics and trace propagation.

The crate never installs or migrates the shared PostgreSQL schema.

## Next

- Follow the [quickstart](https://workhorse.run/docs/quickstart) and deploy
  [worker processes](https://workhorse.run/docs/worker-processes).
- Read the [compatibility policy](https://workhorse.run/docs/compatibility).
- Use the [operations guide](https://workhorse.run/docs/operations) for telemetry, health, and
  maintenance.

## Development

### Current state

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
