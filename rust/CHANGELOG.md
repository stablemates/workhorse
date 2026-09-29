# Rust changelog

`workhorse` crate versions and release notes live here because the crate publishes to crates.io
from the release workflow's `crates-io` job, apart from the npm packages. It carries the version
the TypeScript packages, the Python distribution, and the Go module carry, because every tag names
one commit.

Workhorse is a public beta. Any 0.x minor release may change behaviour. From `0.1.0` the schema
upgrades in place: every release ships ordered migrations, and inside a major line a migration only
adds.

## 0.5.0 — 2026-09-28

The npm packages, Python distribution, Go module, and Rust crate release from one source commit.

Requires **schema v43**, Rust **1.89** or newer, and PostgreSQL **15** or newer.

**Breaking: a 0.4.x database upgrades offline, across one contract step.** Migration 0025 adds the
fast tier and SQL protocol version 5. It is a contract step shipped in a minor release, which
[ADR 0077](../docs/decisions/0077-add-a-fast-task-tier-that-records-one-outcome-row-per-task.md) §6
allows once. It narrows the protocol to exactly 5 and drops `fire_due_schedules_v1` and
`sync_schedule_definitions_v1` without a shim, so a 0.4.x process fails its compatibility check
against the new schema. `workhorse schema migrate` stops before a contract step. Upgrade in this
order:

1. Stop every worker and every producer.
2. Run `workhorse schema migrate`. It applies nothing past schema version 24 and reports the pending
   contract step.
3. Run `workhorse schema contract --yes`, which applies migration 0025 and leaves schema version 25.
4. Run `workhorse schema migrate` again. It applies migrations 0026 through 0044 and leaves schema
   version 43.
5. Start the processes from this release.

Every queue starts full-tier, so live tasks stay where they are and no history needs a backfill.

**Breaking: a process from this release refuses a schema below version 43.** The compatibility
floor moves from schema version 18 to 43 and the protocol floor from 1 to 5, because the SDK now
calls functions that migrations up to 0044 add.

**Add a fast task tier.** A fast-tier queue records one `fast_task_outcome` row per task instead of
the attempt and event history, and completes a batch and claims its refill in one statement. It
refuses dependencies, child tasks, concurrency keys, budgets, debounce, throttle, and concurrency or
rate-limit policies with SQLSTATE `P1007`. A queue moves tiers only while it is empty
([ADR 0077](../docs/decisions/0077-add-a-fast-task-tier-that-records-one-outcome-row-per-task.md)).

- Add `Admin::set_queue_tier` and `Admin::set_queue_history`, with the `QueueTier` and
  `QueueHistory` types. `set_queue_history` opts a fast-tier queue into attempt or claim history.
- Return `Error::FastTierUnsupported` for a `P1007` refusal, naming the queue, the feature, and the
  batch ordinal.
- Batch fast-tier completions with a fused refill claim. `WorkerOptions::cohorts` splits the slots
  into fixed shares that each complete and claim together. The default is 1 below a concurrency of 8
  and otherwise one cohort per eight slots, between 2 and 8, capped by the pool's spare connections.
- Govern the crate's public API as a checked surface, recorded in `api/rust.txt`
  ([ADR 0079](../docs/decisions/0079-govern-the-rust-api-as-an-eighth-surface.md)).
- Keep overlapping batched claims in flight, so a worker fills free slots while a claim is still
  running
  ([ADR 0076](../docs/decisions/0076-keep-overlapping-batched-claims-in-flight-to-fill-worker-slots.md)).
- Skip the notification claim delay while claims keep finding work.
- Resend a fenced write and the concurrency policy sync when PostgreSQL chooses them as a deadlock
  victim, up to three attempts. Inside a caller's transaction the original deadlock error is raised.
- Claim policy- and rate-limited tasks as a set, and shard the admission counters so claims on a
  governed queue no longer serialize
  ([ADR 0082](../docs/decisions/0082-shard-the-admission-counters.md)). A plain full-tier claim
  also costs less.
- Release dependents through a pending-prerequisite counter, and settle a parent whose child is
  already terminal when it is created. Migration 0032 repairs parents an earlier release left
  waiting. A full-tier enqueue batch with several invalid members can report a different member's
  error than before.
- Release a fused claim's row locks before they can deadlock
  ([ADR 0081](../docs/decisions/0081-release-a-fused-claim-lock-before-it-can-deadlock.md)).
- Add a Tier column to the embedded dashboard Queues page, and link a schedule's tasks to that
  schedule's queue on the Schedules page.

## 0.4.0 — 2026-09-23

The npm packages, Python distribution, Go module, and Rust crate release from one source commit.

Requires **schema v18**, Rust **1.89** or newer, and PostgreSQL **15** or newer.

**This is the first published `workhorse` crate.** Crates.io held only a `0.0.0` placeholder that
reserved the name. Add the crate with `cargo add workhorse`, and install or migrate the schema
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
