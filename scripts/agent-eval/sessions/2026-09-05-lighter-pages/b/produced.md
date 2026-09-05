I read the docs (`/llms.txt` → for-ai-agents, installation, quickstart, enqueue, workers, worker-processes, durable-execution, retries, examples, concepts, api). Here is the complete integration.

## What this adds

- **`app/workhorse_jobs.py`** — shared job-type/queue/policy constants so producer and worker agree.
- **`app/email_provider.py`** — the external HTTP provider call (plain `httpx`), with a provider-side idempotency key.
- **`app/orders.py`** — your existing order insert, with the enqueue moved _inside the same transaction_ (this is what replaces an outbox; the job exists exactly when the order does).
- **`app/worker.py`** — the worker process: registers the handler, wraps the send in `context.checkpoint`, and drains on SIGTERM via `run_worker_process`.

Two rules from the docs drive the shape of this code: handlers are **at-least-once** and restart _from the top_ after a retry or crash, and the schema is a **deployment step**, never installed at startup (runtime processes only assert compatibility).

---

### `app/workhorse_jobs.py`

```python
"""Shared Workhorse job contract between the API process and the worker process."""

from __future__ import annotations

from typing import Any

# The job type string is durable program state: producer and worker must agree,
# and renaming it strands in-flight jobs. Keep it in one place.
ORDER_CONFIRMATION_JOB = "email.order_confirmation"

# Workers claim only from their configured queue set, so the producer must
# enqueue onto the same queue the worker below listens on.
EMAIL_QUEUE = "email"

# Attempt budget is enforced in SQL; no client config can create extra attempts.
MAX_ATTEMPTS = 6

# Decorrelated jitter is the recommended policy for anything that calls an
# external service: when many jobs fail together, it spreads the retry wave.
# PostgreSQL validates and applies this policy, so every worker backs off the
# same way, on both failure paths (handler raised, or worker died mid-job).
RETRY_POLICY: dict[str, Any] = {
    "type": "decorrelated-jitter",
    "baseDelayMs": 2_000,
    "maxDelayMs": 300_000,
}

# Bounds one attempt's execution. Independent of the attempt budget.
EXECUTION_TIMEOUT_MS = 30_000


def provider_idempotency_key(order_id: str) -> str:
    """Stable across every attempt and replay of this order's confirmation."""
    return f"order-confirmation:{order_id}"
```

---

### `app/email_provider.py`

```python
"""Thin client for the external transactional-email HTTP provider.

Workhorse's checkpoint makes a duplicate send rare (a crash between the HTTP
call and the checkpoint commit is the remaining window). Only the provider can
close that window, so every send carries a stable Idempotency-Key.
"""

from __future__ import annotations

import os
from typing import Any

import httpx

PROVIDER_URL = os.environ.get(
    "EMAIL_PROVIDER_URL", "https://api.emailprovider.example/v1/messages"
)
PROVIDER_TIMEOUT_SECONDS = float(os.environ.get("EMAIL_PROVIDER_TIMEOUT_SECONDS", "15"))
PROVIDER_FROM = os.environ.get("EMAIL_PROVIDER_FROM", "orders@example.com")


class EmailProviderError(RuntimeError):
    """Raised so the attempt fails and Workhorse applies the persisted retry policy."""

    def __init__(self, message: str, *, status_code: int | None = None) -> None:
        super().__init__(message)
        self.status_code = status_code


# One connection-pooled client per worker process.
_client = httpx.Client(
    timeout=httpx.Timeout(PROVIDER_TIMEOUT_SECONDS),
    headers={"User-Agent": "orders-worker/1.0"},
)


def send_confirmation_email(
    *,
    to: str,
    order_id: str,
    total_cents: int,
    idempotency_key: str,
) -> dict[str, Any]:
    """POST the confirmation to the provider and return a small JSON receipt.

    The return value is persisted as a Workhorse checkpoint value, so keep it
    small and JSON-serializable — never return the raw response object.
    """
    try:
        response = _client.post(
            PROVIDER_URL,
            headers={
                "Authorization": f"Bearer {os.environ['EMAIL_PROVIDER_API_KEY']}",
                # The provider collapses retried sends onto one message.
                "Idempotency-Key": idempotency_key,
            },
            json={
                "from": PROVIDER_FROM,
                "to": to,
                "template": "order-confirmation",
                "variables": {
                    "orderId": order_id,
                    "totalCents": total_cents,
                },
            },
        )
    except httpx.HTTPError as error:  # timeout, DNS, connection reset
        raise EmailProviderError(f"email provider unreachable: {error}") from error

    if response.status_code >= 400:
        # Both transient (429/5xx) and permanent (4xx) failures raise. The
        # attempt budget bounds the permanent case, after which the job lands
        # in dead letters with this error as evidence, ready for redrive.
        raise EmailProviderError(
            f"email provider rejected the send: {response.status_code} {response.text[:500]}",
            status_code=response.status_code,
        )

    body = response.json()
    return {
        "providerMessageId": body.get("id"),
        "status": body.get("status", "accepted"),
    }
```

