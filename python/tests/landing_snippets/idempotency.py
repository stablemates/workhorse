from workhorse import EnqueueOptions, Idempotency, Queue


def capture_invoice(queue: Queue) -> str:
    return queue.enqueue(
        "invoice.capture",
        {"invoiceId": "inv-1"},
        EnqueueOptions(
            queue="billing",
            idempotency=Idempotency(
                key="capture:inv-1",
                scope="tenant-42",
                ttl_ms=86_400_000,
            ),
        ),
    )
