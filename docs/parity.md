# Language feature parity

This is the authoritative per-language support matrix for the Workhorse SDKs, anchored to schema
version 47. It owns one question: which language can use which capability today. What each
capability does, and its exact limits, stay owned by [docs/features.md](features.md); this
document never restates them.

Statuses:

- **Supported.** Shipped in that language and covered by tests in this repository.
- **Planned.** Deliberately sequenced work with an open Plane work item. The work item owns the
  acceptance criteria; this matrix records the resulting language support.
- **Absent.** Not shipped and not scheduled. An Absent cell is a fact, not a commitment.

Two boundaries keep this matrix small:

- PostgreSQL owns accepted JSON values, lifecycle transitions, idempotency, retries, waits,
  fencing, and structured errors (see `protocol/README.md`). Behavior PostgreSQL owns cannot
  diverge between languages, so it has no row here. A language row exists only for behavior a
  client or worker runtime supplies itself.
- The operator surface — dashboard, standalone `workhorse` CLI, schema install and status — runs
  against the database and serves every language equally. It is listed once, not per language.

## Client (enqueue side)

| Capability                                 | TypeScript | Python    | Go      |
| ------------------------------------------ | ---------- | --------- | ------- |
| Transactional enqueue in a caller-owned tx | Supported  | Supported | Planned |
| Atomic batch enqueue                       | Supported  | Supported | Planned |
| Delayed enqueue (`runAt` / `run_at`)       | Supported  | Supported | Planned |
| Priority                                   | Supported  | Supported | Planned |
| Tags and max attempts                      | Supported  | Supported | Absent  |
| Persisted retry policies                   | Supported  | Supported | Absent  |
| Absolute deadlines and execution timeouts  | Supported  | Supported | Absent  |
| Enqueue idempotency                        | Supported  | Supported | Planned |
| Keyed debounce                             | Supported  | Supported | Planned |
| Keyed throttle                             | Supported  | Supported | Planned |
| Job dependencies with terminal policies    | Supported  | Supported | Planned |
| Concurrency keys                           | Supported  | Supported | Absent  |
| Recurring schedule definition sync         | Supported  | Supported | Planned |
| Payload and result contracts               | Supported  | Absent    | Absent  |
| Compatibility refusal before mutation      | Supported  | Supported | Planned |
| SQL protocol conformance fixtures executed | Supported  | Supported | Planned |

The TypeScript client is `@workhorse/core` (`Queue`); the Python client is `workhorse-pg`
(`Queue`/`AsyncQueue` over Psycopg and asyncpg); the Go module is reserved at `go/README.md`.
Python can define and synchronize recurring schedules, but only a worker fires them, so a
deployment enqueueing from Python still needs a TypeScript worker until [WH-214] ships.

## Worker runtime

Every worker row is the runtime's own responsibility above the SQL protocol: local validation,
handler dispatch, concurrency, heartbeats, polling or notifications, cancellation delivery,
telemetry, and graceful shutdown.

| Capability                                   | TypeScript | Python  | Go      |
| -------------------------------------------- | ---------- | ------- | ------- |
| Claiming and handler execution               | Supported  | Planned | Planned |
| Bounded worker concurrency                   | Supported  | Planned | Planned |
| Heartbeats, lease recovery, fenced ownership | Supported  | Planned | Planned |
| Cooperative cancellation delivery            | Supported  | Planned | Planned |
| Notification-assisted dispatch with polling  | Supported  | Planned | Planned |
| Durable checkpoints (handler context)        | Supported  | Planned | Planned |
| Durable timers (`sleep` / `sleepUntil`)      | Supported  | Planned | Planned |
| Signal and human-decision waits              | Supported  | Planned | Planned |
| Linked child fan-out and result join         | Supported  | Planned | Planned |
| Latest-value progress reporting              | Supported  | Absent  | Absent  |
| Batch handler delivery                       | Supported  | Planned | Planned |
| Schedule firing (in-process cron)            | Supported  | Absent  | Absent  |
| Worker fleet registration and remote pause   | Supported  | Absent  | Absent  |
| Graceful stop and signal drain               | Supported  | Planned | Planned |
| Retention maintenance participation          | Supported  | Absent  | Absent  |
| OpenTelemetry tracing and metrics            | Supported  | Planned | Planned |

The Planned worker columns reflect the acceptance criteria in [WH-214], [WH-221], and [WH-236].
Those work items cover individual and batch handlers, durable primitives, concurrency, heartbeats,
cancellation, telemetry, and graceful drain. A row starts Planned only when a Plane work item
commits to it. A cell claiming more than the work item scope is a bug in this document.

## Roadmap progress

| Deliverable                     | Plane work item | State   |
| ------------------------------- | --------------- | ------- |
| Synchronous Python worker       | [WH-214]        | Backlog |
| Asynchronous Python worker      | [WH-221]        | Backlog |
| Go transactional enqueue client | [WH-228]        | Backlog |
| Go worker and module examples   | [WH-236]        | Backlog |

The Plane work items own sequencing, blockers, and completion. Update this table when their state
changes, and update the capability matrices only when repository tests prove the new support.

## Operator reads and controls

| Capability                                  | TypeScript | Python | Go     |
| ------------------------------------------- | ---------- | ------ | ------ |
| Job lookup, listing, timeline, health reads | Supported  | Absent | Absent |
| Cancellation requests                       | Supported  | Absent | Absent |
| Queue pause, resume, and purge              | Supported  | Absent | Absent |
| Dead-letter listing and redrive             | Supported  | Absent | Absent |
| Checkpoint, wait, and human-decision reads  | Supported  | Absent | Absent |
| Durable operator worker pause               | Supported  | Absent | Absent |

These Absent cells are deliberate, not backlog: the standalone dashboard and the `workhorse` CLI
already provide every read and control here against any database, whatever language enqueued the
work. A language SDK grows one of these APIs only when an application needs it programmatically;
that need should arrive as its own Plane work item.

## Keeping this document honest

If a cell says Supported, tests in this repository must exercise that capability in that
language. The conformance fixtures under `protocol/v1/` are the intended enforcement point: the
TypeScript suite runs them through `scripts/verify-sql-protocol.ts`, and the Python suite runs
them through `python/tests/test_protocol_conformance.py`. A generated check in the style of
`typescript/core/test/support-matrix.test.ts` — which fails when `docs/compatibility.md`, CI, and
the package `engines` fields disagree — does not exist for this matrix yet. Until it does, any
change that ships or removes a language capability must update this file in the same commit,
exactly as behaviour changes must update the guide that describes them.

[WH-214]: https://app.plane.so/techprogress/browse/WH-214/
[WH-221]: https://app.plane.so/techprogress/browse/WH-221/
[WH-228]: https://app.plane.so/techprogress/browse/WH-228/
[WH-236]: https://app.plane.so/techprogress/browse/WH-236/
