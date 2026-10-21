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
import time
from collections.abc import Callable, Iterator, Sequence
from dataclasses import dataclass, field
from threading import Thread
from typing import Any

import asyncpg
import psycopg
import pytest
from reservations import reserve

import workhorse._pool_hub as pool_hub_module
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
    # The time that each statement, keyed by a fragment of its SQL, runs on the server.
    delays: dict[str, float] = field(default_factory=dict)
    # The error that each statement, keyed by a fragment of its SQL, raises after its delay.
    errors: dict[str, Exception] = field(default_factory=dict)
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
        self.now += sum(delay for fragment, delay in self.delays.items() if fragment in sql)
        for fragment, error in self.errors.items():
            if fragment in sql:
                raise error
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
        self.closed = False

    def close(self) -> None:
        self.closed = True

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
    # The heartbeat reservation compares the round deadline with the same clock.
    monkeypatch.setattr(pool_hub_module, "monotonic", server.monotonic)
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


# SM-1492: a round that expires before its heartbeat statement leaves nothing open on the server
# when its ROLLBACK ends by the deadline. The worker then keeps the connection for the next round.
EXPIRY_BOUND_SECONDS = 0.1


def sent(server: Server) -> list[str]:
    return [sql for kind, sql, _, _ in server.events if kind == "run"]


def sync_round(server: Server, deadline: float) -> list[dict[str, object]]:
    executor = SyncExecutor(SyncConnection(server), prepare=False)
    return worker_module._ServerBoundedExecutor(executor, deadline).rows(HEARTBEAT, ("lease",))


def test_a_round_with_too_little_time_before_begin_sends_nothing(server: Server) -> None:
    deadline = server.now + worker_module._MINIMUM_ROUND_REMAINING_SECONDS / 2

    with pytest.raises(worker_module._HeartbeatRoundExpiredCleanly):
        sync_round(server, deadline)

    assert server.events == []


def test_a_slow_begin_that_leaves_too_little_time_rolls_back_cleanly(server: Server) -> None:
    deadline = server.now + EXPIRY_BOUND_SECONDS
    # BEGIN leaves 5 ms, less than the round needs at the settings statement.
    server.delays["BEGIN"] = EXPIRY_BOUND_SECONDS - 0.005

    with pytest.raises(worker_module._HeartbeatRoundExpiredCleanly):
        sync_round(server, deadline)

    assert sent(server) == ["BEGIN", "ROLLBACK"]


def test_a_settings_statement_that_uses_more_than_its_quarter_rolls_back_cleanly(
    server: Server,
) -> None:
    deadline = server.now + EXPIRY_BOUND_SECONDS
    server.delays["set_config"] = EXPIRY_BOUND_SECONDS / 2

    with pytest.raises(worker_module._HeartbeatRoundExpiredCleanly):
        sync_round(server, deadline)

    assert sent(server) == ["BEGIN", ROUND_TIMEOUTS.psycopg, "ROLLBACK"]


@pytest.mark.parametrize("slow", ["BEGIN", "set_config"])
def test_a_statement_still_running_at_the_deadline_does_not_expire_cleanly(
    server: Server, slow: str
) -> None:
    deadline = server.now + EXPIRY_BOUND_SECONDS
    server.delays[slow] = 2 * EXPIRY_BOUND_SECONDS

    with pytest.raises(worker_module._HeartbeatRoundExpired) as raised:
        sync_round(server, deadline)

    assert not isinstance(raised.value, worker_module._HeartbeatRoundExpiredCleanly)
    # No command goes out after the deadline, so the transaction stays open until the connection
    # closes.
    assert "ROLLBACK" not in sent(server)


class Deadlock(Exception):
    sqlstate = "40P01"


