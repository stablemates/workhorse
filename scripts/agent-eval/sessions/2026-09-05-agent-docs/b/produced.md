I have what I need. Here is the complete integration.

## What this adds

Workhorse is a durable job queue that lives inside your PostgreSQL database, so `enqueue` joins the transaction that writes the order row — no outbox, no second broker. In Python the transaction is handed over by constructing `Queue` on the connection whose transaction is open.

---

### `app/jobs.py` — shared job contract and options

```python
"""Shared definitions for the order-confirmation email job.

Both the web tier (producer) and the worker process (consumer) import this
module so the job type, queue name, and failure policy have exactly one owner.
"""

from __future__ import annotations

from workhorse import (
    EnqueueOptions,
    Idempotency,
    JobContractVersion,
    JobTypeContracts,
    Queue,
)

# The job type string is durable program state: an in-flight job carries it
# across deploys, so treat it as immutable once shipped.
ORDER_CONFIRMATION = "order.confirmation_email"

# A dedicated queue lets the email workers scale and be paused independently
# of any other background work.
EMAIL_QUEUE = "email"

CONTRACT_VERSION = "order-confirmation-v1"

# Contracts reject a malformed payload before anything durable is written, and
# they mark the recipient address as sensitive: the worker still receives the
# raw payload (it needs the address to send), while job lookups, listings,
# dead letters, and the dashboard strip that key from operator views.
CONTRACTS = {
    ORDER_CONFIRMATION: JobTypeContracts(
        current_version=CONTRACT_VERSION,
        versions={
            CONTRACT_VERSION: JobContractVersion(
                payload_schema={
                    "type": "object",
                    "required": ["orderId", "email"],
                    "properties": {
                        "orderId": {"type": "string"},
                        "email": {"type": "string"},
                        "total": {"type": "string"},
                    },
                },
                result_schema={"type": "object"},
                sensitive_payload_keys=["email"],
            )
        },
    )
}


def sync_contracts(connection) -> None:
    """Deployment/startup step: publish the versioned payload contract.

    Safe to call from every process on boot; PostgreSQL keeps one immutable
    document per version.
    """
    Queue(connection).sync_contracts(CONTRACTS)


def confirmation_options(order_id: str) -> EnqueueOptions:
    """The failure policy this job is born with.

    - max_attempts is enforced in SQL, so no client can create extra attempts.
    - decorrelated jitter spreads the retry wave when the email provider is
      down and a thousand jobs fail at the same moment.
    - execution_timeout_ms bounds one attempt; it is terminal on its own, so
      keep the HTTP client timeout comfortably below it.
    - The idempotency key makes a double-submitted checkout converge on one
      job instead of two confirmation emails. Build it from a stable domain
      value (the order id), never a timestamp.
    """
    return EnqueueOptions(
        queue=EMAIL_QUEUE,
        max_attempts=8,
        retry_policy={
            "type": "decorrelated-jitter",
            "baseDelayMs": 2_000,
            "maxDelayMs": 300_000,
        },
        execution_timeout_ms=30_000,
        tags=[f"order:{order_id}"],
        idempotency=Idempotency(
            key=f"order-confirmation:{order_id}",
            scope="order-emails",
        ),
    )
```

---

### `app/email_provider.py` — the external HTTP provider

