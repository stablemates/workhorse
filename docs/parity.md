# Language feature parity

This is the authoritative per-language support matrix for the Workhorse SDKs, anchored to schema
version 1. It owns one question: which language can use which capability today. What each
capability does, and its exact limits, stay owned by [docs/features.md](features.md); this
document never restates them.

Statuses:

- **Supported.** Shipped in that language and covered by tests in this repository.
- **Planned.** Deliberately sequenced work with an open Ontrack Issue. The Issue owns the
  acceptance criteria; this matrix records the resulting language support.
- **Absent.** Not shipped and not scheduled. An Absent cell is a fact, not a commitment.

Two boundaries keep this matrix small:

- PostgreSQL owns accepted JSON values, lifecycle transitions, idempotency, retries, waits,
  fencing, and structured errors (see `protocol/README.md`). Behavior PostgreSQL owns cannot
  diverge between languages, so it has no row here. A language row exists only for behavior a
  client or worker runtime supplies itself.
- PostgreSQL operator capabilities and public SDK reachability are separate tables below. This
  keeps a shared database capability from implying that every language exposes a matching client.

## Client (enqueue side)

<!-- BEGIN GENERATED PARITY CLIENT -->

| Capability                                 | TypeScript | Python    | Go        |
| ------------------------------------------ | ---------- | --------- | --------- |
| Transactional enqueue in a caller-owned tx | Supported  | Supported | Supported |
| Atomic batch enqueue                       | Supported  | Supported | Supported |
| Delayed enqueue (`runAt` / `run_at`)       | Supported  | Supported | Supported |
| Priority                                   | Supported  | Supported | Supported |
| Tags and max attempts                      | Supported  | Supported | Supported |
| Persisted retry policies                   | Supported  | Supported | Supported |
| Absolute deadlines and execution timeouts  | Supported  | Supported | Supported |
| Enqueue idempotency                        | Supported  | Supported | Supported |
| Keyed debounce                             | Supported  | Supported | Supported |
| Keyed throttle                             | Supported  | Supported | Supported |
| Job dependencies with terminal policies    | Supported  | Supported | Supported |
| Concurrency keys                           | Supported  | Supported | Supported |
| Concurrency policy management              | Supported  | Supported | Supported |
| Rate-limit policy management               | Supported  | Supported | Supported |
| Recurring schedule definition sync         | Supported  | Supported | Supported |
| Payload and result contracts               | Supported  | Supported | Supported |
| Compatibility refusal before mutation      | Supported  | Supported | Supported |
| Public startup schema compatibility check  | Supported  | Supported | Supported |
| SQL protocol conformance fixtures executed | Supported  | Supported | Supported |
| Enqueue trace-context propagation          | Supported  | Supported | Supported |

<!-- END GENERATED PARITY CLIENT -->

## Worker runtime

Every worker row is the runtime's own responsibility above the SQL protocol: local validation,
handler dispatch, concurrency, heartbeats, polling or notifications, cancellation delivery,
telemetry, and graceful shutdown.

<!-- BEGIN GENERATED PARITY WORKER -->

| Capability                                   | TypeScript | Python    | Go        |
| -------------------------------------------- | ---------- | --------- | --------- |
| Claiming and handler execution               | Supported  | Supported | Supported |
| Bounded worker concurrency                   | Supported  | Supported | Supported |
| Heartbeats, lease recovery, fenced ownership | Supported  | Supported | Supported |
| Cooperative cancellation delivery            | Supported  | Supported | Supported |
| Notification-assisted dispatch with polling  | Supported  | Supported | Supported |
| Durable checkpoints (handler context)        | Supported  | Supported | Supported |
| Durable timers (`sleep` / `sleepUntil`)      | Supported  | Supported | Supported |
| Signal and human-decision waits              | Supported  | Supported | Supported |
| Linked child fan-out and result join         | Supported  | Supported | Supported |
| Latest-value progress reporting              | Supported  | Supported | Supported |
| Batch handler delivery                       | Supported  | Supported | Supported |
| Schedule firing (database cron evaluation)   | Supported  | Supported | Supported |
| Worker fleet registration and remote pause   | Supported  | Supported | Supported |
| Graceful stop and signal drain               | Supported  | Supported | Supported |
| Retention maintenance participation          | Supported  | Supported | Supported |
| OpenTelemetry tracing and metrics            | Supported  | Supported | Supported |
| Shared runtime fixtures executed             | Supported  | Supported | Supported |

<!-- END GENERATED PARITY WORKER -->

Ontrack owns the SDK roadmap, sequencing, blockers, and completion state. This document changes only
when repository tests prove a capability has shipped or been withdrawn.

## Product operator capability

PostgreSQL implements every operator read and control. The standalone or embedded dashboard and
the `workhorse` CLI expose the subsets shown below against any database, whatever language
enqueued the work. That product capability does not vary by worker language.

