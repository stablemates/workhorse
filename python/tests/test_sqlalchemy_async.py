from __future__ import annotations

import asyncio
import json
import sys
from collections.abc import AsyncIterator
from pathlib import Path

import asyncpg
import psycopg
import pytest
import pytest_asyncio
from psycopg.pq import TransactionStatus
from sqlalchemy import String, text
from sqlalchemy.engine import make_url
from sqlalchemy.ext.asyncio import (
    AsyncConnection,
    AsyncEngine,
    async_sessionmaker,
    create_async_engine,
)
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column

from workhorse import (
    AsyncAdmin,
    AsyncQueue,
    EnqueueIdempotencyConflictError,
    EnqueueOptions,
    Idempotency,
)

pytestmark = pytest.mark.integration


class Base(DeclarativeBase):
    pass


class BusinessRow(Base):
    __tablename__ = "sqlalchemy_async_business"

    id: Mapped[str] = mapped_column(String, primary_key=True)


@pytest_asyncio.fixture
async def engine(database_url: str) -> AsyncIterator[AsyncEngine]:
    resource = create_async_engine(
        make_url(database_url).set(drivername="postgresql+psycopg"), pool_size=1, max_overflow=0
    )
    try:
        async with resource.begin() as connection:
            await connection.run_sync(Base.metadata.create_all)
        yield resource
    finally:
        await resource.dispose()


async def counts(database_url: str) -> tuple[int, int]:
    async with await psycopg.AsyncConnection.connect(database_url, autocommit=True) as observer:
        cursor = await observer.execute(
            "SELECT (SELECT count(*) FROM sqlalchemy_async_business), "
            "(SELECT count(*) FROM workhorse.task)"
        )
        row = await cursor.fetchone()
        assert row is not None
        return row[0], row[1]


async def psycopg_driver(connection: AsyncConnection) -> psycopg.AsyncConnection:
    raw = await connection.get_raw_connection()
    driver = raw.driver_connection
    assert isinstance(driver, psycopg.AsyncConnection)
    assert not driver.autocommit
    return driver


async def assert_identity(connection: AsyncConnection, driver: psycopg.AsyncConnection) -> None:
    sqlalchemy_identity = (
        await connection.execute(text("SELECT pg_backend_pid(), txid_current()"))
    ).one()
    cursor = await driver.execute("SELECT pg_backend_pid(), txid_current()")
    assert await cursor.fetchone() == tuple(sqlalchemy_identity)
    assert sqlalchemy_identity[0] == driver.info.backend_pid


async def write_business(connection: AsyncConnection, identifier: str) -> None:
    await connection.execute(
        text("INSERT INTO sqlalchemy_async_business (id) VALUES (:id)"), {"id": identifier}
    )


@pytest.mark.parametrize("enqueue_first", [True, False], ids=["enqueue-first", "business-first"])
@pytest.mark.parametrize("commit", [True, False], ids=["commit", "rollback"])
async def test_get_raw_connection_driver_connection_joint_completion_and_reuse(
    engine: AsyncEngine, database_url: str, enqueue_first: bool, commit: bool
) -> None:
    async with engine.connect() as connection:
        transaction = await connection.begin()
        driver = await psycopg_driver(connection)
        assert driver.info.transaction_status == TransactionStatus.IDLE
        if not enqueue_first:
            await write_business(connection, "business")
        result = await AsyncQueue.from_psycopg(driver).enqueue_with_result("account.created", {})
        assert result.outcome == "accepted"
        if enqueue_first:
            await write_business(connection, "business")
        await assert_identity(connection, driver)
        assert await counts(database_url) == (0, 0)
        if commit:
            await transaction.commit()
        else:
            await transaction.rollback()
        assert driver.info.transaction_status == TransactionStatus.IDLE
    assert await counts(database_url) == ((1, 1) if commit else (0, 0))
    assert not driver.closed
    async with engine.begin() as reused:
        assert await psycopg_driver(reused) is driver
        await write_business(reused, "reused")
        await AsyncQueue.from_psycopg(driver).enqueue("account.created", {"reused": True})
    assert await counts(database_url) == ((2, 2) if commit else (1, 1))


