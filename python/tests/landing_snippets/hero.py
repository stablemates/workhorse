from typing import TypedDict

import psycopg
from psycopg_pool import ConnectionPool

from workhorse import HandlerContext, Json, Queue, Worker


class Welcome(TypedDict):
    to: str


def run(database_url: str) -> None:
    with psycopg.connect(database_url) as connection:
        Queue(connection).enqueue("email.welcome", {"to": "ada@example.com"})

    def welcome(payload: Welcome, _context: HandlerContext) -> dict[str, Json]:
        return {"deliveredTo": payload["to"]}

    with ConnectionPool(
        database_url, min_size=3, max_size=3, kwargs={"autocommit": True}
    ) as pool:
        Worker(pool, concurrency=4).handle("email.welcome", welcome).run()
