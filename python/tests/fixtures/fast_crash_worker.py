"""Serve one fast-tier queue until the crash test kills this process.

Each handler records its task and attempt in fast_crash_invocation, then succeeds.
"""

from __future__ import annotations

import sys

from psycopg_pool import ConnectionPool

from workhorse import HandlerContext, Json, Worker

database_url, queue_name, concurrency = sys.argv[1:]


with ConnectionPool(
    database_url, min_size=2, max_size=int(concurrency) + 4, kwargs={"autocommit": True}
) as pool:

    def effect(_payload: object, context: HandlerContext) -> Json:
        with pool.connection() as connection:
            connection.execute(
                "INSERT INTO fast_crash_invocation(task_id, attempt, worker) "
                "VALUES (%s, %s, 'crashed')",
                (context.task.id, context.task.attempt),
            )
        return {"ok": True}

    Worker(
        pool,
        queue=queue_name,
        worker_id="python-fast-crashed",
        concurrency=int(concurrency),
        poll_ms=5,
    ).handle("effect", effect).run()
