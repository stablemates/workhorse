# Language feature parity

This is the authoritative per-language support matrix for the Workhorse SDKs, anchored to schema
version 46. It owns one question: which language can use which capability today. What each
capability does, and its exact limits, stay owned by [docs/features.md](features.md); this
document never restates them.

Statuses:

- **Supported.** Shipped in that language and covered by tests in this repository.
- **Planned.** Deliberately sequenced work with a Linear issue. The Python worker SDK is
  WOR-76 and WOR-77; the Go client and worker SDKs are WOR-78 and WOR-79. All four are
  postponed behind the launch polish backlog (WOR-254).
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
| Priority, tags, max attempts               | Supported  | Supported | Planned |
| Persisted retry policies                   | Supported  | Supported | Planned |
| Absolute deadlines and execution timeouts  | Supported  | Supported | Planned |
| Enqueue idempotency                        | Supported  | Supported | Planned |
| Keyed debounce                             | Supported  | Supported | Planned |
| Keyed throttle                             | Supported  | Supported | Planned |
| Job dependencies with terminal policies    | Supported  | Supported | Planned |
| Concurrency keys                           | Supported  | Supported | Planned |
| Recurring schedule definition sync         | Supported  | Supported | Planned |
| Payload and result contracts               | Supported  | Absent    | Absent  |
| Compatibility refusal before mutation      | Supported  | Supported | Planned |
| SQL protocol conformance fixtures executed | Supported  | Supported | Planned |

The TypeScript client is `@workhorse/core` (`Queue`); the Python client is `workhorse-pg`
(`Queue`/`AsyncQueue` over Psycopg and asyncpg); the Go module is reserved at `go/README.md`.
Python can define and synchronize recurring schedules, but only a worker fires them, so a
deployment enqueueing from Python still needs a TypeScript worker until WOR-76 ships.

## Worker runtime

Every worker row is the runtime's own responsibility above the SQL protocol: local validation,
handler dispatch, concurrency, heartbeats, polling or notifications, cancellation delivery,
telemetry, and graceful shutdown.

| Capability                                      | TypeScript | Python  | Go      |
| ----------------------------------------------- | ---------- | ------- | ------- |
| Claiming and handler execution                  | Supported  | Planned | Planned |
| Bounded worker concurrency                      | Supported  | Planned | Planned |
| Heartbeats and fenced ownership                 | Supported  | Planned | Planned |
| Cooperative cancellation delivery               | Supported  | Planned | Planned |
| Notification-assisted dispatch with polling     | Supported  | Planned | Planned |
| Durable checkpoints (handler context)           | Supported  | Planned | Planned |
| Durable timers (`sleep` / `sleepUntil`)         | Supported  | Planned | Planned |
| Signal and human-decision waits                 | Supported  | Planned | Planned |
| Linked child fan-out and result join            | Supported  | Planned | Planned |
| Latest-value progress reporting                 | Supported  | Planned | Planned |
| Batch handler delivery                          | Supported  | Absent  | Absent  |
| Schedule firing (in-process cron)               | Supported  | Planned | Planned |
| Worker fleet registration and remote pause      | Supported  | Planned | Planned |
| Graceful stop and signal drain                  | Supported  | Planned | Planned |
| Maintenance participation (recovery, retention) | Supported  | Planned | Planned |
| OpenTelemetry tracing and metrics               | Supported  | Planned | Planned |

The Planned worker columns describe the scope features.md records for WOR-76 through WOR-79:
handler execution, bounded concurrency, heartbeats, cancellation, telemetry, and graceful drain.
Rows beyond that scope start Planned only when their issue says so; until then a cell claiming
more than the issue scope is a bug in this document.

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
that need should arrive as its own Linear issue.

## Keeping this document honest

If a cell says Supported, tests in this repository must exercise that capability in that
language. The conformance fixtures under `protocol/v1/` are the intended enforcement point: the
TypeScript suite runs them through `scripts/verify-sql-protocol.ts`, and the Python suite runs
them through `python/tests/test_protocol_conformance.py`. A generated check in the style of
`typescript/core/test/support-matrix.test.ts` — which fails when `docs/compatibility.md`, CI, and
the package `engines` fields disagree — does not exist for this matrix yet. Until it does, any
change that ships or removes a language capability must update this file in the same commit,
exactly as behaviour changes must update the guide that describes them.
