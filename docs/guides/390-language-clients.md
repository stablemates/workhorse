# What must another language client implement?

PostgreSQL owns Workhorse's durable behavior. A language client translates application calls into
the stable SQL protocol and runs handlers, so it should not recreate queue state rules in memory.

## Start with the shared fixtures

The files under `protocol/` describe canonical requests, results, transitions, and errors as JSON.
`scenarios.json` calls versioned PostgreSQL functions directly. `runtime.json` drives `Worker`, and
`requests.json` drives `Queue.enqueueMany` so each runtime layer stays visible.

A client should run every scenario against its test database. If PostgreSQL returns a different
status, JSON value, or structured error, the client and database do not share the same protocol.

Before any mutation, the client should read `workhorse.schema_version`. It should compare the
installed schema and its own protocol against the ranges in the fixture manifest. If either falls
outside the range, the client should stop without enqueueing or claiming work.

## What PostgreSQL owns

PostgreSQL decides whether an enqueue is accepted or coalesced. It claims one job, issues the fence
token, extends the lease, and commits every lifecycle transition.

PostgreSQL also owns retry timing, cancellation state, checkpoints, timer boundaries,
dependencies, child lineage, signals, and human decisions. Clients pass canonical JSON and handle
the returned status; they do not predict the database's answer.

## What the runtime owns

The runtime registers handlers and limits how many run at once. It keeps active leases alive and
uses notifications or bounded polling to look for more work.

The runtime executes application code outside database transactions. It also turns cancellation
requests into local signals, attaches telemetry, drains on shutdown, and maps structured database
errors into the language's error types.

Batch handlers are a runtime feature. PostgreSQL claims jobs individually and supplies one fence
token for each. The runtime groups compatible jobs into a bounded handler call without changing
their lifecycle rules.

## Next

- [020-leases-and-fences.md](020-leases-and-fences.md) — how PostgreSQL owns a running job
- [030-delivery-guarantees.md](030-delivery-guarantees.md) — why handlers can run more than once
- [310-workers.md](310-workers.md) — what the worker process supplies

---

Exact protocol and ownership rules: [`architecture.md`](../architecture.md#sql-protocol-conformance).
