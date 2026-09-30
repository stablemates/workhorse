# Language feature parity

This is the authoritative per-language support matrix for the Workhorse SDKs, anchored to schema
version 43. It owns one question: which language can use which capability today. What each
capability does, and its exact limits, stay owned by [docs/features.md](features.md); this
document never restates them.

Statuses:

- **Supported.** Shipped in that language and covered by tests in this repository.
- **Planned.** Deliberately sequenced work with an open Linear Issue. The Issue owns the
  acceptance criteria; this matrix records the resulting language support.
- **Absent.** Not shipped and not scheduled. An Absent cell is a fact, not a commitment.

Two boundaries keep this matrix small:

- PostgreSQL owns accepted JSON values, lifecycle transitions, idempotency, retries, waits,
  fencing, and structured errors (see `protocol/README.md`). Behavior PostgreSQL owns cannot
  diverge between languages, so it has no row here. A language row exists only for behavior a
  client or worker runtime supplies itself.
- PostgreSQL operator capabilities and public SDK reachability are separate tables below. This
  keeps a shared database capability from implying that every language exposes a matching client.

Ruby is the fifth SDK, shipped as the `stablemates-workhorse` gem ([ADR
0075](decisions/0075-shape-the-ruby-sdk-as-one-gem-with-an-active-job-adapter.md)). Its client, `Admin` client,
dashboard backend, and worker runtime ship today. Its durable handler context, fast task tier, and
batch delivery are Planned. The integer semantics below compare the other four SDKs.

## Client (enqueue side)

<!-- BEGIN GENERATED PARITY CLIENT -->

| Capability                                 | TypeScript | Python    | Go        | Rust      | Ruby      |
| ------------------------------------------ | ---------- | --------- | --------- | --------- | --------- |
| Transactional enqueue in a caller-owned tx | Supported  | Supported | Supported | Supported | Supported |
| Atomic batch enqueue                       | Supported  | Supported | Supported | Supported | Supported |
| Delayed enqueue (`runAt` / `run_at`)       | Supported  | Supported | Supported | Supported | Supported |
| Priority                                   | Supported  | Supported | Supported | Supported | Supported |
| Tags and max attempts                      | Supported  | Supported | Supported | Supported | Supported |
| Persisted retry policies                   | Supported  | Supported | Supported | Supported | Supported |
| Absolute deadlines and execution timeouts  | Supported  | Supported | Supported | Supported | Supported |
| Enqueue idempotency                        | Supported  | Supported | Supported | Supported | Supported |
| Keyed debounce                             | Supported  | Supported | Supported | Supported | Supported |
| Keyed throttle                             | Supported  | Supported | Supported | Supported | Supported |
| Task dependencies with terminal policies   | Supported  | Supported | Supported | Supported | Supported |
| Concurrency keys                           | Supported  | Supported | Supported | Supported | Supported |
| Concurrency policy management              | Supported  | Supported | Supported | Supported | Supported |
| Rate-limit policy management               | Supported  | Supported | Supported | Supported | Supported |
| Named budget management                    | Supported  | Supported | Supported | Supported | Supported |
| Recurring schedule definition sync         | Supported  | Supported | Supported | Supported | Supported |
| Payload and result contracts               | Supported  | Supported | Supported | Supported | Supported |
| Compatibility refusal before mutation      | Supported  | Supported | Supported | Supported | Supported |
| Public startup schema compatibility check  | Supported  | Supported | Supported | Supported | Supported |
| SQL protocol conformance fixtures executed | Supported  | Supported | Supported | Supported | Supported |
| Enqueue trace-context propagation          | Supported  | Supported | Supported | Supported | Supported |

<!-- END GENERATED PARITY CLIENT -->

## Worker runtime

Every worker row is the runtime's own responsibility above the SQL protocol: local validation,
handler dispatch, concurrency, heartbeats, polling or notifications, cancellation delivery,
telemetry, and graceful shutdown.

<!-- BEGIN GENERATED PARITY WORKER -->

