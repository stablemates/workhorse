from __future__ import annotations

import asyncio
import json
import sys
from uuid import uuid4

from workhorse import AsyncHandlerContext, AsyncQueue, AsyncWorker, Json


async def run(database_url: str, driver: str) -> None:
    suffix = uuid4().hex
    queue_name = f"python-async-worker-{driver}-{suffix}"
    job_type = f"async.worker-{driver}-{suffix}"

    async def handler(payload: object, _context: AsyncHandlerContext) -> dict[str, Json]:
        assert isinstance(payload, dict)
        return {"driver": driver, "value": payload["value"]}

    if driver == "psycopg":
        import psycopg

        enqueue_connection = await psycopg.AsyncConnection.connect(database_url)
        worker_connection = await psycopg.AsyncConnection.connect(database_url, autocommit=True)
        try:
            async with enqueue_connection.transaction():
                job_id = await AsyncQueue.from_psycopg(
                    enqueue_connection, default_queue=queue_name
                ).enqueue(job_type, {"value": 42})
            worker = AsyncWorker.from_psycopg(
                worker_connection,
                queue=queue_name,
                worker_id=f"python-example-{driver}-{suffix}",
            ).handle(job_type, handler)
            assert await worker.run_once() is True
            cursor = await worker_connection.execute(
                "SELECT state, result = %s::jsonb FROM workhorse.job_outcome WHERE job_id = %s",
                (json.dumps({"driver": driver, "value": 42}), job_id),
            )
            outcome = await cursor.fetchone()
        finally:
            await worker_connection.close()
            await enqueue_connection.close()
    elif driver == "asyncpg":
        import asyncpg  # type: ignore[import-untyped]

        enqueue_connection = await asyncpg.connect(database_url)
        worker_connection = await asyncpg.connect(database_url)
        try:
            async with enqueue_connection.transaction():
                job_id = await AsyncQueue.from_asyncpg(
                    enqueue_connection, default_queue=queue_name
                ).enqueue(job_type, {"value": 42})
            worker = AsyncWorker.from_asyncpg(
                worker_connection,
                queue=queue_name,
                worker_id=f"python-example-{driver}-{suffix}",
            ).handle(job_type, handler)
            assert await worker.run_once() is True
            row = await worker_connection.fetchrow(
                "SELECT state, result = $2::jsonb AS matches "
                "FROM workhorse.job_outcome WHERE job_id = $1::uuid",
                job_id,
                json.dumps({"driver": driver, "value": 42}),
            )
            outcome = None if row is None else (row["state"], row["matches"])
        finally:
            await worker_connection.close()
            await enqueue_connection.close()
    else:
        raise ValueError(f"unsupported driver: {driver}")

    assert outcome == ("succeeded", True)


if __name__ == "__main__":
    selected_driver = sys.argv[2]
    asyncio.run(run(sys.argv[1], selected_driver))
    print(f"Python {selected_driver} async worker example completed")