---

### `app/orders.py` — the order write, with the job enqueued in the same transaction

```python
"""Order creation: the business write and its confirmation-email job commit together."""

from __future__ import annotations

import psycopg

from workhorse import EnqueueOptions, Queue

from .workhorse_jobs import (
    EMAIL_QUEUE,
    EXECUTION_TIMEOUT_MS,
    MAX_ATTEMPTS,
    ORDER_CONFIRMATION_JOB,
    RETRY_POLICY,
)


def enqueue_order_confirmation(
    connection: psycopg.Connection,
    *,
    order_id: str,
    customer_email: str,
) -> str:
    """Enqueue on the connection whose transaction is already open.

    In Python, Workhorse joins your transaction by constructing the Queue over
    that connection — there is no separate transaction argument. Call this
    INSIDE the block that inserts the order, never after the commit.
    """
    return Queue(connection).enqueue(
        ORDER_CONFIRMATION_JOB,
        {"orderId": order_id, "email": customer_email},
        EnqueueOptions(
            queue=EMAIL_QUEUE,
            max_attempts=MAX_ATTEMPTS,
            retry_policy=RETRY_POLICY,
            execution_timeout_ms=EXECUTION_TIMEOUT_MS,
            tags=[f"order:{order_id}"],
        ),
    )


def create_order(
    connection: psycopg.Connection,
    *,
    order_id: str,
    customer_email: str,
    total_cents: int,
) -> str:
    """Your existing order write, with two added lines.

    One transaction, one fate: if the INSERT rolls back the job never existed,
    and if the enqueue fails the order never existed. There is no window where
    a worker can process an order that is not there.
    """
    with connection.transaction():
        connection.execute(
            "INSERT INTO orders (id, customer_email, total_cents) VALUES (%s, %s, %s)",
            (order_id, customer_email, total_cents),
        )
        job_id = enqueue_order_confirmation(
            connection,
            order_id=order_id,
            customer_email=customer_email,
        )
    return job_id
```

If your API process already owns a connection with an open transaction (a request-scoped session, a unit of work), call `enqueue_order_confirmation(connection, ...)` from inside it rather than using `create_order`.

Assert schema compatibility once when the API process boots — never install:

```python
# app/startup.py
import os

import psycopg

from workhorse import assert_schema_compatible


def check_workhorse_schema() -> None:
    """Fail fast on a runtime/schema mismatch. Installation is a deploy step."""
    with psycopg.connect(os.environ["DATABASE_URL"]) as connection:
        assert_schema_compatible(connection)
```

---

### `app/worker.py` — the worker process

