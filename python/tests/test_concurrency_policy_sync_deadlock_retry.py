from __future__ import annotations

import asyncpg
import psycopg
import pytest

from workhorse import AsyncQueue, ConcurrencyPolicyDefinition, Queue
from workhorse._fenced_write import FENCED_WRITE_DEADLOCK_ATTEMPTS

_MAIL = [ConcurrencyPolicyDefinition("mail", 2)]


def _force_sync_failures(database_url: str, code: str, forced: int) -> None:
    """Make the first `forced` syncs fail with `code` at their first policy write.

    The sequence counts each sync transaction that reached the table once, and a rollback does not
    undo it.
    """
    with psycopg.connect(database_url, autocommit=True) as setup:
        setup.execute(
            f"""
            CREATE SEQUENCE forced_sync_attempts;
            CREATE FUNCTION force_sync_failure() RETURNS trigger LANGUAGE plpgsql AS $$
            BEGIN
              IF current_setting('forced_sync.counted', true) IS DISTINCT FROM 'yes' THEN
                PERFORM set_config('forced_sync.counted', 'yes', true);
                IF nextval('forced_sync_attempts') <= {forced} THEN
                  RAISE EXCEPTION 'forced sync failure' USING ERRCODE = '{code}';
                END IF;
              END IF;
              RETURN NULL;
            END $$;
            CREATE TRIGGER force_sync_failure BEFORE INSERT OR UPDATE OR DELETE
              ON workhorse.concurrency_policy
              FOR EACH STATEMENT EXECUTE FUNCTION force_sync_failure();
            """
        )


def _sync_attempts(database_url: str) -> int:
    with psycopg.connect(database_url, autocommit=True) as observer:
        row = observer.execute("SELECT last_value FROM forced_sync_attempts").fetchone()
    assert row is not None
    return int(row[0])


@pytest.mark.integration
def test_sync_resends_a_deadlock_victim(database_url: str) -> None:
    _force_sync_failures(database_url, "40P01", 1)
    with psycopg.connect(database_url, autocommit=True) as connection:
        policies = Queue(connection).sync_concurrency_policies("python-deployment", _MAIL)

    assert [(policy.queue, policy.max_active) for policy in policies] == [("mail", 2)]
    assert _sync_attempts(database_url) == 2


@pytest.mark.integration
def test_sync_raises_the_last_deadlock_after_every_attempt(database_url: str) -> None:
    _force_sync_failures(database_url, "40P01", FENCED_WRITE_DEADLOCK_ATTEMPTS)
    with (
        psycopg.connect(database_url, autocommit=True) as connection,
        pytest.raises(psycopg.errors.DeadlockDetected),
    ):
        Queue(connection).sync_concurrency_policies("python-deployment", _MAIL)

    assert FENCED_WRITE_DEADLOCK_ATTEMPTS == 3
    assert _sync_attempts(database_url) == FENCED_WRITE_DEADLOCK_ATTEMPTS


@pytest.mark.integration
def test_sync_sends_once_on_another_error(database_url: str) -> None:
    _force_sync_failures(database_url, "40001", 1)
    with (
        psycopg.connect(database_url, autocommit=True) as connection,
        pytest.raises(psycopg.errors.SerializationFailure),
    ):
        Queue(connection).sync_concurrency_policies("python-deployment", _MAIL)

    assert _sync_attempts(database_url) == 1


@pytest.mark.integration
def test_sync_reports_the_deadlock_that_aborted_a_caller_transaction(database_url: str) -> None:
    _force_sync_failures(database_url, "40P01", 1)
    with (
        psycopg.connect(database_url) as connection,
        pytest.raises(psycopg.errors.DeadlockDetected, match="forced sync failure"),
        connection.transaction(),
    ):
        Queue(connection).sync_concurrency_policies("python-deployment", _MAIL)

    # The resend failed with 25P02 before it reached the table, so only the deadlock counted.
    assert _sync_attempts(database_url) == 1


@pytest.mark.integration
@pytest.mark.asyncio
async def test_asyncpg_sync_resends_a_deadlock_victim(database_url: str) -> None:
    _force_sync_failures(database_url, "40P01", 1)
    connection = await asyncpg.connect(database_url)
    try:
        queue = AsyncQueue.from_asyncpg(connection)
        policies = await queue.sync_concurrency_policies("python-asyncpg", _MAIL)
    finally:
        await connection.close()

    assert [(policy.queue, policy.max_active) for policy in policies] == [("mail", 2)]
    assert _sync_attempts(database_url) == 2


@pytest.mark.integration
@pytest.mark.asyncio
async def test_asyncpg_sync_reports_the_deadlock_that_aborted_a_caller_transaction(
    database_url: str,
) -> None:
    _force_sync_failures(database_url, "40P01", 1)
    connection = await asyncpg.connect(database_url)
    try:
        transaction = connection.transaction()
        await transaction.start()
        queue = AsyncQueue.from_asyncpg(connection)
        with pytest.raises(asyncpg.exceptions.DeadlockDetectedError, match="forced sync failure"):
            await queue.sync_concurrency_policies("python-asyncpg", _MAIL)
        await transaction.rollback()
    finally:
        await connection.close()

    assert _sync_attempts(database_url) == 1


@pytest.mark.integration
@pytest.mark.asyncio
async def test_async_psycopg_sync_resends_a_deadlock_victim(database_url: str) -> None:
    _force_sync_failures(database_url, "40P01", 1)
    connection = await psycopg.AsyncConnection.connect(database_url, autocommit=True)
    try:
        queue = AsyncQueue.from_psycopg(connection)
        policies = await queue.sync_concurrency_policies("python-async-psycopg", _MAIL)
    finally:
        await connection.close()

    assert [(policy.queue, policy.max_active) for policy in policies] == [("mail", 2)]
    assert _sync_attempts(database_url) == 2