| Capability                                                  | TypeScript | Python    | Go        | Rust      | Ruby              |
| ----------------------------------------------------------- | ---------- | --------- | --------- | --------- | ----------------- |
| Claiming and handler execution                              | Supported  | Supported | Supported | Supported | Supported         |
| Bounded worker concurrency                                  | Supported  | Supported | Supported | Supported | Supported         |
| Fast task tier with one outcome row per task                | Supported  | Supported | Supported | Supported | [Planned][SM-982] |
| Fused fast-tier completion and refill claim in slot cohorts | Supported  | Supported | Supported | Supported | [Planned][SM-982] |
| Unhandled task type released to its queue                   | Supported  | Supported | Supported | Supported | Supported         |
| Heartbeats, lease recovery, fenced ownership                | Supported  | Supported | Supported | Supported | Supported         |
| Cooperative cancellation delivery                           | Supported  | Supported | Supported | Supported | Supported         |
| Notification-assisted dispatch with polling                 | Supported  | Supported | Supported | Supported | Supported         |
| Durable checkpoints (handler context)                       | Supported  | Supported | Supported | Supported | [Planned][SM-981] |
| Durable timers (`sleep` / `sleepUntil`)                     | Supported  | Supported | Supported | Supported | [Planned][SM-981] |
| Signal and human-decision waits                             | Supported  | Supported | Supported | Supported | [Planned][SM-981] |
| Linked child fan-out and result join                        | Supported  | Supported | Supported | Supported | [Planned][SM-981] |
| Latest-value progress reporting                             | Supported  | Supported | Supported | Supported | [Planned][SM-981] |
| Batch handler delivery                                      | Supported  | Supported | Supported | Supported | [Planned][SM-982] |
| Schedule firing (database cron evaluation)                  | Supported  | Supported | Supported | Supported | Supported         |
| Worker fleet registration and remote pause                  | Supported  | Supported | Supported | Supported | Supported         |
| Graceful stop and signal drain                              | Supported  | Supported | Supported | Supported | Supported         |
| Retention maintenance participation                         | Supported  | Supported | Supported | Supported | Supported         |
| OpenTelemetry tracing and metrics                           | Supported  | Supported | Supported | Supported | Supported         |
| Shared runtime fixtures executed                            | Supported  | Supported | Supported | Supported | Supported         |

<!-- END GENERATED PARITY WORKER -->

## Active Job reachability

The Ruby column above records the native SDK. A Rails application can also reach Workhorse through
Active Job, and that path cannot express everything the native SDK can. This table records which
capabilities an Active Job job reaches, by the job format ADR 0075 defines. A default job carries
Active Job's own serialization under the `active_job` task type. A typed job declares a task type
and carries one JSON `Hash`, so any SDK can enqueue or handle it.

- **Native only.** Active Job has no vocabulary for the capability. A caller reaches it through the
  native Ruby SDK.
- **Payload only.** The typed job's payload is the task's payload, so a payload contract applies.
  A result contract does not, because the adapter stores no result for either format.

<!-- BEGIN GENERATED PARITY ACTIVE JOB -->