@pytest.mark.parametrize("release", [True, False], ids=["release-savepoint", "rollback-savepoint"])
@pytest.mark.parametrize("commit", [True, False], ids=["commit-outer", "rollback-outer"])
async def test_savepoint_completion_never_commits_outer_transaction(
    engine: AsyncEngine, database_url: str, release: bool, commit: bool
) -> None:
    async with engine.connect() as connection:
        outer = await connection.begin()
        driver = await psycopg_driver(connection)
        queue = AsyncQueue.from_psycopg(driver)
        await queue.enqueue("outer", {})
        await write_business(connection, "outer")
        nested = await connection.begin_nested()
        await queue.enqueue("inner", {})
        await write_business(connection, "inner")
        await assert_identity(connection, driver)
        if release:
            await nested.commit()
        else:
            await nested.rollback()
        assert await counts(database_url) == (0, 0)
        if commit:
            await outer.commit()
        else:
            await outer.rollback()
    expected = (2 if release else 1) if commit else 0
    assert await counts(database_url) == (expected, expected)
    async with engine.begin() as reused:
        assert await psycopg_driver(reused) is driver
        await AsyncQueue.from_psycopg(driver).enqueue("reuse", {})


@pytest.mark.parametrize("commit", [True, False], ids=["commit", "rollback"])
async def test_session_flush_and_enlisted_connection(
    engine: AsyncEngine, database_url: str, commit: bool
) -> None:
    sessions = async_sessionmaker(engine)
    async with sessions() as session:
        transaction = await session.begin()
        session.add(BusinessRow(id="session"))
        assert await counts(database_url) == (0, 0)
        await session.flush()
        connection = await session.connection()
        driver = await psycopg_driver(connection)
        await assert_identity(connection, driver)
        await AsyncQueue.from_psycopg(driver).enqueue("account.created", {"id": "session"})
        assert await counts(database_url) == (0, 0)
        if commit:
            await transaction.commit()
        else:
            await transaction.rollback()
    assert await counts(database_url) == ((1, 1) if commit else (0, 0))
    async with engine.begin() as reused:
        assert await psycopg_driver(reused) is driver


async def test_results_and_structured_conflict_escape_savepoint(
    engine: AsyncEngine, database_url: str
) -> None:
    async with engine.begin() as connection:
        driver = await psycopg_driver(connection)
        queue = AsyncQueue.from_psycopg(driver)
        options = EnqueueOptions(idempotency=Idempotency("same"))
        inserted = await queue.enqueue_with_result("account.created", {"id": "same"}, options)
        replay = await queue.enqueue_with_result("account.created", {"id": "same"}, options)
        assert replay.task_id == inserted.task_id
        assert replay.outcome == "replayed"
        with pytest.raises(EnqueueIdempotencyConflictError) as failure:
            async with connection.begin_nested():
                await write_business(connection, "rolled-back")
                await queue.enqueue("account.created", {"different": True}, options)
        assert failure.value.details["existingTaskId"] == inserted.task_id
        assert failure.value.details["conflictingFields"] == ["payload"]
        assert isinstance(failure.value.__cause__, psycopg.Error)
        assert failure.value.__cause__.sqlstate == "P1001"
        await write_business(connection, "survives")
        assert await counts(database_url) == (0, 0)
    assert await counts(database_url) == (1, 1)


async def test_cancellation_rolls_back_and_returns_enlisted_connection(
    engine: AsyncEngine, database_url: str
) -> None:
    accepted = asyncio.Event()
    waiting = asyncio.Event()
    drivers: list[psycopg.AsyncConnection] = []

    async def application() -> None:
        async with engine.begin() as connection:
            driver = await psycopg_driver(connection)
            drivers.append(driver)
            await write_business(connection, "canceled")
            await AsyncQueue.from_psycopg(driver).enqueue("account.created", {})
            accepted.set()
            await waiting.wait()

    task = asyncio.create_task(application())
    try:
        await asyncio.wait_for(accepted.wait(), timeout=10)
        assert await counts(database_url) == (0, 0)
    finally:
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
    assert await counts(database_url) == (0, 0)
    async with engine.begin() as reused:
        assert await psycopg_driver(reused) is drivers[0]
        await write_business(reused, "after-cancel")
        await AsyncQueue.from_psycopg(drivers[0]).enqueue("account.created", {})
    assert await counts(database_url) == (1, 1)


