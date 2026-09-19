from __future__ import annotations

import os

import psycopg
from psycopg_pool import ConnectionPool

from workhorse import Queue, Worker

database_url = os.environ["DATABASE_URL"]

with psycopg.connect(database_url) as application_connection:
    task_id = Queue(application_connection).enqueue("email.welcome", {"to": "ada@example.com"})
    application_connection.commit()

with ConnectionPool(
    database_url, min_size=3, max_size=3, kwargs={"autocommit": True}
) as worker_pool:
    worker = Worker(worker_pool).handle(
        "email.welcome",
        lambda payload, _context: {"deliveredTo": payload["to"]},
    )
    assert worker.run_once() is True  # Production worker processes call run().

print(task_id)
