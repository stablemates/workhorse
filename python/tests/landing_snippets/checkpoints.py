from typing import TypedDict

from workhorse import HandlerContext, Json, Worker


class Invoice(TypedDict):
    amount: int
    email: str


def charge_card(amount: int) -> dict[str, Json]:
    return {"id": f"ch_{amount}"}


def render_invoice(charge_id: Json) -> dict[str, Json]:
    return {"chargeId": charge_id}


def register_invoice(worker: Worker) -> None:
    def issue(
        payload: Invoice,
        context: HandlerContext,
    ) -> dict[str, Json]:
        # Later runs return the stored checkpoint result.
        charge = context.checkpoint(
            "charge",
            lambda: charge_card(payload["amount"]),
        )
        pdf = context.checkpoint(
            "render",
            lambda: render_invoice(charge["id"]),
        )
        print("email", payload["email"], pdf)
        return {"chargeId": charge["id"]}

    worker.handle("invoice.issue", issue)