async def test_cancel_in_flight_enqueue_recovers_pool(
    engine: AsyncEngine, database_url: str
) -> None:
    acquired = asyncio.Event()
    drivers: list[psycopg.AsyncConnection] = []

    async def application() -> None:
        async with engine.begin() as connection:
            driver = await psycopg_driver(connection)
            drivers.append(driver)
            await write_business(connection, "canceled")
            acquired.set()
            await AsyncQueue.from_psycopg(driver).enqueue("account.created", {})

    async with await psycopg.AsyncConnection.connect(database_url) as blocker:
        await blocker.execute("LOCK TABLE workhorse.task IN ACCESS EXCLUSIVE MODE")
        task = asyncio.create_task(application())
        try:
            async with asyncio.timeout(10):
                await acquired.wait()
                async with await psycopg.AsyncConnection.connect(
                    database_url, autocommit=True
                ) as observer:
                    while True:
                        cursor = await observer.execute(
                            "SELECT wait_event_type FROM pg_stat_activity WHERE pid = %s",
                            (drivers[0].info.backend_pid,),
                        )
                        if await cursor.fetchone() == ("Lock",):
                            break
                        await asyncio.sleep(0.01)
        finally:
            task.cancel()
            with pytest.raises(asyncio.CancelledError):
                await task
        await blocker.rollback()
    assert await counts(database_url) == (0, 0)
    async with engine.begin() as reused:
        driver = await psycopg_driver(reused)
        await write_business(reused, "after-cancel")
        await AsyncQueue.from_psycopg(driver).enqueue("account.created", {})
    assert await counts(database_url) == (1, 1)


