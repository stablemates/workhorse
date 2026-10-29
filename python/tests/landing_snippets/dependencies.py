from workhorse import (
    Dependencies,
    EnqueueOptions,
    HandlerContext,
    Json,
    Queue,
    Worker,
)


def configure_checkout(
    queue: Queue,
    worker: Worker,
    order_id: str,
) -> None:
    inventory_id = queue.enqueue(
        "inventory.reserve",
        {"orderId": order_id},
    )
    queue.enqueue(
        "order.confirm",
        {"orderId": order_id},
        EnqueueOptions(
            dependencies=Dependencies(
                prerequisite_task_ids=(inventory_id,),
                on_success="release",
                on_failure="cancel",
                on_cancellation="cancel",
            ),
        ),
    )

    def fulfill(
        order: Json,
        context: HandlerContext,
    ) -> dict[str, Json]:
        receipt = context.run_child("charge", "payment.capture", order)
        return {"receipt": receipt}

    worker.handle("order.fulfill", fulfill)
