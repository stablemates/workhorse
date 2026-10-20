from typing import TypedDict

from workhorse import HandlerContext, Json, Queue, Worker


class Export(TypedDict):
    rows: list[Json]


def configure_export(queue: Queue, worker: Worker, task_id: str) -> None:
    def export(payload: Export, context: HandlerContext) -> dict[str, Json]:
        for row in payload["rows"]:
            context.cancellation.raise_if_cancelled()
            print("upload", row)
        return {"stopped": False}

    worker.handle("rows.export", export)
    queue.cancel(
        task_id,
        requested_by="operator@example.com",
        reason="customer withdrew the request",
    )
