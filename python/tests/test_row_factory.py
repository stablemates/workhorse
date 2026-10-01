from __future__ import annotations

import uuid
from dataclasses import dataclass
from typing import Any

import psycopg
import pytest
from psycopg.rows import RowFactory, class_row, dict_row, tuple_row
from psycopg_pool import AsyncConnectionPool, ConnectionPool

from workhorse import (
    Admin,
    AsyncAdmin,
    AsyncQueue,
    AsyncWorker,
    Queue,
    Worker,
    assert_schema_compatible,
    assert_schema_compatible_psycopg,
)

pytestmark = pytest.mark.integration


@dataclass(frozen=True)
class Probe:
    value: int


# Each case names a caller's row factory and the row it must return for the probe query.
ROW_FACTORIES: list[tuple[str, RowFactory[Any], object]] = [
    ("tuple_row", tuple_row, (1,)),
    ("dict_row", dict_row, {"value": 1}),
    ("class_row", class_row(Probe), Probe(value=1)),
]
PROBE = "SELECT 1 AS value"


def outcome(database_url: str, task_id: str) -> tuple[object, ...] | None:
    with psycopg.connect(database_url, autocommit=True) as observer:
        return observer.execute(
            "SELECT state, result FROM workhorse.task_outcome WHERE task_id = %s", (task_id,)
        ).fetchone()


@pytest.mark.parametrize(
    ("factory", "probe"),
    [(factory, probe) for _name, factory, probe in ROW_FACTORIES],
    ids=[name for name, _factory, _probe in ROW_FACTORIES],
)
def test_sync_sdk_ignores_the_callers_row_factory(
    database_url: str, factory: RowFactory[Any], probe: object
) -> None:
    with psycopg.connect(database_url, autocommit=True, row_factory=factory) as connection:
        assert_schema_compatible(connection)
        task_id = Queue(connection).enqueue("row.factory", {"value": 2})
        assert uuid.UUID(task_id)
        snapshot = Admin(connection).get_task(task_id)
        assert snapshot is not None
        assert (snapshot.id, snapshot.type, snapshot.payload) == (
            task_id,
            "row.factory",
            {"value": 2},
        )

        with ConnectionPool(
            database_url,
            min_size=1,
            max_size=3,
            kwargs={"autocommit": True, "row_factory": factory},
            open=True,
        ) as pool:
            worker = Worker(pool, worker_id="python-row-factory").handle(
                "row.factory", lambda payload, _context: {"doubled": payload["value"] * 2}
            )
            assert worker.run_once() is True

        assert outcome(database_url, task_id) == ("succeeded", {"doubled": 4})
        assert connection.row_factory is factory
        assert connection.execute(PROBE).fetchone() == probe


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("factory", "probe"),
    [(factory, probe) for _name, factory, probe in ROW_FACTORIES],
    ids=[name for name, _factory, _probe in ROW_FACTORIES],
)
async def test_async_sdk_ignores_the_callers_row_factory(
    database_url: str, factory: RowFactory[Any], probe: object
) -> None:
    async with await psycopg.AsyncConnection.connect(
        database_url, autocommit=True, row_factory=factory
    ) as connection:
        await assert_schema_compatible_psycopg(connection)
        task_id = await AsyncQueue.from_psycopg(connection).enqueue("row.factory", {"value": 3})
        assert uuid.UUID(task_id)
        snapshot = await AsyncAdmin.from_psycopg(connection).get_task(task_id)
        assert snapshot is not None
        assert (snapshot.id, snapshot.type, snapshot.payload) == (
            task_id,
            "row.factory",
            {"value": 3},
        )

        async with AsyncConnectionPool(
            database_url,
            min_size=1,
            max_size=3,
            kwargs={"autocommit": True, "row_factory": factory},
            open=False,
        ) as pool:

            async def handler(payload: Any, _context: Any) -> dict[str, int]:
                return {"doubled": payload["value"] * 2}

            worker = AsyncWorker.from_psycopg(pool, worker_id="python-row-factory").handle(
                "row.factory", handler
            )
            assert await worker.run_once() is True

        assert outcome(database_url, task_id) == ("succeeded", {"doubled": 6})
        assert connection.row_factory is factory
        cursor = await connection.execute(PROBE)
        assert await cursor.fetchone() == probe