def test_a_resend_after_a_rollback_that_could_not_go_out_does_not_expire_cleanly(
    server: Server,
) -> None:
    deadline = server.now + EXPIRY_BOUND_SECONDS
    # PostgreSQL chooses the heartbeat as a deadlock victim after the deadline, so no ROLLBACK goes
    # out and the transaction stays open.
    server.delays["heartbeat"] = 2 * EXPIRY_BOUND_SECONDS
    server.errors["heartbeat"] = Deadlock("deadlock detected")
    executor = SyncExecutor(SyncConnection(server), prepare=False)
    bounded = worker_module._ServerBoundedExecutor(executor, deadline)

    with pytest.raises(worker_module._HeartbeatRoundExpired) as raised:
        worker_module._fenced_write_rows(bounded, HEARTBEAT, ("lease",))

    assert not isinstance(raised.value, worker_module._HeartbeatRoundExpiredCleanly)
    assert "ROLLBACK" not in sent(server)


class Connections:
    """A heartbeat executor factory that records each connection it opens and each close."""

    def __init__(self, server: Server) -> None:
        self._server = server
        self.opened: list[SyncConnection] = []
        self.returned: list[SyncConnection] = []

    def open(self) -> tuple[SyncExecutor, Callable[[], None]]:
        connection = SyncConnection(self._server)
        self.opened.append(connection)
        return SyncExecutor(connection, prepare=False), lambda: self.returned.append(connection)


class _Pool:
    """A pool the worker never draws a connection from. The factory opens every connection."""

    max_size = 5


def run_round(worker: worker_module.Worker, deadline: float) -> Any:
    heartbeat_round = worker_module._HeartbeatRound(deadline)
    reservation = worker._reservation
    assert reservation is not None
    worker._run_heartbeat_round(heartbeat_round, ("worker", "[]"), reservation)
    return heartbeat_round.result


def bounded_worker(connections: Connections) -> worker_module.Worker:
    worker = worker_module.Worker(
        _Pool(),
        queue="heartbeat-expiry",
        worker_id="heartbeat-expiry-worker",
        _heartbeat_executor_factory=connections.open,
    )
    reserve(worker)
    return worker


def test_a_round_that_expires_before_its_heartbeat_keeps_the_connection(server: Server) -> None:
    connections = Connections(server)
    worker = bounded_worker(connections)
    server.delays["BEGIN"] = EXPIRY_BOUND_SECONDS - 0.005

    expired = run_round(worker, server.now + EXPIRY_BOUND_SECONDS)

    # The round failed, sent no heartbeat, and rolled back.
    assert isinstance(expired.exception(), worker_module._HeartbeatRoundExpiredCleanly)
    assert sent(server) == ["BEGIN", "ROLLBACK"]
    (connection,) = connections.opened
    assert not connection.closed and connections.returned == []

    server.events.clear()
    server.delays.clear()
    renewed = run_round(worker, server.now + ROUND_BOUND_SECONDS)

    # The next round sends its heartbeat on the same connection.
    assert renewed.result() == [{"ok": True}]
    assert connections.opened == [connection]
    assert sent(server)[-2:] == [worker_module._STATEMENTS.heartbeat_many.psycopg, "COMMIT"]
    assert not connection.closed and connections.returned == []


def test_a_round_whose_begin_runs_past_the_deadline_discards_the_connection(
    server: Server,
) -> None:
    connections = Connections(server)
    worker = bounded_worker(connections)
    server.delays["BEGIN"] = 2 * EXPIRY_BOUND_SECONDS

    expired = run_round(worker, server.now + EXPIRY_BOUND_SECONDS)

    assert not isinstance(expired.exception(), worker_module._HeartbeatRoundExpiredCleanly)
    assert isinstance(expired.exception(), worker_module._HeartbeatRoundExpired)
    # The reservation opens the replacement at once, on its own thread.
    deadline = time.monotonic() + 5
    while len(connections.opened) < 2 and time.monotonic() < deadline:
        time.sleep(0.01)
    first, replacement = connections.opened
    # The worker closed the connection under the open transaction, and opened its replacement.
    assert first.closed and connections.returned == [first]
    assert not replacement.closed
