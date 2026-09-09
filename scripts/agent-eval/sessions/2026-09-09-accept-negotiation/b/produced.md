I read the docs (home → quickstart → enqueue → workers → durable-execution → retries → idempotency → api → installation → compatibility → examples → integrations/frameworks → worker-processes → deadlines → cancellation). Here is the complete code.

---

### `app/jobs.py` — shared job constants

```python
"""Names shared by the producer (web tier) and the consumer (worker tier).

Workhorse matches jobs to handlers by the type string, and workers only claim
from the queues they are configured for, so these two constants must stay
identical on both sides of the database.
"""

ORDER_CONFIRMATION_JOB = "email.order_confirmation"
EMAIL_QUEUE = "email"
```

---

### `app/email_provider.py` — the external HTTP provider client

```python
"""Thin client for the transactional email provider's HTTP API.

Workhorse delivery is at-least-once: a worker can die between the provider call
and the checkpoint commit, so the same send can be attempted again. The provider
idempotency key is what makes that repeat harmless -- the docs are explicit that
a checkpoint makes repeats rare but only the system performing the effect can
close the final gap.
"""

from __future__ import annotations

import os
from typing import Any

import httpx

PROVIDER_URL = os.environ.get(
    "EMAIL_PROVIDER_URL", "https://api.email-provider.example/v1/messages"
)
PROVIDER_TOKEN = os.environ["EMAIL_PROVIDER_TOKEN"]

# One pooled client for the process. The request timeout is deliberately much
# shorter than the job's execution_timeout_ms: Workhorse's clocks are
# cooperative and cannot interrupt a blocked socket read, so the HTTP client
# has to bound the call itself.
_client = httpx.Client(
    timeout=httpx.Timeout(10.0, connect=5.0),
    headers={
        "Authorization": f"Bearer {PROVIDER_TOKEN}",
        "Content-Type": "application/json",
    },
)


def send_order_confirmation(
    *,
    to: str,
    order_id: str,
    total_cents: int,
    idempotency_key: str,
) -> dict[str, Any]:
    """POST one confirmation email. Raises on a non-2xx response.

    Returns a small JSON-serializable dict, because the caller stores it as a
    Workhorse checkpoint value (checkpoint values are JSON and size-capped).
    """
    response = _client.post(
        PROVIDER_URL,
        headers={"Idempotency-Key": idempotency_key},
        json={
            "to": to,
            "template": "order-confirmation",
            "variables": {
                "orderId": order_id,
                "totalCents": total_cents,
            },
        },
    )
    # A raised error fails this attempt; PostgreSQL applies the persisted retry
    # policy and schedules the next one.
    response.raise_for_status()

    body = response.json()
    return {"providerMessageId": body["id"], "to": to}
```

---

### `app/orders.py` — the order write, with the job enqueued in the same transaction

```python
"""Order creation: the row and its confirmation-email job commit together.

This is the point of putting the queue in PostgreSQL. Python hands the
transaction over by building the Queue on the connection whose transaction is
already open -- there is no separate transaction argument as in the TypeScript
SDK. If the INSERT rolls back, the job was never enqueued; if the enqueue
fails, no order exists.
"""

from __future__ import annotations

import os

import psycopg
from workhorse import EnqueueOptions, Idempotency, Queue, assert_schema_compatible

from app.jobs import EMAIL_QUEUE, ORDER_CONFIRMATION_JOB

DATABASE_URL = os.environ["DATABASE_URL"]

# Talking to an external provider: decorrelated jitter is the documented
# recommendation, so a thousand jobs failing during a provider outage do not
# wake up together and knock the recovering service over again. The field names
# are JSON/camelCase in every SDK because PostgreSQL owns their validation.
_EMAIL_RETRY_POLICY = {
    "type": "decorrelated-jitter",
    "baseDelayMs": 1_000,
    "maxDelayMs": 60_000,
}


def enqueue_order_confirmation(
    connection: psycopg.Connection,
    *,
    order_id: str,
    email: str,
    total_cents: int,
) -> str:
    """Enqueue the confirmation email on the caller's open transaction.

    Call this from inside the transaction that writes the order row. The
    caller keeps ownership of the connection; Workhorse never opens or closes
    a transaction on your behalf.
    """
    return Queue(connection).enqueue(
        ORDER_CONFIRMATION_JOB,
        # Payload is plain JSON. Keep it to identifiers plus what the send
        # needs -- it is part of the idempotency fingerprint.
        {"orderId": order_id, "to": email, "totalCents": total_cents},
        EnqueueOptions(
            queue=EMAIL_QUEUE,
            max_attempts=5,
            retry_policy=_EMAIL_RETRY_POLICY,
            # One attempt is stuck after 30s; the budget only counts real
            # execution, and a later attempt may still succeed.
            execution_timeout_ms=30_000,
            tags=[f"order:{order_id}"],
            # A retried POST /orders or a double-clicked button converges on
            # the original job instead of sending a second email. The key must
            # be a stable business value, never a timestamp or random value.
            idempotency=Idempotency(
                key=f"order-confirmation:{order_id}",
                scope="order-emails",
            ),
        ),
    )


def create_order(order_id: str, email: str, total_cents: int) -> None:
    """The existing order write, with the job added to the same transaction."""
    with psycopg.connect(DATABASE_URL) as connection:
        with connection.transaction():
            connection.execute(
                "INSERT INTO orders (id, email, total_cents) VALUES (%s, %s, %s)",
                (order_id, email, total_cents),
            )
            enqueue_order_confirmation(
                connection,
                order_id=order_id,
                email=email,
                total_cents=total_cents,
            )
            # Commit happens on exiting the transaction block: the order row
            # and the job appear together, or neither does.


def check_workhorse_schema() -> None:
    """Run once at web-process startup, before serving traffic.

    Runtime processes verify the schema; they never install it. A refusal
    raises ProtocolCompatibilityError, whose `code` names the reason.
    """
    with psycopg.connect(DATABASE_URL) as connection:
        assert_schema_compatible(connection)
```