```python
"""Thin client for the transactional email provider's HTTP API.

Two properties matter to the queue:

1. It sends the provider its own idempotency key. A checkpoint commits *after*
   its operation finishes, so a process that dies between the HTTP call and
   that commit will call again on the next attempt. Only the provider can
   close that last gap.
2. It returns plain JSON. Whatever this returns is persisted as the
   checkpoint's durable value and replayed verbatim on a later activation.
"""

from __future__ import annotations

import os
from typing import Any

import httpx

PROVIDER_BASE_URL = os.environ.get("EMAIL_PROVIDER_URL", "https://api.emailprovider.com")
PROVIDER_API_KEY_ENV = "EMAIL_PROVIDER_API_KEY"

# Well below the job's execution_timeout_ms so the client gives up first and
# the failure is a normal, retryable attempt rather than a terminal timeout.
_TIMEOUT = httpx.Timeout(connect=5.0, read=15.0, write=15.0, pool=5.0)


class EmailProviderError(RuntimeError):
    """Raised so the attempt fails and Workhorse applies the retry policy."""


class EmailProvider:
    def __init__(self, client: httpx.Client | None = None) -> None:
        self._client = client or httpx.Client(
            base_url=PROVIDER_BASE_URL,
            timeout=_TIMEOUT,
            headers={"Authorization": f"Bearer {os.environ[PROVIDER_API_KEY_ENV]}"},
        )

    def send_order_confirmation(
        self,
        *,
        order_id: str,
        to: str,
        total: str | None,
        idempotency_key: str,
    ) -> dict[str, Any]:
        response = self._client.post(
            "/v1/messages",
            headers={"Idempotency-Key": idempotency_key},
            json={
                "template": "order-confirmation",
                "to": to,
                "variables": {"orderId": order_id, "total": total},
            },
        )

        if response.status_code >= 500 or response.status_code == 429:
            # Transient: let the attempt fail and the backoff policy decide.
            raise EmailProviderError(
                f"email provider returned {response.status_code} for order {order_id}"
            )
        if response.status_code >= 400:
            # Permanent as far as this payload is concerned. It still consumes
            # attempts and eventually dead-letters, which is where an operator
            # can inspect it and redrive after a fix.
            raise EmailProviderError(
                f"email provider rejected order {order_id}: {response.status_code}"
            )

        body = response.json()
        # Keep the checkpoint value small and JSON-serialisable; checkpoint
        # values are size-capped.
        return {"messageId": body["id"], "status": body.get("status", "queued")}

    def close(self) -> None:
        self._client.close()
```

---

### `app/orders.py` — the order write, now carrying the job

```python
"""The existing order write, with the confirmation email enqueued alongside it.

This is the whole point of Workhorse: the job row is written by *your*
transaction. If the insert fails, no job exists. If the enqueue fails, no order
exists. There is no window in which a worker can see an order that rolled back.
"""

from __future__ import annotations

from workhorse import Queue

from app.jobs import ORDER_CONFIRMATION, confirmation_options


def create_order(connection, *, order_id: str, email: str, total: str) -> str:
    """Insert the order and enqueue its confirmation email atomically.

    `connection` is the application's ordinary psycopg connection — the same
    one the rest of the request uses. Do NOT pass a worker's connection here;
    a Python Worker requires its own autocommit connection.
    """
    with connection.transaction():
        connection.execute(
            "INSERT INTO orders (id, email, total, status) VALUES (%s, %s, %s, %s)",
            (order_id, email, total, "new"),
        )

        # Constructing Queue on this connection is how Python hands the open
        # transaction to Workhorse. The job commits with the order or not at all.
        job_id = Queue(connection).enqueue(
            ORDER_CONFIRMATION,
            {"orderId": order_id, "email": email, "total": total},
            confirmation_options(order_id),
        )

    return job_id
```

Wiring it into an existing route (the connection you already hold — nothing else changes):

```python
# app/routes.py  (illustrative)
from app.orders import create_order


def place_order_route(connection, request) -> dict[str, str]:
    job_id = create_order(
        connection,
        order_id=request["orderId"],
        email=request["email"],
        total=request["total"],
    )
    # A repeated submit returns this same job id and writes nothing new.
    return {"orderId": request["orderId"], "confirmationJobId": job_id}
```

Call once during web-process startup:

```python
# app/startup.py
from workhorse import assert_schema_compatible

from app.jobs import sync_contracts


def on_startup(connection) -> None:
    # Verify — never install. Installing on the runtime path makes every
    # replica race to create schema objects.
    assert_schema_compatible(connection)
    sync_contracts(connection)
```

---

### `app/worker.py` — the worker process