```python
"""Dedicated worker process for the `email` queue.

Run with:  python -m app.worker
"""

from __future__ import annotations

import os
from typing import Any

import psycopg

from workhorse import (
    HandlerContext,
    Json,
    Worker,
    assert_schema_compatible,
    run_worker_process,
)

from .email_provider import send_confirmation_email
from .workhorse_jobs import (
    EMAIL_QUEUE,
    ORDER_CONFIRMATION_JOB,
    provider_idempotency_key,
)

DATABASE_URL = os.environ["DATABASE_URL"]
WORKER_CONCURRENCY = int(os.environ.get("WORKER_CONCURRENCY", "8"))


def _load_order(connection: psycopg.Connection, order_id: str) -> tuple[str, int]:
    row = connection.execute(
        "SELECT customer_email, total_cents FROM orders WHERE id = %s",
        (order_id,),
    ).fetchone()
    if row is None:
        # Cannot happen when the enqueue is transactional — but a clear error
        # beats a confusing one if someone later enqueues outside the write.
        raise LookupError(f"order {order_id} not found")
    return row[0], row[1]


def handle_order_confirmation(
    payload: object,
    context: HandlerContext,
) -> dict[str, Json]:
    """Send the confirmation exactly once per order, across retries and crashes.

    A retry or a crash restarts this function from the top. Everything that
    must not repeat lives inside a named checkpoint: the first activation runs
    it and persists the JSON result; every later activation replays that stored
    result without calling the provider again.
    """
    assert isinstance(payload, dict)
    order_id = payload["orderId"]
    assert isinstance(order_id, str)

    # Cooperative cancellation: a queue.cancel request, the job deadline, and
    # the execution timeout all arrive here, so one check covers all three.
    context.cancellation.raise_if_cancelled()

    # Read fresh order facts rather than trusting a payload written long ago.
    with psycopg.connect(DATABASE_URL) as read_connection:
        customer_email, total_cents = _load_order(read_connection, order_id)

    receipt: Any = context.checkpoint(
        "confirmation-email",
        lambda: send_confirmation_email(
            to=customer_email,
            order_id=order_id,
            total_cents=total_cents,
            # Stable across every attempt and replay of this job.
            idempotency_key=provider_idempotency_key(order_id),
        ),
    )
    assert isinstance(receipt, dict)

    # Anything after the checkpoint reruns on a later activation, so keep it
    # idempotent too. This UPDATE is.
    with psycopg.connect(DATABASE_URL) as write_connection:
        with write_connection.transaction():
            write_connection.execute(
                "UPDATE orders SET confirmation_sent_at = now() "
                "WHERE id = %s AND confirmation_sent_at IS NULL",
                (order_id,),
            )

    return {
        "orderId": order_id,
        "providerMessageId": receipt.get("providerMessageId"),
        "jobId": context.job.id,
    }


def main() -> None:
    # The Python Worker requires its own connection in autocommit mode, and it
    # must not be the connection the API enqueues on.
    with psycopg.connect(DATABASE_URL, autocommit=True) as connection:
        assert_schema_compatible(connection)

        worker = Worker(
            connection,
            queues=(EMAIL_QUEUE,),
            concurrency=WORKER_CONCURRENCY,
            # A dedicated LISTEN connection: an idle worker wakes on committed
            # hints for its queues instead of polling hard.
            notification_connection_factory=lambda: psycopg.connect(
                DATABASE_URL, autocommit=True
            ),
        )
        worker.handle(ORDER_CONFIRMATION_JOB, handle_order_confirmation)

        # Handles SIGTERM/SIGINT: stop claiming, let active handlers finish,
        # then exit. Anything still running past the deadline is recovered by
        # PostgreSQL and picked up by another worker.
        run_worker_process(worker, shutdown_timeout_ms=25_000)


if __name__ == "__main__":
    main()
```

---

### Verifying one order end to end

```python
# scripts/check_order_job.py
import os

import psycopg

from workhorse import Admin

with psycopg.connect(os.environ["DATABASE_URL"]) as connection:
    job = Admin(connection).get_job(os.environ["JOB_ID"])
    print(job.state if job else None, job.result if job else None)
```

A settled job reports `succeeded` with the result your handler returned; until then it reports the state it is in, which is how you tell a slow worker from a missing one.

### Deployment notes

- Run the schema command **from your deploy pipeline**, not at application startup — every instance racing to install turns a deploy-time failure into a load-time one. It needs Node.js on the deploy machine only; the Python service runs without Node.
- Pin the schema CLI version to your `stablemates-workhorse` version (they release together). For an existing installed database, run `workhorse schema migrate` and gate the deploy on `workhorse schema status --json` instead of `schema install`.
- The worker process needs `DATABASE_URL`, `EMAIL_PROVIDER_API_KEY`, and `EMAIL_PROVIDER_URL`.

```install
pip install stablemates-workhorse
pip install httpx
npx --package @stablemates/workhorse@0.1.0 workhorse schema install
```
