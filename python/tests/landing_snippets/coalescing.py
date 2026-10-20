from workhorse import Debounce, EnqueueOptions, Queue


def reindex(queue: Queue, document_id: str, quiet_ms: int) -> None:
    options = EnqueueOptions(
        debounce=Debounce(
            key=document_id,
            scope="search-index",
            window_ms=quiet_ms,
            schedule="reset",
        )
    )
    first = queue.enqueue_with_result(
        "search.reindex",
        {"documentId": document_id, "revision": 1},
        options,
    )
    latest = queue.enqueue_with_result(
        "search.reindex",
        {"documentId": document_id, "revision": 2},
        options,
    )
    print(first.outcome, latest.outcome)
