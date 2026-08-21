from __future__ import annotations

from collections.abc import Sequence
from typing import Any

import asyncpg  # type: ignore[import-untyped]
import psycopg

from workhorse import (
    AsyncQueue,
    BatchHandlerItem,
    BatchHandlerOutcome,
    EnqueueOptions,
    HandlerContext,
    Idempotency,
    Json,
    Queue,
    Worker,
    run_worker_process,
)


def sync_enqueue(connection: psycopg.Connection[Any]) -> str:
    return Queue(connection).enqueue(
        "email.send",
        {"message": "hello"},
        EnqueueOptions(idempotency=Idempotency("message")),
    )


def sync_worker(connection: psycopg.Connection[Any], database_url: str) -> bool:
    def handle(payload: Json, context: HandlerContext) -> Json:
        context.cancellation.raise_if_cancelled()
        prepared = context.checkpoint("prepare", lambda: {"payload": payload})
        return {"jobId": context.job.id, "prepared": prepared}

    return (
        Worker(
            connection,
            heartbeat_ms=1_000,
            notification_connection_factory=lambda: psycopg.connect(
                database_url,
                autocommit=True,
            ),
            on_notification_error=lambda error: print(error),
        )
        .handle("email.send", handle)
        .run_once()
    )


def sync_worker_process(connection: psycopg.Connection[Any]) -> None:
    run_worker_process(Worker(connection), shutdown_timeout_ms=20_000)


def sync_batch_worker(connection: psycopg.Connection[Any]) -> bool:
    def handle(items: Sequence[BatchHandlerItem]) -> list[BatchHandlerOutcome]:
        return [{"status": "succeeded", "result": {"jobId": item.context.job.id}} for item in items]

    return (
        Worker(connection, concurrency=2)
        .handle_batch("email.batch", handle, max_size=2, linger_ms=50)
        .run_once()
    )


async def async_psycopg_enqueue(connection: psycopg.AsyncConnection[Any]) -> str:
    return await AsyncQueue.from_psycopg(connection).enqueue("email.send", {"message": "hello"})


async def asyncpg_enqueue(connection: asyncpg.Connection) -> str:
    return await AsyncQueue.from_asyncpg(connection).enqueue("email.send", {"message": "hello"})


def unsupported_connections_are_rejected() -> None:
    Queue(object())  # type: ignore[arg-type]
    AsyncQueue.from_psycopg(object())  # type: ignore[arg-type]
    AsyncQueue.from_asyncpg(object())  # type: ignore[arg-type]
