from collections.abc import Sequence

from workhorse import BatchHandlerItem, BatchHandlerOutcome, Worker


def register_email_batch(worker: Worker, batch_size: int, linger_ms: int) -> None:
    def send(items: Sequence[BatchHandlerItem]) -> Sequence[BatchHandlerOutcome]:
        return tuple({"status": "succeeded", "result": item.payload} for item in items)

    worker.handle_batch(
        "email.send",
        send,
        max_size=batch_size,
        linger_ms=linger_ms,
    )
