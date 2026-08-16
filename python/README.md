# Workhorse for Python

`workhorse-pg` is the Python enqueue client for Workhorse's versioned PostgreSQL protocol. It
supports Psycopg synchronously, Psycopg asynchronously, and asyncpg without taking ownership of a
connection or transaction supplied by the application.

## Install

Install the extra for the driver your application already uses:

```bash
pip install "workhorse-pg[psycopg]"
# or
pip install "workhorse-pg[asyncpg]"
```

The distribution requires Python 3.10 or newer. It includes inline type information and a
`py.typed` marker.

## Enqueue inside an application transaction

Construct `Queue` with the same Psycopg connection that owns the application transaction. The
client checks protocol compatibility, calls the versioned enqueue function, and leaves commit,
rollback, and connection cleanup to the surrounding code.

```python
import psycopg

from workhorse import EnqueueOptions, Idempotency, Queue

with psycopg.connect(DATABASE_URL) as connection:
    with connection.transaction():
        connection.execute(
            "INSERT INTO purchase_order (order_id, state) VALUES (%s, %s)",
            ("order-42", "accepted"),
        )
        job_id = Queue(connection).enqueue(
            "order.confirmed",
            {"orderId": "order-42"},
            EnqueueOptions(idempotency=Idempotency("order-42")),
        )
```

For asynchronous applications, use `AsyncQueue.from_psycopg(connection)` or
`AsyncQueue.from_asyncpg(connection)` inside the driver's transaction block.

## API

`Queue` and `AsyncQueue` expose `enqueue`, `enqueue_with_result`, `enqueue_many`,
`enqueue_many_with_results`, and `sync_schedules`. `EnqueueOptions` represents delayed dispatch,
priority, retry policy, idempotency, debounce, throttle, and job dependencies. PostgreSQL returns
canonical outcomes and structured failures through typed exceptions.

Run the package checks from the repository root:

```bash
pnpm python:format:check
pnpm python:lint
pnpm python:typecheck
pnpm python:test
pnpm python:build
```
