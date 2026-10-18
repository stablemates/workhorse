"""SM-1449: a slow preparation of a heartbeat statement cannot extend the server deadline.

PostgreSQL restarts `statement_timeout` after a preparation that runs in a cycle of its own. If that
preparation came after the round set its server budgets, the heartbeat would get a full budget after
it, and the round could end on the server after its deadline. The doubles below act as the drivers
do in the worst case: psycopg with `prepare_threshold=0`, and asyncpg, which prepares a statement in
its own cycle on its first use. A fake clock makes the preparation slow, so no test depends on the
speed of the host.
"""

from __future__ import annotations

import asyncio
from collections.abc import Callable, Iterator, Sequence
from dataclasses import dataclass, field
from threading import Thread
from typing import Any

import asyncpg
import psycopg
import pytest

import workhorse.worker as worker_module
from workhorse._drivers import AsyncpgExecutor, AsyncPsycopgExecutor, SyncExecutor
from workhorse._heartbeat_round import ROUND_TIMEOUTS
from workhorse._statements import DriverStatement
from workhorse.async_worker import _AsyncExecutorBridge

HEARTBEAT = DriverStatement(psycopg="SELECT heartbeat(%s)", asyncpg="SELECT heartbeat($1)")
ROUND_BOUND_SECONDS = 1.0
# Each preparation uses almost a third of the bound. asyncpg prepares two statements.
PREPARATION_SECONDS = 0.3


@dataclass
class Server:
    """Record each cycle that the doubles send, on a fake monotonic clock."""

    now: float = 1_000.0
    prepared: set[str] = field(default_factory=set)
    # (kind, sql, at, parameters). A "parse" is a preparation in a cycle of its own; a "run" is an
    # execution cycle, which also parses a statement that is not prepared.
    events: list[tuple[str, str, float, tuple[object, ...]]] = field(default_factory=list)

    def monotonic(self) -> float:
        return self.now

    def parse(self, sql: str) -> None:
        self.events.append(("parse", sql, self.now, ()))
        self.now += PREPARATION_SECONDS
        self.prepared.add(sql)

    def run(
        self, sql: str, parameters: Sequence[object], *, parse_first: bool
    ) -> tuple[list[tuple[str]], list[tuple[object, ...]]]:
        if parse_first and sql not in self.prepared:
            self.parse(sql)
        self.events.append(("run", sql, self.now, tuple(parameters)))
        if "set_config" in sql:
            return [("statement",), ("idle",)], [tuple(parameters)]
        return [("ok",)], [(True,)]


class SyncCursor:
    def __init__(self, server: Server) -> None:
        self._server = server
        self.description: Any = None
        self._rows: list[tuple[object, ...]] = []

    def __enter__(self) -> SyncCursor:
        return self

    def __exit__(self, *args: object) -> None:
        return None

    def execute(
        self, sql: str, parameters: Sequence[object] = (), *, prepare: bool | None = None
    ) -> None:
        # With prepare_threshold=0, psycopg prepares every statement on first use.
        self.description, self._rows = self._server.run(
            sql, parameters, parse_first=prepare is not False
        )

    def fetchall(self) -> list[tuple[object, ...]]:
        return self._rows


class SyncConnection:
    def __init__(self, server: Server) -> None:
        self._server = server

    def cursor(self, *, row_factory: Any) -> SyncCursor:  # noqa: ARG002
        return SyncCursor(self._server)


class AsyncCursor(SyncCursor):
    async def __aenter__(self) -> AsyncCursor:
        return self

    async def __aexit__(self, *args: object) -> None:
        return None

    async def execute(  # type: ignore[override]
        self, sql: str, parameters: Sequence[object] = (), *, prepare: bool | None = None
    ) -> None:
        SyncCursor.execute(self, sql, parameters, prepare=prepare)

    async def fetchall(self) -> list[tuple[object, ...]]:  # type: ignore[override]
        return self._rows


class AsyncPsycopgConnection(SyncConnection):
    autocommit = True

    def cursor(self, *, row_factory: Any) -> AsyncCursor:  # noqa: ARG002
        return AsyncCursor(self._server)


def records(
    result: tuple[list[tuple[str]], list[tuple[object, ...]]],
) -> list[dict[str, object]]:
    columns, rows = result
    return [dict(zip([column[0] for column in columns], row, strict=True)) for row in rows]


class AsyncpgPrepared:
    def __init__(self, server: Server, sql: str) -> None:
        self._server = server
        self._sql = sql

    async def fetch(self, *args: object) -> list[dict[str, object]]:
        return records(self._server.run(self._sql, args, parse_first=False))


class AsyncpgConnection:
    def __init__(self, server: Server) -> None:
        self._server = server

    async def prepare(self, sql: str) -> AsyncpgPrepared:
        self._server.parse(sql)
        return AsyncpgPrepared(self._server, sql)

    async def fetch(self, sql: str, *args: object) -> list[dict[str, object]]:
        # asyncpg prepares a statement in a cycle of its own on its first use on a connection.
        return records(self._server.run(sql, args, parse_first=True))

    async def execute(self, sql: str, *args: object) -> str:
        # Without arguments, asyncpg sends a simple query.
        self._server.run(sql, args, parse_first=bool(args))
        return "OK"

    def is_in_transaction(self) -> bool:
        return False


@pytest.fixture
def server(monkeypatch: pytest.MonkeyPatch) -> Server:
    server = Server()
    monkeypatch.setattr(worker_module, "monotonic", server.monotonic)
    return server


@pytest.fixture
def loop() -> Iterator[asyncio.AbstractEventLoop]:
    loop = asyncio.new_event_loop()
    thread = Thread(target=loop.run_forever, daemon=True)
    thread.start()
    try:
        yield loop
    finally:
        loop.call_soon_threadsafe(loop.stop)
        thread.join(5)
        loop.close()


