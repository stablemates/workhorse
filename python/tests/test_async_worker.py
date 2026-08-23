from __future__ import annotations

import asyncio
from collections.abc import Sequence
from typing import Any

import asyncpg
import psycopg
import pytest

from workhorse import (
    AsyncBatchHandlerItem,
    AsyncHandlerContext,
    AsyncWorker,
    BatchHandlerOutcome,
    EnqueueOptions,
    Queue,
)


def enqueue(database_url: str, type: str, payload: object, *, queue: str = "default") -> str:
    with psycopg.connect(database_url) as connection:
        return Queue(connection).enqueue(
            type,
            payload,  # type: ignore[arg-type]
            EnqueueOptions(queue=queue),
        )


def outcome(database_url: str, job_id: str) -> tuple[str, object]:
    with psycopg.connect(database_url) as connection:
        row = connection.execute(
            "SELECT state, result FROM workhorse.job_outcome WHERE job_id = %s", (job_id,)
        ).fetchone()
    assert row is not None
    return row


@pytest.mark.asyncio
async def test_async_psycopg_worker_uses_async_handlers_and_durable_context(
    database_url: str,
) -> None:
    job_id = enqueue(database_url, "async.psycopg", {"value": 3})
    connection = await psycopg.AsyncConnection.connect(database_url, autocommit=True)
    try:
        operations = 0
        handler_calls = 0

        async def handler(payload: Any, context: AsyncHandlerContext) -> dict[str, object]:
            nonlocal handler_calls, operations
            handler_calls += 1

            async def prepare() -> dict[str, int]:
                nonlocal operations
                operations += 1
                await asyncio.sleep(0)
                return {"operation": operations}

            prepared = await context.checkpoint("prepare", prepare)
            observed = await context.get_progress()
            assert (observed is None) == (handler_calls == 1)
            progress = await context.set_progress({"phase": "prepared"})
            await context.sleep("brief-pause", 20)
            return {
                "value": payload["value"],
                "prepared": prepared,
                "handlerCalls": handler_calls,
                "progressRevision": progress.revision,
            }

        worker = AsyncWorker.from_psycopg(connection, worker_id="python-async-psycopg").handle(
            "async.psycopg", handler
        )

        assert await worker.run_once() is True
        await asyncio.sleep(0.12)
        assert await worker.run_once() is True
        assert operations == 1
        assert outcome(database_url, job_id) == (
            "succeeded",
            {
                "value": 3,
                "prepared": {"operation": 1},
                "handlerCalls": 2,
                "progressRevision": 1,
            },
        )
    finally:
        await connection.close()


@pytest.mark.asyncio
async def test_asyncpg_worker_reuses_batch_grouping_and_settlement(database_url: str) -> None:
    queue = "async-batch"
    job_ids = [
        enqueue(database_url, "async.batch", {"index": index}, queue=queue) for index in range(2)
    ]
    connection = await asyncpg.connect(database_url)
    try:
        seen: list[int] = []

        async def handler(
            items: Sequence[AsyncBatchHandlerItem],
        ) -> Sequence[BatchHandlerOutcome]:
            await asyncio.sleep(0)
            seen.extend(int(item.payload["index"]) for item in items)  # type: ignore[index]
            return [{"status": "succeeded", "result": {"batched": item.payload}} for item in items]

        worker = AsyncWorker.from_asyncpg(
            connection,
            queue=queue,
            worker_id="python-asyncpg-batch",
            concurrency=2,
        ).handle_batch("async.batch", handler, max_size=2, linger_ms=100)

        assert await worker.run_once() is True
        assert seen == [0, 1]
        assert [outcome(database_url, job_id)[0] for job_id in job_ids] == [
            "succeeded",
            "succeeded",
        ]
    finally:
        await connection.close()


@pytest.mark.asyncio
async def test_asyncpg_worker_decodes_progress_values(database_url: str) -> None:
    job_id = enqueue(database_url, "async.progress", {})
    connection = await asyncpg.connect(database_url)
    try:

        async def handler(_payload: object, context: AsyncHandlerContext) -> dict[str, object]:
            updated = await context.set_progress({"phase": "working"})
            observed = await context.get_progress()
            assert observed is updated
            assert observed.value == {"phase": "working"}
            return {"progress": observed.value, "revision": observed.revision}

        worker = AsyncWorker.from_asyncpg(connection, worker_id="python-asyncpg-progress").handle(
            "async.progress", handler
        )

        assert await worker.run_once() is True
        assert outcome(database_url, job_id) == (
            "succeeded",
            {"progress": {"phase": "working"}, "revision": 1},
        )
    finally:
        await connection.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("driver", ["psycopg", "asyncpg"])
async def test_async_worker_notifications_wake_continuous_dispatch_and_stop_drains(
    database_url: str, driver: str
) -> None:
    queue = f"async-notify-{driver}"
    handled = asyncio.Event()
    release = asyncio.Event()

    async def handler(_payload: object, _context: AsyncHandlerContext) -> dict[str, bool]:
        handled.set()
        await release.wait()
        return {"handled": True}

    if driver == "psycopg":
        query_connection = await psycopg.AsyncConnection.connect(database_url, autocommit=True)

        async def notification_connection() -> Any:
            return await psycopg.AsyncConnection.connect(database_url, autocommit=True)

        worker = AsyncWorker.from_psycopg(
            query_connection,
            queue=queue,
            poll_ms=5_000,
            notification_connection_factory=notification_connection,
        ).handle("async.notification", handler)
    else:
        query_connection = await asyncpg.connect(database_url)

        async def notification_connection() -> Any:
            return await asyncpg.connect(database_url)

        worker = AsyncWorker.from_asyncpg(
            query_connection,
            queue=queue,
            poll_ms=5_000,
            notification_connection_factory=notification_connection,
        ).handle("async.notification", handler)

    run = asyncio.create_task(worker.run())
    try:
        await asyncio.sleep(0.15)
        job_id = await asyncio.to_thread(
            enqueue, database_url, "async.notification", {}, queue=queue
        )
        await asyncio.wait_for(handled.wait(), timeout=2)
        worker.stop()
        await asyncio.sleep(0.05)
        assert not run.done()
        release.set()
        await asyncio.wait_for(run, timeout=2)
        assert outcome(database_url, job_id) == ("succeeded", {"handled": True})
    finally:
        release.set()
        worker.stop()
        await run
        await query_connection.close()
