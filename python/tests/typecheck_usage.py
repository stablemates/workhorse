from __future__ import annotations

from typing import Any

import asyncpg  # type: ignore[import-untyped]
import psycopg

from workhorse import AsyncQueue, EnqueueOptions, HandlerContext, Idempotency, Json, Queue, Worker


def sync_enqueue(connection: psycopg.Connection[Any]) -> str:
    return Queue(connection).enqueue(
        "email.send",
        {"message": "hello"},
        EnqueueOptions(idempotency=Idempotency("message")),
    )


def sync_worker(connection: psycopg.Connection[Any]) -> bool:
    def handle(payload: Json, context: HandlerContext) -> Json:
        return {"jobId": context.job.id, "payload": payload}

    return Worker(connection).handle("email.send", handle).run_once()


async def async_psycopg_enqueue(connection: psycopg.AsyncConnection[Any]) -> str:
    return await AsyncQueue.from_psycopg(connection).enqueue("email.send", {"message": "hello"})


async def asyncpg_enqueue(connection: asyncpg.Connection) -> str:
    return await AsyncQueue.from_asyncpg(connection).enqueue("email.send", {"message": "hello"})


def unsupported_connections_are_rejected() -> None:
    Queue(object())  # type: ignore[arg-type]
    AsyncQueue.from_psycopg(object())  # type: ignore[arg-type]
    AsyncQueue.from_asyncpg(object())  # type: ignore[arg-type]