| Capability                                   | Default job       | Typed job                       |
| -------------------------------------------- | ----------------- | ------------------------------- |
| Transactional enqueue in a caller-owned tx   | [Planned][SM-902] | [Planned][SM-902]               |
| Atomic batch enqueue                         | [Planned][SM-902] | [Planned][SM-902]               |
| Delayed enqueue (`runAt` / `run_at`)         | [Planned][SM-902] | [Planned][SM-902]               |
| Priority                                     | [Planned][SM-902] | [Planned][SM-902]               |
| Tags and max attempts                        | [Planned][SM-902] | [Planned][SM-902]               |
| Concurrency keys                             | [Planned][SM-902] | [Planned][SM-902]               |
| Enqueue trace-context propagation            | [Planned][SM-902] | [Planned][SM-902]               |
| Claiming and handler execution               | [Planned][SM-902] | [Planned][SM-902]               |
| Bounded worker concurrency                   | [Planned][SM-902] | [Planned][SM-902]               |
| Heartbeats, lease recovery, fenced ownership | [Planned][SM-902] | [Planned][SM-902]               |
| Graceful stop and signal drain               | [Planned][SM-902] | [Planned][SM-902]               |
| Payload and result contracts                 | Native only       | Payload only, [Planned][SM-902] |
| Persisted retry policies                     | Native only       | Native only                     |
| Absolute deadlines and execution timeouts    | Native only       | Native only                     |
| Enqueue idempotency                          | Native only       | Native only                     |
| Keyed debounce                               | Native only       | Native only                     |
| Keyed throttle                               | Native only       | Native only                     |
| Task dependencies with terminal policies     | Native only       | Native only                     |
| Recurring schedule definition sync           | Native only       | Native only                     |
| Cooperative cancellation delivery            | Native only       | Native only                     |
| Durable checkpoints (handler context)        | Native only       | Native only                     |
| Durable timers (`sleep` / `sleepUntil`)      | Native only       | Native only                     |
| Signal and human-decision waits              | Native only       | Native only                     |
| Linked child fan-out and result join         | Native only       | Native only                     |
| Latest-value progress reporting              | Native only       | Native only                     |
| Batch handler delivery                       | Native only       | Native only                     |

<!-- END GENERATED PARITY ACTIVE JOB -->

Durable execution stays native-only for both formats. Checkpoints, timers, waits, child fan-out,
progress, and batch delivery need a handler context, and `perform` never receives one. An Active
Job cell can be Supported only while the native Ruby cell for the same capability is Supported.

## Worker runtime defaults

A capability row answers whether a language can do something. It says nothing about what that
language does when the caller configures nothing, and that is the behavior an operator actually
runs. Five runtimes can agree on every row above and still drain, poll, and retry differently out
of the box.

The table below is the whole list. The Ruby dispatch cohorts stay Planned until the Ruby fast task
tier ships. A default differs only where the host language forces it, which
[ADR 0072](decisions/0072-converge-the-worker-runtime-defaults.md) records as the rule. One row
differs today, and the reason follows the table.

<!-- BEGIN GENERATED PARITY DEFAULTS -->

| Setting                                 | TypeScript                                                | Python                                                    | Go                                                        | Rust                                                      | Ruby                                |
| --------------------------------------- | --------------------------------------------------------- | --------------------------------------------------------- | --------------------------------------------------------- | --------------------------------------------------------- | ----------------------------------- |
| Worker concurrency                      | 1                                                         | 1                                                         | 1                                                         | 1                                                         | 1                                   |
| Lease duration                          | 30000 ms                                                  | 30000 ms                                                  | 30000 ms                                                  | 30000 ms                                                  | 30000 ms                            |
| Heartbeat interval                      | Lease duration / 3                                        | Lease duration / 3                                        | Lease duration / 3                                        | Lease duration / 3                                        | Lease duration / 3                  |
| Claim poll interval (subscription live) | 5000 ms                                                   | 5000 ms                                                   | 5000 ms                                                   | 5000 ms                                                   | 5000 ms                             |
| Claim poll interval (polling only)      | 250 ms                                                    | 250 ms                                                    | 250 ms                                                    | 250 ms                                                    | 250 ms                              |
| Empty-claim backoff ceiling             | 5000 ms                                                   | 5000 ms                                                   | 5000 ms                                                   | 5000 ms                                                   | 5000 ms                             |
| Maintenance tick interval               | 1000 ms                                                   | 1000 ms                                                   | 1000 ms                                                   | 1000 ms                                                   | 1000 ms                             |
| Maintenance routine offer interval      | 60000 ms                                                  | 60000 ms                                                  | 60000 ms                                                  | 60000 ms                                                  | 60000 ms                            |
| Worker registry interval                | 5000 ms                                                   | 5000 ms                                                   | 5000 ms                                                   | 5000 ms                                                   | 5000 ms                             |
| Schedule catch-up limit                 | 100                                                       | 100                                                       | 100                                                       | 100                                                       | 100                                 |
| Dispatch cohorts                        | 1 below concurrency 8, else concurrency / 8 within 2 to 8 | 1 below concurrency 8, else concurrency / 8 within 2 to 8 | 1 below concurrency 8, else concurrency / 8 within 2 to 8 | 1 below concurrency 8, else concurrency / 8 within 2 to 8 | [Planned][SM-982]                   |
| Shutdown grace, then                    | 25000 ms, then exit the process                           | 25000 ms, then exit the process                           | 25000 ms, then abandon the handlers                       | 25000 ms, then abandon the handlers                       | 25000 ms, then abandon the handlers |
| Handler retry delay override            | `retryDelayMs`, unset                                     | `retry_delay_ms`, unset                                   | `RetryDelay`, unset                                       | `retry_delay`, unset                                      | `retry_delay`, unset                |

