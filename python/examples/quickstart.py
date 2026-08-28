from __future__ import annotations

import os

import psycopg

from workhorse import Queue, Worker

database_url = os.environ["DATABASE_URL"]

with psycopg.connect(database_url) as application_connection:
    job_id = Queue(application_connection).enqueue("email.welcome", {"to": "ada@example.com"})
    application_connection.commit()

with psycopg.connect(database_url, autocommit=True) as worker_connection:
    worker = Worker(worker_connection).handle(
        "email.welcome",
        lambda payload, _context: {"deliveredTo": payload["to"]},
    )
    assert worker.run_once() is True  # Production worker processes call run().

print(job_id)