def bridge(executor: Any, loop: asyncio.AbstractEventLoop) -> _AsyncExecutorBridge:
    bridged = _AsyncExecutorBridge(executor)
    bridged.bind(loop)
    return bridged


# Each entry builds the heartbeat executor as the worker builds it for that driver.
EXECUTORS: dict[str, Callable[[Server, asyncio.AbstractEventLoop], Any]] = {
    "sync psycopg": lambda server, _loop: SyncExecutor(SyncConnection(server), prepare=False),
    "async psycopg": lambda server, loop: bridge(
        AsyncPsycopgExecutor(AsyncPsycopgConnection(server), prepare=False), loop
    ),
    "asyncpg": lambda server, loop: bridge(AsyncpgExecutor(AsyncpgConnection(server)), loop),
}


@pytest.mark.parametrize("driver", list(EXECUTORS))
def test_a_slow_preparation_does_not_extend_the_server_deadline_of_a_round(
    driver: str, server: Server, loop: asyncio.AbstractEventLoop
) -> None:
    executor = EXECUTORS[driver](server, loop)
    deadline = server.now + ROUND_BOUND_SECONDS

    rows = worker_module._ServerBoundedExecutor(executor, deadline).rows(HEARTBEAT, ("lease",))

    assert rows == [{"ok": True}]
    settings = [
        index
        for index, (kind, sql, _, _) in enumerate(server.events)
        if kind == "run" and "set_config" in sql
    ]
    assert len(settings) == 1
    _, _, set_at, (statement_ms, idle_ms) = server.events[settings[0]]
    # After the budgets are set, the round runs the heartbeat and COMMIT, and prepares nothing in a
    # cycle of its own.
    after = [(kind, sql) for kind, sql, _, _ in server.events[settings[0] + 1 :]]
    assert after == [
        ("run", HEARTBEAT.for_dialect(executor.dialect)),
        ("run", "COMMIT"),
    ]
    # PostgreSQL ends the heartbeat and both idle gaps by the deadline.
    server_end = set_at + (int(str(statement_ms)) + 2 * int(str(idle_ms))) / 1000
    assert server_end <= deadline


def test_asyncpg_prepares_the_heartbeat_statement_once_on_each_connection(
    server: Server, loop: asyncio.AbstractEventLoop
) -> None:
    executor = EXECUTORS["asyncpg"](server, loop)
    for _ in range(2):
        deadline = server.now + 2 * ROUND_BOUND_SECONDS + 2 * PREPARATION_SECONDS
        worker_module._ServerBoundedExecutor(executor, deadline).rows(HEARTBEAT, ("lease",))

    parsed = [sql for kind, sql, _, _ in server.events if kind == "parse"]
    assert parsed == [ROUND_TIMEOUTS.asyncpg, HEARTBEAT.asyncpg]


def test_a_preparation_that_uses_the_whole_bound_fails_the_round_before_it_begins(
    server: Server, loop: asyncio.AbstractEventLoop
) -> None:
    executor = EXECUTORS["asyncpg"](server, loop)
    deadline = server.now + PREPARATION_SECONDS / 2

    with pytest.raises(worker_module._HeartbeatRoundExpired):
        worker_module._ServerBoundedExecutor(executor, deadline).rows(HEARTBEAT, ("lease",))

    # The first preparation passes the deadline, so the round sends nothing after it.
    assert [kind for kind, _, _, _ in server.events] == ["parse"]


# The checks below run the real drivers against PostgreSQL, with a deadline far from the time a
# round needs. They show that the drivers act as the doubles above assume.
ANSWER = DriverStatement(psycopg="SELECT %s::int AS ok", asyncpg="SELECT $1::int AS ok")
REAL_BOUND_SECONDS = 30.0


def test_psycopg_without_preparation_prepares_no_round_statement(database_url: str) -> None:
    with psycopg.connect(database_url, autocommit=True, prepare_threshold=0) as connection:
        executor = SyncExecutor(connection, prepare=False)
        for _ in range(3):
            deadline = worker_module.monotonic() + REAL_BOUND_SECONDS
            rows = worker_module._ServerBoundedExecutor(executor, deadline).rows(ANSWER, (7,))
            assert rows == [{"ok": 7}]
        prepared = connection.execute(
            "SELECT count(*) FROM pg_prepared_statements", prepare=False
        ).fetchone()

    assert prepared == (0,)


@pytest.mark.asyncio
@pytest.mark.parametrize("statement_cache_size", [100, 0])
async def test_asyncpg_runs_a_prepared_round_statement(
    database_url: str, statement_cache_size: int
) -> None:
    connection = await asyncpg.connect(database_url, statement_cache_size=statement_cache_size)
    try:
        executor = bridge(AsyncpgExecutor(connection), asyncio.get_running_loop())

        def run_rounds() -> list[object]:
            results: list[object] = []
            for _ in range(3):
                deadline = worker_module.monotonic() + REAL_BOUND_SECONDS
                bounded = worker_module._ServerBoundedExecutor(executor, deadline)
                results.append(bounded.rows(ANSWER, (7,)))
            return results

        assert await asyncio.to_thread(run_rounds) == [[{"ok": 7}]] * 3
        prepared = await connection.fetchval(
            "SELECT count(*) FROM pg_prepared_statements WHERE statement = $1", ANSWER.asyncpg
        )
    finally:
        await connection.close()

    # With a statement cache, the statement stays prepared once. Without one, asyncpg parses it in
    # the cycle that runs it.
    assert prepared == (1 if statement_cache_size else 0)
