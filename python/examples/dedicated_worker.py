from __future__ import annotations

import os
import signal
import sys
from threading import Timer
from typing import Any

import psycopg

from workhorse import HandlerContext, Json, Queue, Worker, run_worker_process

database_url = sys.argv[1]

with psycopg.connect(database_url) as enqueue_connection:
    job_id = Queue(enqueue_connection).enqueue("packed.consumer", {"installed": True})
    enqueue_connection.commit()


def complete(payload: Any, _context: HandlerContext) -> dict[str, Json]:
    Timer(0.05, os.kill, args=(os.getpid(), signal.SIGTERM)).start()
    return {"payload": payload}


with psycopg.connect(database_url, autocommit=True) as worker_connection:
    worker = Worker(worker_connection, poll_ms=10).handle("packed.consumer", complete)
    run_worker_process(worker, shutdown_timeout_ms=1_000)
    outcome = worker_connection.execute(
        "SELECT state, result FROM workhorse.job_outcome WHERE job_id = %s",
        (job_id,),
    ).fetchone()
    assert outcome == ("succeeded", {"payload": {"installed": True}})
