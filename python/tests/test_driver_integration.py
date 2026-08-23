from __future__ import annotations

from datetime import datetime, timedelta, timezone

import asyncpg
import psycopg
import pytest

from workhorse import (
    AsyncQueue,
    Debounce,
    Dependencies,
    EnqueueIdempotencyConflictError,
    EnqueueOptions,
    EnqueueRequest,
    Idempotency,
    Queue,
    ScheduleDefinition,
    ScheduledJob,
    Throttle,
)

pytestmark = pytest.mark.integration


def job_count(database_url: str) -> int:
    with psycopg.connect(database_url, autocommit=True) as observer:
        row = observer.execute("SELECT count(*) FROM workhorse.job").fetchone()
        assert row is not None
        return int(row[0])


def test_psycopg_preserves_caller_owned_commit_and_rollback(database_url: str) -> None:
    with psycopg.connect(database_url) as connection:
        with connection.transaction():
            job_id = Queue(connection).enqueue("email.send", {"message": "committed"})
            assert job_count(database_url) == 0
        assert job_count(database_url) == 1

        with (
            pytest.raises(RuntimeError, match="application rollback"),
            connection.transaction(),
        ):
            Queue(connection).enqueue("email.send", {"message": "rolled back"})
            raise RuntimeError("application rollback")

    assert job_count(database_url) == 1
    assert job_id


def test_psycopg_reads_the_database_health_document(database_url: str) -> None:
    with psycopg.connect(database_url) as connection:
        health = Queue(connection).health()

    assert health["schema_version"] == 1
    assert health["status"] == {"level": "healthy", "reasons": []}
    assert health["budgets"]["promotionLagMs"] > 0  # type: ignore[index,operator]


@pytest.mark.asyncio
async def test_asyncpg_preserves_a_caller_owned_transaction(database_url: str) -> None:
    connection = await asyncpg.connect(database_url)
    try:
        transaction = connection.transaction()
        await transaction.start()
        await AsyncQueue.from_asyncpg(connection).enqueue("email.send", {"message": "async"})
        assert job_count(database_url) == 0
        await transaction.commit()
        assert job_count(database_url) == 1
    finally:
        await connection.close()


@pytest.mark.asyncio
async def test_asyncpg_reads_the_same_database_health_document(database_url: str) -> None:
    connection = await asyncpg.connect(database_url)
    try:
        health = await AsyncQueue.from_asyncpg(connection).health()
    finally:
        await connection.close()

    assert health["schema_version"] == 1
    assert health["status"] == {"level": "healthy", "reasons": []}


@pytest.mark.asyncio
async def test_async_psycopg_executes_the_same_protocol(database_url: str) -> None:
    async with (
        await psycopg.AsyncConnection.connect(database_url) as connection,
        connection.transaction(),
    ):
        job_id = await AsyncQueue.from_psycopg(connection).enqueue(
            "email.send", {"message": "async psycopg"}
        )
    assert job_id
    assert job_count(database_url) == 1


def test_enqueue_modes_dependencies_batch_and_schedules(database_url: str) -> None:
    with psycopg.connect(database_url) as connection:
        queue = Queue(connection)
        prerequisite = queue.enqueue("prepare", {})
        delayed = queue.enqueue(
            "delayed",
            {},
            EnqueueOptions(run_at=datetime.now(timezone.utc) + timedelta(minutes=5)),
        )
        prioritized = queue.enqueue("priority", {}, EnqueueOptions(priority=100))
        replay_one = queue.enqueue_with_result(
            "idempotent", {}, EnqueueOptions(idempotency=Idempotency("same"))
        )
        replay_two = queue.enqueue_with_result(
            "idempotent", {}, EnqueueOptions(idempotency=Idempotency("same"))
        )
        with (
            pytest.raises(EnqueueIdempotencyConflictError),
            connection.transaction(),
        ):
            queue.enqueue(
                "idempotent",
                {"different": True},
                EnqueueOptions(idempotency=Idempotency("same")),
            )
        debounced = queue.enqueue_with_result(
            "debounce",
            {},
            EnqueueOptions(debounce=Debounce("typing", 1_000, "reset")),
        )
        replaced = queue.enqueue_with_result(
            "debounce",
            {"revision": 2},
            EnqueueOptions(debounce=Debounce("typing", 1_000, "reset")),
        )
        throttled = queue.enqueue_with_result(
            "throttle", {}, EnqueueOptions(throttle=Throttle("rate", 1_000))
        )
        coalesced = queue.enqueue_with_result(
            "throttle", {}, EnqueueOptions(throttle=Throttle("rate", 1_000))
        )
        dependent = queue.enqueue(
            "dependent",
            {},
            EnqueueOptions(dependencies=Dependencies((prerequisite,), "release", "cancel", "fail")),
        )
        batch = queue.enqueue_many(
            [EnqueueRequest("batch.one", {}), EnqueueRequest("batch.two", {})]
        )
        queue.sync_schedules(
            "billing",
            [
                ScheduleDefinition(
                    "daily", "0 0 * * *", ScheduledJob("billing.daily", {"active": True})
                )
            ],
        )

    assert all((delayed, prioritized, dependent, *batch))
    assert (replay_one.outcome, replay_two.outcome) == ("accepted", "replayed")
    assert replay_one.job_id == replay_two.job_id
    assert (debounced.outcome, replaced.outcome) == ("accepted", "replaced")
    assert (throttled.outcome, coalesced.outcome) == ("accepted", "coalesced")
    with psycopg.connect(database_url, autocommit=True) as observer:
        schedule = observer.execute(
            "SELECT cron_expression FROM workhorse.schedule_definition "
            "WHERE namespace = 'billing' AND schedule_name = 'daily'"
        ).fetchone()
    assert schedule == ("0 0 * * *",)