---

### `app/email_worker.py` — the worker process

```python
"""Dedicated worker process for the email queue.

Run this as its own deployment, never inside the web process: a worker is a
continuous process that holds a pool, renews leases and heartbeats, and drains
on SIGTERM. If web replicas started workers, scaling for HTTP traffic would
silently multiply worker capacity and connections.

    python -m app.email_worker
"""

from __future__ import annotations

import os

import psycopg
from workhorse import (
    HandlerContext,
    Json,
    Worker,
    assert_schema_compatible,
    run_worker_process,
)

from app.email_provider import send_order_confirmation
from app.jobs import EMAIL_QUEUE, ORDER_CONFIRMATION_JOB

DATABASE_URL = os.environ["DATABASE_URL"]


def handle_order_confirmation(
    payload: object, context: HandlerContext
) -> dict[str, Json]:
    """Send one confirmation email.

    Handlers restart from the top after any retry, crash, or durable wait, so
    the provider call sits behind a named checkpoint: a later activation
    replays the stored result instead of sending again. The checkpoint name is
    durable control flow -- renaming it makes in-flight jobs resend.
    """
    assert isinstance(payload, dict)
    order_id = payload["orderId"]
    to = payload["to"]
    total_cents = payload["totalCents"]
    assert isinstance(order_id, str) and isinstance(to, str)
    assert isinstance(total_cents, int)

    # Cancellation, deadlines, and execution timeouts all arrive here, and all
    # are cooperative -- check before starting an external effect.
    context.cancellation.raise_if_cancelled()

    delivery = context.checkpoint(
        "provider-send",
        lambda: send_order_confirmation(
            to=to,
            order_id=order_id,
            total_cents=total_cents,
            # Stable across every attempt and across the window between the
            # provider call and the checkpoint commit.
            idempotency_key=f"order-confirmation:{order_id}",
        ),
    )
    assert isinstance(delivery, dict)

    # The returned value becomes the job's durable outcome, queryable after
    # this process is gone.
    return {
        "orderId": order_id,
        "deliveredTo": to,
        "providerMessageId": delivery["providerMessageId"],
    }


def main() -> None:
    # The Python Worker requires its own connection in autocommit mode and
    # raises ValueError otherwise -- keep it separate from the connection the
    # application enqueues on.
    with psycopg.connect(DATABASE_URL, autocommit=True) as connection:
        assert_schema_compatible(connection)

        worker = Worker(
            connection,
            queues=(EMAIL_QUEUE,),
            concurrency=8,
            worker_id=os.environ.get("WORKER_ID"),  # None -> host+pid default
            # A dedicated connection for wake notifications, so an idle worker
            # does not poll constantly.
            notification_connection_factory=lambda: psycopg.connect(
                DATABASE_URL, autocommit=True
            ),
        )
        worker.handle(ORDER_CONFIRMATION_JOB, handle_order_confirmation)

        # Signal handling plus a bounded graceful drain: the first SIGTERM
        # stops claiming and lets active handlers finish. Keep this below your
        # platform's termination window; leases left behind are recovered by
        # PostgreSQL anyway.
        run_worker_process(worker, shutdown_timeout_ms=25_000)


if __name__ == "__main__":
    main()
```

---

**Notes on the two things that are easy to get wrong here.** The schema is a deployment step, not something a process does at boot — the schema tool ships only in the TypeScript package, so a Python project runs it through `npx` pinned to the same version as the SDK (`0.1.0`), and every runtime process calls `assert_schema_compatible` instead. And the transaction only guarantees durable _acceptance_: the handler runs later, outside it, at least once — which is why the provider gets its own `Idempotency-Key` in addition to the checkpoint.

```install
pip install stablemates-workhorse
pip install httpx
npx --package @stablemates/workhorse@0.1.0 workhorse schema install
```
