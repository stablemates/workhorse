# Language feature parity

This is the authoritative per-language support matrix for the Workhorse SDKs, anchored to schema
version 1. It owns one question: which language can use which capability today. What each
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
| Recurring schedule definition sync         | Supported  | Supported | Supported |
| Payload and result contracts               | Supported  | Absent    | Absent    |
| Compatibility refusal before mutation      | Supported  | Supported | Supported |
| SQL protocol conformance fixtures executed | Supported  | Supported | Supported |

The TypeScript client is `@workhorse-js/core` (`Queue`); the Python client is `workhorse-pg`
(`Queue`/`AsyncQueue` over Psycopg and asyncpg). The Go module's `Queue` supports transactional
single and batch enqueue over pgx and `database/sql`, including every stable enqueue option except
payload and result contracts. Go and Python can define and synchronize recurring schedules through
caller-owned executors. The Go test lane enqueues through each documented executor. Its release test
also runs a worker from a separate module that imports the public package. Compiled process tests
exercise signal drain and lease recovery after a kill. The Go worker provides
bounded concurrency, fair multi-queue claiming, notification-assisted dispatch with polling
fallback, ownership heartbeats, cancellation, durable checkpoints, durable timers, OpenTelemetry
tracing and metrics, structured logs, signal and human-decision waits, and graceful drain. Python's synchronous and asynchronous
workers provide bounded concurrency, fair multi-queue
claiming, ownership heartbeats, cancellation, durable checkpoints, durable timers, signal and
human-decision waits, schedule firing, telemetry, and graceful drain through one lifecycle core.
The Python release lane installs the built universal wheel and source distribution into clean
environments. It exercises both async driver extras and runs the lifecycle example through the
public package.
Go workers can fire the recurring definitions that Go clients synchronize. The standalone
dashboard reads the shared database, so a Go deployment does not need a TypeScript worker runtime.

## Worker runtime

Every worker row is the runtime's own responsibility above the SQL protocol: local validation,
handler dispatch, concurrency, heartbeats, polling or notifications, cancellation delivery,
telemetry, and graceful shutdown.

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

Python executes every shared worker fixture against the lifecycle core under
[WH-310]. `python/tests/test_async_worker.py` separately proves both async driver bridges, async
handlers, durable context replay, batch adaptation, native listeners, and drain through that same
core. Go executes every shared worker fixture against its public runtime under [WH-331].
PostgreSQL executes `protocol/v1/cron-occurrences.json`, which fixes the shared cron and timezone
semantics before any runtime fires a definition.

## Roadmap progress

| Deliverable                     | Plane work item | State     |
| ------------------------------- | --------------- | --------- |
| Synchronous Python worker       | [WH-214]        | In Review |
| Asynchronous Python worker      | [WH-312]        | In Review |
| Python schedule firing          | [WH-309]        | In Review |
| Python SDK release examples     | [WH-313]        | In Review |
| Go transactional enqueue client | [WH-228]        | In Review |
| Go worker and module examples   | [WH-236]        | In Review |
| Go schedule firing              | [WH-332]        | In Review |

The Plane work items own sequencing, blockers, and completion. Update this table when their state
changes, and update the capability matrices only when repository tests prove the new support.

## Operator reads and controls

| Capability                                 | TypeScript | Python    | Go        |
| ------------------------------------------ | ---------- | --------- | --------- |
| Job lookup, listing, and timeline          | Supported  | Absent    | Absent    |
| Queue health snapshot                      | Supported  | Supported | Supported |
| Cancellation requests                      | Supported  | Supported | Supported |
| Queue pause, resume, and purge             | Supported  | Absent    | Absent    |
| Dead-letter listing and redrive            | Supported  | Absent    | Absent    |
| Checkpoint, wait, and human-decision reads | Supported  | Absent    | Absent    |
| Durable operator worker pause              | Supported  | Absent    | Absent    |

The remaining Absent cells are deliberate, not backlog: the standalone dashboard and the
`workhorse` CLI already provide those reads and controls against any database, whatever language
enqueued the work. Cancellation is also application-shaped, so every queue client exposes it with
audit attribution. Another language API belongs here only when an application needs it
programmatically through its own Plane work item.

## Keeping this document honest

If a cell says Supported, tests in this repository must exercise that capability in that language.
The conformance fixtures under `protocol/v1/` are the intended enforcement point. The TypeScript
suite runs the SQL fixtures through `scripts/verify-sql-protocol.ts` and the runtime fixtures through
`Worker`. The Python suite runs the SQL fixtures through `python/tests/test_protocol_conformance.py`
and every runtime fixture through `python/tests/test_worker_runtime_conformance.py`.

`typescript/core/test/parity-matrix.test.ts` holds this file to that promise. It parses the three
tables above and compares them, cell for cell, against the registry in
`typescript/core/test/support/parity-capabilities.ts`. Every Supported cell must name a test file
in that language which exists and mentions the capability; every Absent cell must record why it is
absent. Changing a status in one place and not the other fails the check, so a capability cannot
ship, or quietly disappear, without this matrix moving with it.

That check binds the document to declared evidence, not to a proof of behaviour — no static check
can supply one. Naming a test file that never exercises the capability would satisfy it. The rule
this document states still governs: a cell says Supported because tests prove it, and the generated
check is what stops the two halves drifting apart between reviews.

[WH-214]: https://app.plane.so/techprogress/browse/WH-214/
[WH-221]: https://app.plane.so/techprogress/browse/WH-221/
[WH-228]: https://app.plane.so/techprogress/browse/WH-228/
[WH-236]: https://app.plane.so/techprogress/browse/WH-236/
[WH-309]: https://app.plane.so/techprogress/browse/WH-309/
[WH-310]: https://app.plane.so/techprogress/browse/WH-310/
[WH-311]: https://app.plane.so/techprogress/browse/WH-311/
[WH-312]: https://app.plane.so/techprogress/browse/WH-312/
[WH-313]: https://app.plane.so/techprogress/browse/WH-313/
[WH-318]: https://app.plane.so/techprogress/browse/WH-318/
[WH-331]: https://app.plane.so/techprogress/browse/WH-331/
[WH-332]: https://app.plane.so/techprogress/browse/WH-332/
[WH-353]: https://app.plane.so/techprogress/browse/WH-353/