<!-- END GENERATED PARITY DEFAULTS -->

Three rows carry a condition the setting name alone cannot.

- **Claim poll interval.** A worker claims on one of two schedules. While its `LISTEN` subscription
  is live, a notification wakes it, so polling is only a fallback and the worker waits the ceiling
  between empty claims. A worker that cannot subscribe, because a connection pooler forbids
  `LISTEN` or the caller asked for polling only, starts at 250 ms and doubles toward that same
  ceiling. Most deployments therefore never use the shorter interval.
- **Dispatch cohorts.** A worker splits its slots into cohorts so fused fast-tier completions do
  not run in lockstep. The quotient rounds up, and a worker that knows its pool size caps the
  default at the connections left after its listener and heartbeat connection. An explicit
  cohort count is never capped.
- **Maintenance routine offer interval.** All five tick maintenance every 1000 ms, which bounds
  dispatch latency. The slower retention routines keep their own minute, because PostgreSQL owns
  the global due decision and a faster offer only adds rejected calls.

The shutdown deadline agrees at 25000 ms, and it sits under the 30 second termination grace a
container platform gives a process by default. What follows that deadline cannot agree, and it is
the one accepted exception.

A TypeScript or Python worker owns a process, so its deadline ends that process. A Go, Rust, or Ruby
`Worker` runs inside a caller's process, and a library that ends someone else's process is wrong. Its deadline
cancels the handlers, gives them one short window to unwind, then stops renewing the leases of
whatever still runs. It returns `ErrShutdownIncomplete` in Go or `Error::ShutdownIncomplete` in
Rust, and raises `ShutdownIncompleteError` in Ruby. The caller decides whether to exit.

PostgreSQL sees the same thing either way. An abandoned handler holds a lease no one renews, so
`recover_expired_telemetry_v1` recovers its task exactly as it recovers the task of a process that
exited at its own deadline. What differs is what the handler observes: a Go, Rust, or Ruby handler
observes cancellation, where a TypeScript or Python handler observes termination.

The retry delay override sends one attempt's delay to `fail_v1` in place of the persisted policy's
choice. All five SDKs carry it and all five leave it unset, so the persisted retry policy chooses
every delay until a caller says otherwise.

## Integer semantics

PostgreSQL stores a `jsonb` number at full precision, but the four SDKs do not read one the same
way. Python decodes a JSON integer as a Python `int`, which is unbounded. Rust's `serde_json` holds
an integer exactly within the signed and unsigned 64-bit ranges. TypeScript and Go decode
it as an IEEE-754 double, which holds integers exactly only up to 2^53 - 1.

So a payload, result, checkpoint, or progress value that carries an integer larger than
9007199254740991 in magnitude is not portable. Enqueued from Python and handled in Python, it
survives, and a Rust worker keeps it while it fits in 64 bits. Enqueued from Python and handled
by a TypeScript or Go worker, it arrives rounded: the worker never sees the value the caller sent,
and never reports an error.

Workhorse does not reject such a value, because PostgreSQL accepts it and some languages read it
correctly. Send an identifier beyond that bound as a string instead. Within the bound every SDK
round-trips an integer exactly, and `typescript/core/test/json-integers.test.ts`,
`python/tests/test_json_integers.py`, and `go/json_integers_test.go` hold those languages to that.

