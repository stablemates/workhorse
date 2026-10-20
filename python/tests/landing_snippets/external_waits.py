from typing import TypedDict, cast

from workhorse import HandlerContext, Json, Queue, Worker


class Release(TypedDict):
    id: str


class Review(TypedDict):
    approved: bool


def configure_release(worker: Worker) -> None:
    def publish(release: Release, context: HandlerContext) -> dict[str, Json]:
        scan = context.wait_for_signal("security-scan")
        review = cast(
            Review,
            context.wait_for_human(
                "release-approval",
                {"releaseId": release["id"], "scan": scan},
            ),
        )
        return {"published": review["approved"]}

    worker.handle("release.publish", publish)


def deliver_scan(queue: Queue, task_id: str, result: Json, delivery_id: str) -> None:
    queue.send_signal(
        task_id,
        "security-scan",
        result,
        idempotency_key=delivery_id,
        requested_by="security-scanner",
    )