Every Planned cell below must be Supported before 1.0.0
([WH-581](https://ontrack.sh/projects/WH/issues/WH-581)). Adding a command or a procedure later
would not break anything, so this is not a compatibility requirement; it is the point at which an
operator surface stops being excused as beta-incomplete. An operator should not have to change
tools mid-incident because worker pause is only in the browser and redrive is only in the
terminal.

<!-- BEGIN GENERATED PARITY PRODUCT -->

| Capability                                 | PostgreSQL | Dashboard         | CLI               |
| ------------------------------------------ | ---------- | ----------------- | ----------------- |
| Job lookup, listing, and timeline          | Supported  | Supported         | Supported         |
| Queue health snapshot                      | Supported  | Supported         | Supported         |
| Cancellation requests                      | Supported  | Supported         | Supported         |
| Queue pause and resume                     | Supported  | Supported         | Supported         |
| Queue purge                                | Supported  | Supported         | Supported         |
| Dead-letter listing                        | Supported  | Supported         | Supported         |
| Redrive                                    | Supported  | [Planned][WH-616] | Supported         |
| Checkpoint, wait, and human-decision reads | Supported  | Supported         | Supported         |
| Durable operator worker pause              | Supported  | Supported         | [Planned][WH-618] |

<!-- END GENERATED PARITY PRODUCT -->

## Public SDK operator surface

This table records the narrower fact of which language lets application code invoke an operation
through its own public SDK.

<!-- BEGIN GENERATED PARITY OPERATOR -->

| Capability                                 | TypeScript | Python    | Go        |
| ------------------------------------------ | ---------- | --------- | --------- |
| Job lookup, listing, and timeline          | Supported  | Supported | Supported |
| Queue health snapshot                      | Supported  | Supported | Supported |
| Cancellation requests                      | Supported  | Supported | Supported |
| Queue pause, resume, and purge             | Supported  | Supported | Supported |
| Dead-letter listing and redrive            | Supported  | Supported | Supported |
| Checkpoint, wait, and human-decision reads | Supported  | Supported | Supported |
| Durable operator worker pause              | Supported  | Supported | Supported |

<!-- END GENERATED PARITY OPERATOR -->

TypeScript and Go expose these methods through dedicated public `Admin` clients. Python provides
synchronous `Admin` over Psycopg and `AsyncAdmin` over Psycopg or asyncpg. Their embedded dashboards
call the same clients for shared operator reads and controls. Cancellation remains
application-shaped, so every queue client exposes it with audit attribution.

## Schema tooling is TypeScript-only, deliberately

Schema installation and migration ship in `@stablemates/workhorse` and nowhere else. That is a
decision, not a gap in the matrix, so no row above records it as Absent for Python and Go.

Two reasons hold it there. No component can own an automatic migration, because no component is a
singleton: the dashboard and every worker deploy on many nodes as part of an ordinary application
deploy, so a component that migrated itself would be many concurrent migrators rather than one
deliberate step. And `applySchemaMigrationPlan` is the most safety-critical code in this
repository — an advisory lock, a post-lock version guard, gap rejection, transaction-control
rejection, per-step atomic rollback, and a concurrent-migrator race that must be read as success.
One implementation of that is worth more than three filled cells
([ADR 0053](decisions/0053-start-migrations-at-0-1-0-and-keep-them-additive.md)).

A Python or Go deployment therefore runs the TypeScript CLI as a pipeline step, at the version its
own SDK declares, and verifies with `workhorse schema status --json` before starting. What every
language does ship is the startup check that reads the result: the "Public startup schema
compatibility check" row above is Supported everywhere, and it is what turns a missed migration
into a refused start rather than a corrupted write.

This boundary holds at 1.0.0, and the CLI and TUI hold it with the schema tooling
([WH-581](https://ontrack.sh/projects/WH/issues/WH-581)). What 1.0.0 promises is that every
language reaches the same operator capability through its own `Admin` client and refuses to start
against a schema it cannot speak, not that every language grows a second migration runner.

## Keeping this document honest

If a cell says Supported, tests in this repository must exercise that capability in that language.
The conformance fixtures under `protocol/v1/` are the intended enforcement point. The TypeScript
suite runs the SQL fixtures through `scripts/verify-sql-protocol.ts` and the runtime fixtures through
`Worker`. All three languages execute `protocol/v1/contracts.json`. The Python suite runs the SQL fixtures through `python/tests/test_protocol_conformance.py`
and every runtime fixture through `python/tests/test_worker_runtime_conformance.py`.

`scripts/generate-parity-tables.ts` renders every capability matrix from
`typescript/core/test/support/parity-capabilities.ts`. `pnpm parity:check` fails if the checked-in
document is stale. Every Supported cell must name an existing test file for that surface. The file
must match every evidence pattern. Every Absent cell must record why it is absent. Every Planned
cell must name an Ontrack Issue, whose link the generator also writes.

That check binds the document to declared evidence, not to a proof of behaviour — no static check
can supply one. Naming a test file that never exercises the capability would satisfy it. The rule
this document states still governs: a cell says Supported because tests prove it, and generation
stops the published view from becoming another source of truth.

<!-- BEGIN GENERATED PARITY ONTRACK LINKS -->

[WH-616]: https://ontrack.sh/projects/WH/issues/WH-616
[WH-618]: https://ontrack.sh/projects/WH/issues/WH-618

<!-- END GENERATED PARITY ONTRACK LINKS -->
