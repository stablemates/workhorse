from __future__ import annotations

import json
from datetime import UTC, datetime

import asyncpg
import psycopg
import pytest
from test_enqueue import Connection

from workhorse import (
    AsyncQueue,
    ConcurrencyPolicyDefinition,
    ProtocolCompatibilityError,
    Queue,
    RateLimit,
    RateLimitPolicyDefinition,
)


def test_sync_client_synchronizes_and_maps_concurrency_policies() -> None:
    updated_at = datetime(2026, 8, 23, 20, 0, tzinfo=UTC)
    connection = Connection(
        [
            [{"version": 1}],
            [
                {
                    "namespace": "python-deployment",
                    "queue_name": "mail",
                    "max_active": 8,
                    "max_active_per_key": 2,
                    "updated_at": updated_at,
                }
            ],
        ]
    )

    policies = Queue(connection).sync_concurrency_policies(
        "python-deployment",
        [ConcurrencyPolicyDefinition(queue="mail", max_active=8, max_active_per_key=2)],
    )

    assert policies[0].namespace == "python-deployment"
    assert policies[0].queue == "mail"
    assert policies[0].max_active == 8
    assert policies[0].max_active_per_key == 2
    assert policies[0].updated_at == updated_at
    assert json.loads(connection.calls[1][1][1]) == [
        {"queue": "mail", "maxActive": 8, "maxActivePerKey": 2}
    ]
    assert connection.calls[1][1][2] is True


def test_sync_client_refuses_an_incompatible_schema_before_policy_mutation() -> None:
    connection = Connection([[{"version": 0}]])

    with pytest.raises(ProtocolCompatibilityError, match="schema"):
        Queue(connection).sync_rate_limit_policies("python-deployment", [])

    assert len(connection.calls) == 1


def _policy_count(database_url: str, table: str) -> int:
    with psycopg.connect(database_url, autocommit=True) as observer:
        row = observer.execute(f"SELECT count(*) FROM workhorse.{table}").fetchone()
    assert row is not None
    return int(row[0])


@pytest.mark.integration
def test_psycopg_synchronizes_lists_prunes_and_preserves_the_transaction(
    database_url: str,
) -> None:
    connection = psycopg.connect(database_url)
    try:
        with (
            pytest.raises(RuntimeError, match="application rollback"),
            connection.transaction(),
        ):
            queue = Queue(connection)
            concurrency = queue.sync_concurrency_policies(
                "python-deployment",
                [
                    ConcurrencyPolicyDefinition("mail", 8, 2),
                    ConcurrencyPolicyDefinition("reports", 3),
                ],
            )
            assert [policy.queue for policy in concurrency] == ["mail", "reports"]
            preserved = queue.sync_concurrency_policies(
                "python-deployment",
                [ConcurrencyPolicyDefinition("mail", 5)],
                prune=False,
            )
            assert [policy.queue for policy in preserved] == ["mail", "reports"]
            assert [
                policy.queue for policy in queue.list_concurrency_policies(["reports", "mail"])
            ] == ["mail", "reports"]
            authoritative = queue.sync_concurrency_policies(
                "python-deployment",
                [ConcurrencyPolicyDefinition("mail", 4)],
            )
            assert [policy.queue for policy in authoritative] == ["mail"]

            rate_limits = queue.sync_rate_limit_policies(
                "python-deployment",
                [
                    RateLimitPolicyDefinition(
                        "mail",
                        RateLimit(limit=10, interval_ms=1_000, burst=20),
                        RateLimit(limit=2, interval_ms=5_000, burst=3),
                    ),
                    RateLimitPolicyDefinition(
                        "reports", RateLimit(limit=1, interval_ms=60_000, burst=1)
                    ),
                ],
            )
            assert rate_limits[0].rate.limit == 10
            assert rate_limits[0].per_key is not None
            assert rate_limits[0].per_key.interval_ms == 5_000
            assert rate_limits[1].per_key is None
            assert [
                policy.queue for policy in queue.list_rate_limit_policies(["reports", "mail"])
            ] == ["mail", "reports"]
            authoritative_rate_limits = queue.sync_rate_limit_policies(
                "python-deployment",
                [RateLimitPolicyDefinition("mail", RateLimit(20, 2_000, 30))],
            )
            assert [policy.queue for policy in authoritative_rate_limits] == ["mail"]
            assert _policy_count(database_url, "concurrency_policy") == 0
            assert _policy_count(database_url, "rate_limit_policy") == 0
            raise RuntimeError("application rollback")

        assert _policy_count(database_url, "concurrency_policy") == 0
        assert _policy_count(database_url, "rate_limit_policy") == 0

        with (
            pytest.raises(psycopg.errors.RaiseException) as raised,
            connection.transaction(),
        ):
            Queue(connection).sync_concurrency_policies(
                "python-deployment",
                [ConcurrencyPolicyDefinition("mail", 1, 2)],
            )
        assert raised.value.sqlstate == "P0001"
    finally:
        connection.close()


@pytest.mark.integration
@pytest.mark.asyncio
async def test_asyncpg_synchronizes_and_lists_both_policy_types(database_url: str) -> None:
    connection = await asyncpg.connect(database_url)
    try:
        transaction = connection.transaction()
        await transaction.start()
        queue = AsyncQueue.from_asyncpg(connection)
        concurrency = await queue.sync_concurrency_policies(
            "python-asyncpg",
            [ConcurrencyPolicyDefinition("mail", 4)],
        )
        rate_limits = await queue.sync_rate_limit_policies(
            "python-asyncpg",
            [RateLimitPolicyDefinition("mail", RateLimit(5, 1_000, 10))],
        )
        assert concurrency[0].max_active == 4
        assert rate_limits[0].rate == RateLimit(5, 1_000, 10)
        assert len(await queue.list_concurrency_policies()) == 1
        assert len(await queue.list_rate_limit_policies()) == 1
        await transaction.rollback()
    finally:
        await connection.close()

    assert _policy_count(database_url, "concurrency_policy") == 0
    assert _policy_count(database_url, "rate_limit_policy") == 0


@pytest.mark.integration
@pytest.mark.asyncio
async def test_async_psycopg_synchronizes_and_lists_both_policy_types(
    database_url: str,
) -> None:
    connection = await psycopg.AsyncConnection.connect(database_url)
    try:
        async with connection.transaction():
            queue = AsyncQueue.from_psycopg(connection)
            await queue.sync_concurrency_policies(
                "python-async-psycopg",
                [ConcurrencyPolicyDefinition("mail", 4)],
            )
            await queue.sync_rate_limit_policies(
                "python-async-psycopg",
                [RateLimitPolicyDefinition("mail", RateLimit(5, 1_000, 10))],
            )
            assert len(await queue.list_concurrency_policies(["mail"])) == 1
            assert len(await queue.list_rate_limit_policies(["mail"])) == 1
    finally:
        await connection.close()
