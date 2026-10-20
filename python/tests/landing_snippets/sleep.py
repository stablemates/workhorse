from workhorse import HandlerContext, Json, Worker


def place_order(payload: Json) -> dict[str, Json]:
    return {"payload": payload}


def register_settlement(worker: Worker) -> None:
    def settle(payload: Json, context: HandlerContext) -> dict[str, Json]:
        order = context.checkpoint("place", lambda: place_order(payload))
        context.sleep("settlement-window", 60 * 60 * 1000)
        return {"order": order, "confirmed": True}

    worker.handle("order.settle", settle)