Linear owns the SDK roadmap, sequencing, blockers, and completion state in the `stablemates`
workspace, `SM` team, and `workhorse` project. This document changes only
when repository tests prove a capability has shipped or been withdrawn.

## Product operator capability

PostgreSQL implements every operator read and control. The standalone or embedded dashboard and
the `workhorse` CLI expose the subsets shown below against any database, whatever language
enqueued the work. That product capability does not vary by worker language.

Every Planned cell below must be Supported before 1.0.0
(WH-581). Adding a command or a procedure later
would not break anything, so this is not a compatibility requirement; it is the point at which an
operator surface stops being excused as beta-incomplete. An operator should not have to change
tools mid-incident because one action is only in the browser. The table below now meets that bar;
the rule stands for any capability added after it.

<!-- BEGIN GENERATED PARITY PRODUCT -->

| Capability                                 | PostgreSQL | Dashboard | CLI       |
| ------------------------------------------ | ---------- | --------- | --------- |
| Task lookup, listing, and timeline         | Supported  | Supported | Supported |
| Queue health snapshot                      | Supported  | Supported | Supported |
| Cancellation requests                      | Supported  | Supported | Supported |
| Queue pause and resume                     | Supported  | Supported | Supported |
| Queue purge                                | Supported  | Supported | Supported |
| Dead-letter listing                        | Supported  | Supported | Supported |
| Redrive                                    | Supported  | Supported | Supported |
| Checkpoint, wait, and human-decision reads | Supported  | Supported | Supported |
| Durable operator worker pause              | Supported  | Supported | Supported |

<!-- END GENERATED PARITY PRODUCT -->

## Public SDK operator surface

This table records the narrower fact of which language lets application code invoke an operation
through its own public SDK.

<!-- BEGIN GENERATED PARITY OPERATOR -->

| Capability                                 | TypeScript | Python    | Go        | Rust      | Ruby      |
| ------------------------------------------ | ---------- | --------- | --------- | --------- | --------- |
| Task lookup, listing, and timeline         | Supported  | Supported | Supported | Supported | Supported |
| Queue health snapshot                      | Supported  | Supported | Supported | Supported | Supported |
| Cancellation requests                      | Supported  | Supported | Supported | Supported | Supported |
| Queue pause, resume, and purge             | Supported  | Supported | Supported | Supported | Supported |
| Dead-letter listing and redrive            | Supported  | Supported | Supported | Supported | Supported |
| Checkpoint, wait, and human-decision reads | Supported  | Supported | Supported | Supported | Supported |
| Durable operator worker pause              | Supported  | Supported | Supported | Supported | Supported |
| Embedded dashboard backend                 | Supported  | Supported | Supported | Supported | Supported |

<!-- END GENERATED PARITY OPERATOR -->

TypeScript, Go, Rust, and Ruby expose these methods through dedicated public `Admin` clients. Python
provides synchronous `Admin` over Psycopg and `AsyncAdmin` over Psycopg or asyncpg. Their embedded
dashboards call the same clients for shared operator reads and controls. Cancellation remains
application-shaped, so every queue client exposes it with audit attribution.

The embedded dashboard backend row records which language can serve the dashboard from its own HTTP
server ([ADR 0029](decisions/0029-embeddable-dashboard-backends.md)). A cell is Supported only when
that backend passes the shared `dashboard/v1` HTTP fixtures. [ADR
0074](decisions/0074-shape-the-rust-sdk-as-one-python-shaped-crate.md) gives Rust a `tower::Service`
backend behind the `dashboard` feature. Ruby serves it as a Rack application that a Rails route or
`Rack::Builder#map` mounts.

## Schema tooling is TypeScript-only, deliberately

Schema installation and migration ship in `@stablemates/workhorse` and nowhere else. That is a
decision, not a gap in the matrix, so no row above records it as Absent for Python, Go, and Rust.

