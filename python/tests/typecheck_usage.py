from __future__ import annotations

from collections.abc import Sequence
from typing import Any

import asyncpg  # type: ignore[import-untyped]
import psycopg

from workhorse import (
    Admin,
    AdminAudit,
    AsyncAdmin,
    AsyncBatchHandlerItem,
    AsyncHandlerContext,
    AsyncQueue,
    AsyncWorker,
    BatchHandlerItem,
    BatchHandlerOutcome,
    ChildJobRequest,
    ConcurrencyPolicyDefinition,
    DeadLetterQuery,
    EnqueueOptions,
    HandlerContext,
    Idempotency,
    Json,
    Queue,
    RateLimit,
    RateLimitPolicyDefinition,
    Worker,
    assert_schema_compatible,
    assert_schema_compatible_asyncpg,
    assert_schema_compatible_psycopg,
    run_worker_process,
)


def sync_startup_check(connection: psycopg.Connection[Any]) -> None:
    assert_schema_compatible(connection)


def sync_enqueue(connection: psycopg.Connection[Any]) -> str:
    return Queue(connection).enqueue(
        "email.send",
        {"message": "hello"},
        EnqueueOptions(idempotency=Idempotency("message")),
    )


def sync_policies(connection: psycopg.Connection[Any]) -> None:
    queue = Queue(connection)
    queue.sync_concurrency_policies(
        "application",
        [ConcurrencyPolicyDefinition("mail", max_active=8, max_active_per_key=2)],
    )
    queue.list_concurrency_policies(["mail"])
    queue.sync_rate_limit_policies(
        "application",
        [RateLimitPolicyDefinition("mail", RateLimit(limit=10, interval_ms=1_000, burst=20))],
        prune=False,
    )
    queue.list_rate_limit_policies()


def sync_admin(connection: psycopg.Connection[Any]) -> str | None:
    admin = Admin(connection)
    failures = admin.list_dead_letters(DeadLetterQuery(queue="billing"))
    if not failures.items:
        return None
    result = admin.redrive(
        failures.items[0].job_id,
        AdminAudit("operator", "provider recovered", "incident-42"),
    )
    return result.target_job_id


def sync_worker(connection: psycopg.Connection[Any], database_url: str) -> bool:
    def handle(payload: Json, context: HandlerContext) -> Json:
        context.cancellation.raise_if_cancelled()
        progress = context.set_progress({"phase": "working"})
        assert context.get_progress() == progress
        prepared = context.checkpoint("prepare", lambda: {"payload": payload})
        signal = context.wait_for_signal("approval", timeout_ms=60_000)
        decision = context.wait_for_human("review", {"signal": signal})
        child = context.run_child("audit", "audit.write", {"decision": decision})
        children = context.run_children_all(
            (ChildJobRequest("notify", "notify.send", {"child": child}),)
        )
        return {
            "jobId": context.job.id,
            "prepared": prepared,
            "decision": decision,
            "children": children,
        }

    return (
        Worker(
            connection,
            heartbeat_ms=1_000,
            notification_connection_factory=lambda: psycopg.connect(
                database_url,
                autocommit=True,
            ),
            on_notification_error=print,
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
    queue = AsyncQueue.from_psycopg(connection)
    job_id = await queue.enqueue("email.send", {"message": "hello"})
    await queue.send_signal(
        job_id,
        "approval",
        {"approved": True},
        idempotency_key="approval",
        requested_by="service",
    )
    return job_id


async def async_startup_checks(
    psycopg_connection: psycopg.AsyncConnection[Any],
    asyncpg_connection: asyncpg.Connection,
) -> None:
    await assert_schema_compatible_psycopg(psycopg_connection)
    await assert_schema_compatible_asyncpg(asyncpg_connection)


async def asyncpg_enqueue(connection: asyncpg.Connection) -> str:
    queue = AsyncQueue.from_asyncpg(connection)
    job_id = await queue.enqueue("email.send", {"message": "hello"})
    await queue.complete_human_wait(
        job_id,
        "review",
        {"approved": True},
        idempotency_key="review",
        requested_by="reviewer",
    )
    await queue.cancel(job_id, requested_by="service", reason="request ended")
    return job_id


async def asyncpg_admin(connection: asyncpg.Connection) -> int:
    admin = AsyncAdmin.from_asyncpg(connection)
    return len((await admin.list_jobs()).items)


async def asyncpg_policies(connection: asyncpg.Connection) -> None:
    queue = AsyncQueue.from_asyncpg(connection)
    await queue.sync_concurrency_policies(
        "application", [ConcurrencyPolicyDefinition("mail", max_active=8)]
    )
    await queue.list_concurrency_policies()
    await queue.sync_rate_limit_policies(
        "application",
        [RateLimitPolicyDefinition("mail", RateLimit(limit=10, interval_ms=1_000, burst=20))],
    )
    await queue.list_rate_limit_policies(["mail"])


async def async_psycopg_worker(connection: psycopg.AsyncConnection[Any]) -> bool:
    async def handle(payload: Json, context: AsyncHandlerContext) -> Json:
        progress = await context.set_progress({"phase": "working"})
        assert await context.get_progress() == progress
        prepared = await context.checkpoint("prepare", lambda: async_value(payload))
        await context.sleep("delay", 1)
        return {"prepared": prepared}

    return await AsyncWorker.from_psycopg(connection).handle("email.send", handle).run_once()


async def asyncpg_batch_worker(connection: asyncpg.Connection) -> bool:
    async def handle(items: Sequence[AsyncBatchHandlerItem]) -> list[BatchHandlerOutcome]:
        return [{"status": "succeeded", "result": {"jobId": item.context.job.id}} for item in items]

    return await (
        AsyncWorker.from_asyncpg(connection, concurrency=2)
        .handle_batch("email.batch", handle, max_size=2, linger_ms=50)
        .run_once()
    )


async def async_value(value: Json) -> Json:
    return value


def unsupported_connections_are_rejected() -> None:
    Queue(object())  # type: ignore[arg-type]
    Admin(object())  # type: ignore[arg-type]
    AsyncQueue.from_psycopg(object())  # type: ignore[arg-type]
    AsyncQueue.from_asyncpg(object())  # type: ignore[arg-type]
    AsyncAdmin.from_psycopg(object())  # type: ignore[arg-type]
    AsyncAdmin.from_asyncpg(object())  # type: ignore[arg-type]
    AsyncWorker.from_psycopg(object())  # type: ignore[arg-type]
    AsyncWorker.from_asyncpg(object())  # type: ignore[arg-type]
