# `stablemates-workhorse`

The Python clients, worker runtimes, and dashboard host for the Workhorse durable task queue for
PostgreSQL.

> **Public beta:** Workhorse is usable for evaluation and early production adoption. A 0.x minor
> release may change behaviour, so read the changelog before you upgrade. It will not ask you to
> recreate your database: migrations are ordered, and inside a major line a migration only adds, so
> a running deployment upgrades in place. The one exception is migration 0025: a database from
> before 0.5.0 crosses it offline, with the
> [0.5.0 upgrade steps](https://github.com/stablemates/workhorse/blob/main/CHANGELOG.md#050--2026-09-28).
> The upgrade from 0.5 to 0.6 only adds.

An AI agent should read [the Workhorse documentation index](https://workhorse.run/llms.txt) first.

## Install

```bash
pip install stablemates-workhorse
```

Install the schema once, as a deployment step. The application never installs or migrates it.

```bash
npx --package @stablemates/workhorse@0.5.0 workhorse schema install
```

The machine that runs that deployment step needs Node.js 22 or newer. The application itself needs
no Node.js.

Pin that version to the `stablemates-workhorse` version the application depends on. The two are
released together from one commit, so the numbers match. A schema tool older than the application
leaves a schema the application refuses to start against.

Runtime processes verify compatibility instead of changing the schema. Call
`assert_schema_compatible(connection)` at startup. Call `assert_schema_compatible_psycopg` or
`assert_schema_compatible_asyncpg` when the application is asynchronous.

Requires Python 3.12 through 3.14 and PostgreSQL 15 through 18.

## Run one task

```python
from __future__ import annotations

import os

import psycopg
from psycopg_pool import ConnectionPool

from workhorse import Queue, Worker

database_url = os.environ["DATABASE_URL"]

with psycopg.connect(database_url) as application_connection:
    task_id = Queue(application_connection).enqueue("email.welcome", {"to": "ada@example.com"})
    application_connection.commit()

with ConnectionPool(
    database_url, min_size=3, max_size=3, kwargs={"autocommit": True}
) as worker_pool:
    worker = Worker(worker_pool).handle(
        "email.welcome",
        lambda payload, _context: {"deliveredTo": payload["to"]},
    )
    assert worker.run_once() is True  # Production worker processes call run().

print(task_id)
```

Handlers receive at-least-once delivery. Use stable provider idempotency keys around external
effects; named checkpoints prevent completed application stages from running after a later restart.

An `AsyncWorker` checkpoint operation follows asyncio cancellation. When a timeout or task group
cancels the handler's `await context.checkpoint(name, operation)`, the worker cancels the
operation and waits for its cleanup before the cancellation reaches the handler. Cancellation
before the operation returns stops the save, even when the operation catches the cancellation and
returns a value, so a later attempt runs it again. Once the operation returns, its save may already
be under way. The worker waits for that save instead of undoing it, so the handler sees
`CancelledError` while a later attempt replays the saved value. A cancelled await therefore never
proves that no checkpoint exists, and it does not undo the operation's effects on other systems.

The operation runs on the event loop in a copy of the handler's context. It sees the handler's
context variables and current OpenTelemetry span, so its spans are children of the handler span.

## Package boundary

This distribution provides synchronous Psycopg and asynchronous Psycopg or asyncpg clients and
workers. Application clients use caller-owned connections and transactions. Workers take a
caller-owned pool: `Worker` takes a Psycopg `ConnectionPool`, `AsyncWorker.from_psycopg` takes a
Psycopg `AsyncConnectionPool`, and `AsyncWorker.from_asyncpg` takes an asyncpg `Pool`. A worker
borrows a pool connection for each claim and lifecycle statement and returns it afterwards. It also
reserves its own heartbeat and listener connections from that pool, so
[size the pool for them](https://workhorse.run/docs/pgbouncer#connection-budgets). Close the pool
after `run` returns; the worker never closes it. The package never installs or migrates the shared
PostgreSQL schema.

## Next

- Follow the [quickstart](https://workhorse.run/docs/quickstart) and deploy
  [worker processes](https://workhorse.run/docs/worker-processes).
- Read the [API reference](https://workhorse.run/docs/api) and
  [compatibility policy](https://workhorse.run/docs/compatibility).
- Use the [operations guide](https://workhorse.run/docs/operations) for telemetry, health, and
  maintenance.
- Browse the [repository](https://github.com/stablemates/workhorse) or report a problem in
  [GitHub issues](https://github.com/stablemates/workhorse/issues).

## License

Apache-2.0. See `LICENSE` and `NOTICE` in the package.
