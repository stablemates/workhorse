# What must another language client implement?

PostgreSQL owns Workhorse's durable behavior. A language client translates application calls into
the stable SQL protocol and runs handlers, so it should not recreate queue state rules in memory.

## Start with the shared fixtures

The files under `protocol/` describe canonical requests, results, transitions, and errors as JSON.
`scenarios.json` calls versioned PostgreSQL functions directly. `runtime.json` drives `Worker`, and
`requests.json` drives `Queue.enqueueMany` so each runtime layer stays visible.

A client should run every scenario against its test database. The Python enqueue client does this
for Psycopg and also verifies its public request mapping. If PostgreSQL returns a different status,
JSON value, or structured error, the client and database do not share the same protocol.

Before any mutation, the client should read `workhorse.schema_version`. It should compare the
installed schema and its own protocol against the ranges in the fixture manifest. If either falls
outside the range, the client should stop without enqueueing or claiming work.

## Keep application transactions in charge

The Python `Queue` wraps a connection that the application already owns. It sends enqueue SQL on
that connection, so application writes and the accepted job commit or roll back together.

```python
with psycopg.connect(database_url) as connection:
    with connection.transaction():
        connection.execute("INSERT INTO orders (id) VALUES (%s)", (order_id,))
        Queue(connection).enqueue("order.accepted", {"orderId": order_id})
```

The asynchronous client follows the same rule for Psycopg and asyncpg. The surrounding transaction
block decides the outcome; Workhorse does not commit, roll back, or close the connection.

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
