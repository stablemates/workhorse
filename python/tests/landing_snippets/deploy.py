import os
from typing import TypedDict

from psycopg_pool import ConnectionPool

from workhorse import HandlerContext, Json, Worker, run_worker_process


class Email(TypedDict):
    to: str


def send_email(payload: Email, _context: HandlerContext) -> dict[str, Json]:
    return {"deliveredTo": payload["to"]}


database_url = os.environ["DATABASE_URL"]
with ConnectionPool(
    database_url, min_size=3, max_size=3, kwargs={"autocommit": True}
) as pool:
    worker = Worker(
        pool,
        queues=("email",),
        concurrency=8,
    )
    worker.handle("email.send", send_email)
    run_worker_process(worker, shutdown_timeout_ms=25_000)
