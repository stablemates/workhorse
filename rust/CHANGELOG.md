# Rust changelog

`workhorse` crate versions and release notes live here because the crate publishes to crates.io
from the release workflow's `crates-io` job, apart from the npm packages. It carries the version
the TypeScript packages, the Python distribution, and the Go module carry, because every tag names
one commit.

Workhorse is a public beta. Any 0.x minor release may change behaviour. From `0.1.0` the schema
upgrades in place: every release ships ordered migrations, and inside a major line a migration only
adds.

## 0.4.0 — 2026-09-23

The npm packages, Python distribution, Go module, and Rust crate release from one source commit.

Requires **schema v18**, Rust **1.89** or newer, and PostgreSQL **15** or newer.

**This is the first published `workhorse` crate.** Crates.io held only a `0.0.0` placeholder that
reserved the name. Add the crate with `cargo add workhorse@0.4`, and install or migrate the schema
with the schema tool of the same release. The crate never installs or migrates the schema itself.
[ADR 0074](../docs/decisions/0074-shape-the-rust-sdk-as-one-python-shaped-crate.md) shapes it as
one crate that follows the Python SDK's surface on Tokio.

- Add `Queue`, which enqueues, cancels, and signals tasks and synchronizes schedules, policies,
  budgets, and contracts. `Queue::new` accepts a `tokio_postgres` or `deadpool_postgres` client,
  pool, or transaction, and a caller's transaction makes the enqueue part of its commit.
- Add `Admin`, the operator client that lists, inspects, and repairs tasks, dead letters, waits,
  workers, and queues.
- Add `Worker`, which takes a `deadpool_postgres::Pool`, registers typed handlers by task type, and
  runs them under a lease. `run_worker_process` drains it within a grace period on SIGINT or
  SIGTERM.
- Add the durable `HandlerContext`: checkpoints, durable sleeps, signal and human waits, child
  tasks, and progress. PostgreSQL owns every durable decision, and an unresolved wait suspends the
  task.
- Add the `dashboard` feature, an embedded dashboard backend served as a `tower::Service` that axum,
  hyper, or any tower host mounts under its own path. A build without the feature compiles no HTTP
  dependency.
- Emit `tracing` spans always. The `opentelemetry` feature adds metrics and trace propagation.
- Verify `Queue::assert_compatible` and `Admin::assert_compatible` against the same schema window
  the other SDKs accept. A refusal is `workhorse::Error::Compatibility`, whose `code` names the
  reason.
- Run every `protocol/v1` fixture and the shared dashboard conformance fixture through the Rust
  adapters. No fixture is listed as unsupported.
- Verify the packaged crate before it publishes. The release check builds a consumer from the
  unpacked `.crate` archive outside the workspace, and runs one task through a `Worker` against a
  scratch database. Crates.io trusted publishing publishes the crate, so the release holds no
  long-lived token.