async def test_runnable_session_example(database_url: str) -> None:
    path = Path(__file__).parents[1] / "examples" / "sqlalchemy_async_enqueue.py"
    process = await asyncio.create_subprocess_exec(
        sys.executable,
        str(path),
        database_url,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    try:
        stdout, stderr = await asyncio.wait_for(process.communicate(), timeout=20)
    finally:
        if process.returncode is None:
            process.kill()
            await process.wait()
    assert process.returncode == 0, stderr.decode()
    task_id = stdout.decode().strip()
    async with await psycopg.AsyncConnection.connect(database_url, autocommit=True) as observer:
        cursor = await observer.execute(
            "SELECT account.id, task.payload FROM sqlalchemy_async_example_account account "
            "JOIN workhorse.task task ON task.payload->>'accountId' = account.id "
            "WHERE task.id = %s",
            (task_id,),
        )
        row = await cursor.fetchone()
        assert row is not None
        assert row[1] == {"accountId": row[0]}


async def test_asyncpg_logical_begin_does_not_enlist_raw_enqueue(database_url: str) -> None:
    resource = create_async_engine(make_url(database_url).set(drivername="postgresql+asyncpg"))
    try:
        async with resource.begin() as connection:
            await connection.run_sync(Base.metadata.create_all)
        async with resource.connect() as connection:
            transaction = await connection.begin()
            raw = await connection.get_raw_connection()
            driver = raw.driver_connection
            assert isinstance(driver, asyncpg.Connection)
            assert connection.in_transaction()
            assert not driver.is_in_transaction()
            await AsyncQueue.from_asyncpg(driver).enqueue("not-enlisted", {})
            assert not driver.is_in_transaction()
            assert await counts(database_url) == (0, 1)
            await write_business(connection, "rolled-back")
            assert driver.is_in_transaction()
            await transaction.rollback()
        assert await counts(database_url) == (0, 1)
    finally:
        await resource.dispose()


@pytest.mark.parametrize("commit", [True, False], ids=["commit", "rollback"])
async def test_asyncpg_public_statement_starts_transaction_and_nested_savepoint(
    database_url: str, commit: bool
) -> None:
    resource = create_async_engine(make_url(database_url).set(drivername="postgresql+asyncpg"))
    try:
        async with resource.begin() as connection:
            await connection.run_sync(Base.metadata.create_all)
        async with resource.connect() as connection:
            outer = await connection.begin()
            raw = await connection.get_raw_connection()
            driver = raw.driver_connection
            assert isinstance(driver, asyncpg.Connection)
            assert not driver.is_in_transaction()
            sqlalchemy_identity = (
                await connection.execute(text("SELECT pg_backend_pid(), txid_current()"))
            ).one()
            assert driver.is_in_transaction()
            assert tuple(await driver.fetchrow("SELECT pg_backend_pid(), txid_current()")) == tuple(
                sqlalchemy_identity
            )
            queue = AsyncQueue.from_asyncpg(driver)
            await queue.enqueue("outer", {})
            await write_business(connection, "outer")
            nested = await connection.begin_nested()
            await queue.enqueue("rolled-back", {})
            await write_business(connection, "rolled-back")
            await nested.rollback()
            async with connection.begin_nested():
                await queue.enqueue("released", {})
                await write_business(connection, "released")
            assert await counts(database_url) == (0, 0)
            if commit:
                await outer.commit()
            else:
                await outer.rollback()
        assert await counts(database_url) == ((2, 2) if commit else (0, 0))
    finally:
        await resource.dispose()


@pytest.mark.parametrize(
    "payload", [{"object": True}, ["array"], 42, True, None, "plain", "123", '"quoted"']
)
async def test_asyncpg_default_json_scalar_codec_discriminator(
    database_url: str, payload: object
) -> None:
    resource = create_async_engine(make_url(database_url).set(drivername="postgresql+asyncpg"))
    try:
        async with resource.begin() as connection:
            await connection.execute(text("SELECT 1"))
            raw = await connection.get_raw_connection()
            driver = raw.driver_connection
            assert isinstance(driver, asyncpg.Connection)
            assert await driver.fetchval("SELECT $1::json", json.dumps(payload)) == payload
            assert await driver.fetchval("SELECT $1::jsonb", json.dumps(payload)) == payload
            task_id = await AsyncQueue.from_asyncpg(driver).enqueue("codec", payload)
            admin = AsyncAdmin.from_asyncpg(driver)
            if payload == "plain":
                with pytest.raises(json.JSONDecodeError):
                    await admin.get_task(task_id)
            else:
                snapshot = await admin.get_task(task_id)
                assert snapshot is not None
                if isinstance(payload, str):
                    assert snapshot.payload == json.loads(payload)
                    assert snapshot.payload != payload
                else:
                    assert snapshot.payload == payload
    finally:
        await resource.dispose()


async def test_asyncpg_custom_json_deserializer_is_not_workhorse_compatible(
    database_url: str,
) -> None:
    resource = create_async_engine(
        make_url(database_url).set(drivername="postgresql+asyncpg"),
        json_deserializer=lambda value: {"custom": json.loads(value)},
    )
    try:
        async with resource.begin() as connection:
            await connection.execute(text("SELECT 1"))
            raw = await connection.get_raw_connection()
            driver = raw.driver_connection
            assert isinstance(driver, asyncpg.Connection)
            payload = {"id": "business"}
            for postgres_type in ("json", "jsonb"):
                assert await driver.fetchval(
                    f"SELECT $1::{postgres_type}", json.dumps(payload)
                ) == {"custom": payload}
            task_id = await AsyncQueue.from_asyncpg(driver).enqueue("codec", payload)
            snapshot = await AsyncAdmin.from_asyncpg(driver).get_task(task_id)
            assert snapshot is not None
            assert snapshot.payload == {"custom": payload}
            assert snapshot.payload != payload
    finally:
        await resource.dispose()
