"""A worker's maintenance time comes from the database clock, not from the host clock.

Maintenance writes shared due times and retention cutoffs. A host whose clock runs fast must not
move them forward for every other worker, or delete history before its retention age.
"""

from __future__ import annotations

from collections.abc import Sequence
from datetime import UTC, datetime, timedelta
from typing import Any

import asyncpg
import psycopg
import pytest

import workhorse.worker as worker_module
from workhorse import AsyncWorker, Worker
from workhorse._statements import STATEMENTS

_FAST = timedelta(days=2)


class _FastDatetime(datetime):
    """The worker module's clock, two days ahead of the real time."""

    @classmethod
    def now(cls, tz: Any = None) -> Any:
        return datetime.now(tz) + _FAST


class _Pool:
    max_size = 5


class _RecordingExecutor:
    def __init__(self, dialect: str) -> None:
        self.dialect = dialect
        self.calls: list[tuple[str, Sequence[object]]] = []
        self.database_time = datetime(2026, 8, 2, 12, tzinfo=UTC)

    def rows(self, statement: Any, parameters: Sequence[object] = ()) -> list[dict[str, object]]:
        self.calls.append((statement.psycopg, parameters))
        if statement is STATEMENTS.database_time:
            return [{"now": self.database_time}]
        return []


def _worker(executor: _RecordingExecutor) -> Worker:
    return Worker(_Pool(), queue="clock", worker_id="clock-worker", _executor=executor)


def test_psycopg_binds_the_text_now_and_not_a_local_time() -> None:
    executor = _RecordingExecutor("psycopg")

    assert _worker(executor)._maintenance_time() == "now"
    assert executor.calls == []


def test_asyncpg_reads_the_database_time_before_it_binds_one() -> None:
    executor = _RecordingExecutor("asyncpg")

    assert _worker(executor)._maintenance_time() == executor.database_time
    assert executor.calls == [(STATEMENTS.database_time.psycopg, ())]


def _prepare(connection: psycopg.Connection[Any], namespace: str) -> None:
    connection.execute(
        "INSERT INTO workhorse.schedule_definition("
        "namespace, schedule_name, cron_expression, queue_name, task_type, payload, max_attempts"
        ") VALUES (%s, 'daily', '0 0 * * *', 'default', 'clock-skew', '{}'::jsonb, 1)",
        (namespace,),
    )
    connection.execute(
        "INSERT INTO workhorse.schedule_occurrence(namespace, schedule_name, occurrence_at) "
        "VALUES (%s, 'daily', clock_timestamp() - interval '13 days')",
        (namespace,),
    )
    connection.execute(
        "UPDATE workhorse.retention_policy SET schedule_occurrence_retention_days = 14"
    )
    connection.execute(
        "UPDATE workhorse.maintenance_policy "
        "SET timezone = 'UTC', history_retention_local_time = '00:00'"
    )
    connection.execute(
        "UPDATE workhorse.maintenance_state "
        "SET last_started_at = NULL, last_completed_at = NULL, last_completed_local_date = NULL "
        "WHERE routine_name IN ('history_partitions', 'history_retention')"
    )


def _assert_on_database_clock(connection: psycopg.Connection[Any], namespace: str) -> None:
    occurrences = connection.execute(
        "SELECT count(*) FROM workhorse.schedule_occurrence WHERE namespace = %s",
        (namespace,),
    ).fetchone()
    assert occurrences == (1,)
    routines = connection.execute(
        "SELECT routine_name, last_started_at > clock_timestamp(), last_started_at IS NOT NULL "
        "FROM workhorse.maintenance_state "
        "WHERE routine_name IN ('history_partitions', 'history_retention') "
        "ORDER BY routine_name"
    ).fetchall()
    assert routines == [("history_partitions", False, True), ("history_retention", False, True)]


def test_a_fast_worker_clock_keeps_due_state_and_retention_on_the_database_clock(
    database_url: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    with psycopg.connect(database_url, autocommit=True) as connection:
        _prepare(connection, "clock-skew-psycopg")
        worker = Worker(worker_pool, worker_id="python-fast-clock-worker")  # noqa: F821
        monkeypatch.setattr(worker_module, "datetime", _FastDatetime)

        worker.run_once()

        _assert_on_database_clock(connection, "clock-skew-psycopg")


async def _run_fast_async_worker(
    database_url: str, worker: AsyncWorker, namespace: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    with psycopg.connect(database_url, autocommit=True) as connection:
        _prepare(connection, namespace)
        monkeypatch.setattr(worker_module, "datetime", _FastDatetime)

        await worker.run_once()

        _assert_on_database_clock(connection, namespace)


@pytest.mark.asyncio
async def test_a_fast_async_psycopg_worker_clock_keeps_maintenance_on_the_database_clock(
    database_url: str, async_psycopg_pool: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    worker = AsyncWorker.from_psycopg(async_psycopg_pool, worker_id="python-fast-clock-psycopg")
    await _run_fast_async_worker(database_url, worker, "clock-skew-async-psycopg", monkeypatch)


@pytest.mark.asyncio
async def test_a_fast_asyncpg_worker_clock_keeps_maintenance_on_the_database_clock(
    database_url: str, asyncpg_pool: asyncpg.Pool, monkeypatch: pytest.MonkeyPatch
) -> None:
    worker = AsyncWorker.from_asyncpg(asyncpg_pool, worker_id="python-fast-clock-asyncpg")
    await _run_fast_async_worker(database_url, worker, "clock-skew-asyncpg", monkeypatch)