```python
"""Dedicated worker process for the email queue.

Run this as its own deployment unit:  python -m app.worker

Handlers run outside any database transaction, so delivery is at least once:
a crashed worker's lease expires and another worker runs the handler again,
from the top. `context.checkpoint` is what makes the external send survive
that — the send runs once, and a later activation replays the stored provider
response instead of calling the API again.
"""

from __future__ import annotations

import os
import signal
import sys
from types import FrameType
from typing import Any

import psycopg

from workhorse import HandlerContext, Json, Worker, assert_schema_compatible

from app.email_provider import EmailProvider
from app.jobs import EMAIL_QUEUE, ORDER_CONFIRMATION, sync_contracts

DATABASE_URL = os.environ["DATABASE_URL"]
CONCURRENCY = int(os.environ.get("EMAIL_WORKER_CONCURRENCY", "8"))
LEASE_MS = int(os.environ.get("EMAIL_WORKER_LEASE_MS", "30000"))

provider = EmailProvider()


def handle_order_confirmation(payload: object, context: HandlerContext) -> dict[str, Json]:
    assert isinstance(payload, dict)
    order_id = payload["orderId"]
    email = payload["email"]
    total = payload.get("total")
    assert isinstance(order_id, str) and isinstance(email, str)

    # Cooperative cancellation: if the customer withdrew the order while this
    # job was queued, stop before spending a provider call.
    context.cancellation.raise_if_cancelled()

    # The named checkpoint is the restart boundary. First activation performs
    # the HTTP send and persists its JSON result under the current fenced
    # lease; every later activation returns that stored value without calling
    # the provider again. The provider idempotency key covers the narrow window
    # where the process dies after the send but before the checkpoint commits.
    #
    # "confirmation-send" is durable control flow. Renaming it creates a new
    # boundary and in-flight jobs will send a second time — do not rename it.
    receipt: Any = context.checkpoint(
        "confirmation-send",
        lambda: provider.send_order_confirmation(
            order_id=order_id,
            to=email,
            total=total if isinstance(total, str) else None,
            idempotency_key=f"order-confirmation:{order_id}",
        ),
    )
    assert isinstance(receipt, dict)

    # The return value becomes the job's durable, queryable result. Keep the
    # recipient address out of it — results are visible to operators.
    return {
        "orderId": order_id,
        "providerMessageId": receipt["messageId"],
        "providerStatus": receipt["status"],
    }


def main() -> int:
    # The Python Worker needs its own connection in autocommit mode and raises
    # ValueError otherwise. Keep it separate from the connection the web tier
    # enqueues on.
    with psycopg.connect(DATABASE_URL, autocommit=True) as connection:
        assert_schema_compatible(connection)
        sync_contracts(connection)

        worker = Worker(
            connection,
            queues=[EMAIL_QUEUE],
            concurrency=CONCURRENCY,
            # A shorter lease recovers a crashed worker's jobs faster; a longer
            # one tolerates worse network pauses.
            lease_ms=LEASE_MS,
        ).handle(ORDER_CONFIRMATION, handle_order_confirmation)

        def drain(signum: int, _frame: FrameType | None) -> None:
            # First signal drains: no new claims, active handlers finish, then
            # run() returns. A second signal from the platform kills the
            # process and PostgreSQL recovers the remaining leases.
            worker.stop()

        signal.signal(signal.SIGTERM, drain)
        signal.signal(signal.SIGINT, drain)

        worker.run()  # blocks until stop() drains it

    provider.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
```

---

### Optional: confirm a specific job settled

```python
# scripts/check_confirmation.py
import os
import sys

import psycopg

from workhorse import Admin

with psycopg.connect(os.environ["DATABASE_URL"]) as connection:
    job = Admin(connection).get_job(sys.argv[1])
    # Until it settles this reports the state it is in — which is how you tell
    # a slow worker from a missing one. The email address is redacted here by
    # the contract's sensitive_payload_keys.
    print(job.state if job else "not found", job.result if job else None)
```

---

## Notes that will bite you if ignored

- **Never install the schema from application or worker startup.** It is a deployment step; every replica would otherwise race to create objects and a version skew becomes a startup failure under load. Runtime code calls `assert_schema_compatible` only.
- **The `npx` version must equal your `stablemates-workhorse` version.** All SDKs release together from one commit. A tool older than the application leaves a schema the application refuses to start against.
- **`"confirmation-send"` and `ORDER_CONFIRMATION` are durable state.** Renaming either makes in-flight jobs rerun the send.
- The schema CLI needs Node.js on the deployment machine only; the Python service runs without it.
- If the provider enforces a call budget (e.g. 60/min), add a rate-limit policy via `Queue.sync_rate_limit_policies` on the `email` queue rather than sleeping in the handler — PostgreSQL owns the token bucket so every replica draws from one budget.

```install
pip install stablemates-workhorse
pip install httpx
npx --package @stablemates/workhorse@0.1.0 workhorse schema install
```