Two reasons hold it there. No component can own an automatic migration, because no component is a
singleton: the dashboard and every worker deploy on many nodes as part of an ordinary application
deploy, so a component that migrated itself would be many concurrent migrators rather than one
deliberate step. And `applySchemaMigrationPlan` is the most safety-critical code in this
repository — an advisory lock, a post-lock version guard, gap rejection, transaction-control
rejection, per-step atomic rollback, and a concurrent-migrator race that must be read as success.
One implementation of that is worth more than four filled cells
([ADR 0053](decisions/0053-start-migrations-at-0-1-0-and-keep-them-additive.md)).

A Python, Go, or Rust deployment therefore runs the TypeScript CLI as a pipeline step, at the version its
own SDK declares, and verifies with `workhorse schema status --json` before starting. What every
language does ship is the startup check that reads the result: the "Public startup schema
compatibility check" row above is Supported everywhere, and it is what turns a missed migration
into a refused start rather than a corrupted write.

This boundary holds at 1.0.0, and the CLI and TUI hold it with the schema tooling
(WH-581). What 1.0.0 promises is that every
language reaches the same operator capability through its own `Admin` client and refuses to start
against a schema it cannot speak, not that every language grows a second migration runner.

## Keeping this document honest

If a cell says Supported, tests in this repository must exercise that capability in that language.
The conformance fixtures under `protocol/v1/` are the intended enforcement point. The TypeScript
suite runs the SQL fixtures through `scripts/verify-sql-protocol.ts` and the runtime fixtures through
`Worker`. All four languages execute `protocol/v1/contracts.json`. The Python suite runs the SQL
fixtures through `python/tests/test_protocol_conformance.py` and every runtime fixture through
`python/tests/test_worker_runtime_conformance.py`. The Rust suite runs every `protocol/v1` fixture
category through `rust/tests/protocol_conformance.rs`, and
`rust/tests/conformance/expected-unsupported.json` lists no exception. The Ruby suite runs every
`protocol/v1` fixture through `ruby/spec/conformance/protocol_conformance_spec.rb`.
`ruby/spec/conformance/expected-unsupported.json` lists each fixture the Ruby SDK cannot pass yet,
with the Issue that owns it.

`scripts/generate-parity-tables.ts` renders every capability matrix from
`typescript/core/test/support/parity-capabilities.ts`. `pnpm parity:check` fails if the checked-in
document is stale. Every Supported cell must name an existing test file for that surface. The file
must match every evidence pattern. Every Absent cell must record why it is absent. Every Planned
cell must name a Linear `SM-*` issue, whose link the generator also writes.

A Rust Supported cell cites executed evidence instead of a pattern in a test file. It names either
`protocol/v1` fixtures or one test function in a file that `pnpm rust:integration` runs. The Rust
runner in `rust/tests/protocol_conformance.rs` executes every fixture. It fails on a fixture that
neither passes nor appears in `rust/tests/conformance/expected-unsupported.json`. `pnpm parity:check`
fails when a cited fixture does not exist or the list still holds it. It also fails when the cited
file is not in that script or has no test function by that name. That script requires a database,
so the named test cannot skip there.

A Ruby Supported cell follows the same rule. It names either `protocol/v1` fixtures or one example
in a `ruby/spec` file that `pnpm ruby:test` runs. The Ruby runner fails on a fixture that neither
passes nor appears on its expected-unsupported list. It also fails on a listed fixture that passes,
so a gap closes by removing its entry. `pnpm parity:check` fails when a cited fixture does not
exist or the list still holds it. It also fails when no `ruby/spec` file by that name exists or the
file has no example by that name. CI runs that suite with `WORKHORSE_REQUIRE_DATABASE=1`, so the
named example cannot skip there. The same check covers the Active Job table.

That check binds the document to declared evidence, not to a proof of behaviour — no static check
can supply one. Naming a test file that never exercises the capability would satisfy it. The rule
this document states still governs: a cell says Supported because tests prove it, and generation
stops the published view from becoming another source of truth.

<!-- BEGIN GENERATED PARITY LINEAR LINKS -->

[SM-902]: https://linear.app/stablemates/issue/SM-902
[SM-981]: https://linear.app/stablemates/issue/SM-981
[SM-982]: https://linear.app/stablemates/issue/SM-982

<!-- END GENERATED PARITY LINEAR LINKS -->
