from __future__ import annotations

import asyncio
import json
import threading
from collections.abc import Mapping, Sequence
from typing import Any, cast

import asyncpg
import psycopg
import pytest
from psycopg.rows import tuple_row
from test_enqueue import Connection

from workhorse import (
    AsyncQueue,
    EnqueueRequest,
    Queue,
    TaskContractValidationError,
    TaskContractVersion,
    TaskTypeContracts,
)
from workhorse._statements import MINIMUM_SCHEMA_VERSION, PROTOCOL_VERSION
from workhorse.client import _ContractCache

COMPATIBLE: list[dict[str, Any]] = [
    {"kind": "schema", "version": MINIMUM_SCHEMA_VERSION},
    {"kind": "protocol", "version": PROTOCOL_VERSION},
]


def definition(version: str, required: str = "name") -> dict[str, Any]:
    return {
        "version": version,
        "schema": {"payload": {"type": "object", "required": [required]}, "result": True},
        "payload_max_bytes": 2048,
        "result_max_bytes": 4096,
        "payload_redact_keys": [],
        "result_redact_keys": [],
    }


def accepted(task_id: str) -> list[dict[str, Any]]:
    return [{"ordinal": 1, "task_id": task_id, "outcome": "accepted", "reason": None}]


def mismatch(*task_types: str) -> list[dict[str, Any]]:
    reason = json.dumps({"taskTypes": list(task_types)})
    return [{"ordinal": 0, "task_id": None, "outcome": "contract_mismatch", "reason": reason}]


def contracts(version: str) -> dict[str, TaskTypeContracts]:
    return {"email.send": TaskTypeContracts(version, {version: TaskContractVersion()})}


def contract_version(call: tuple[str, tuple[object, ...]]) -> object:
    return json.loads(str(call[1][0]))[0]["contractVersion"]


def test_warm_enqueue_issues_only_the_enqueue_statement() -> None:
    connection = Connection(
        [COMPATIBLE, [], COMPATIBLE, [definition("v1")], accepted("first"), accepted("second")]
    )
    queue = Queue(connection)
    queue.sync_contracts(contracts("v1"))
    queue.enqueue("email.send", {"name": "warm-up"})

    before = len(connection.calls)
    queue.enqueue("email.send", {"name": "warm"})

    warm = connection.calls[before:]
    assert len(warm) == 1
    assert "enqueue_many_v1" in warm[0][0]
    assert contract_version(warm[0]) == "v1"


def test_contract_mismatch_refreshes_the_cache_and_retries_once() -> None:
    connection = Connection(
        [
            COMPATIBLE,
            [],
            COMPATIBLE,
            [definition("v1")],
            accepted("first"),
            mismatch("email.send"),
            [definition("v2")],
            accepted("second"),
            accepted("third"),
        ]
    )
    queue = Queue(connection)
    queue.sync_contracts(contracts("v1"))
    queue.enqueue("email.send", {"name": "one"})

    before = len(connection.calls)
    assert queue.enqueue("email.send", {"name": "two"}) == "second"
    refreshed = connection.calls[before:]
    assert len(refreshed) == 3
    assert "get_contract_definition_v1" in refreshed[1][0]
    assert contract_version(refreshed[2]) == "v2"

    before = len(connection.calls)
    queue.enqueue("email.send", {"name": "three"})
    assert [contract_version(call) for call in connection.calls[before:]] == ["v2"]


def test_a_second_contract_mismatch_is_refused() -> None:
    connection = Connection(
        [
            COMPATIBLE,
            [],
            COMPATIBLE,
            [definition("v1")],
            mismatch("email.send"),
            [definition("v2")],
            mismatch("email.send"),
            [definition("v3")],
        ]
    )
    queue = Queue(connection)
    queue.sync_contracts(contracts("v1"))

    with pytest.raises(RuntimeError, match="contract policy changed again"):
        queue.enqueue("email.send", {"name": "one"})
    assert connection.responses == []


def test_sync_contracts_invalidates_cached_definitions() -> None:
    connection = Connection(
        [
            COMPATIBLE,
            [],
            COMPATIBLE,
            [definition("v1")],
            accepted("first"),
            COMPATIBLE,
            [],
            [definition("v2")],
            accepted("second"),
        ]
    )
    queue = Queue(connection)
    queue.sync_contracts(contracts("v1"))
    queue.enqueue("email.send", {"name": "one"})

    queue.sync_contracts(contracts("v2"))
    before = len(connection.calls)
    queue.enqueue("email.send", {"name": "two"})

    calls = connection.calls[before:]
    assert len(calls) == 2
    assert "get_contract_definition_v1" in calls[0][0]
    assert contract_version(calls[1]) == "v2"


class FlakyConnection(Connection):
    def __init__(self, responses: list[list[dict[str, Any]]]) -> None:
        super().__init__(responses)
        self.fail_next = True

    def cursor(self, *, row_factory: Any = None) -> Any:
        if self.fail_next:
            self.fail_next = False
            raise psycopg.OperationalError("connection reset")
        return super().cursor(row_factory=row_factory)


def test_a_transient_compatibility_failure_is_retried() -> None:
    connection = FlakyConnection([COMPATIBLE, accepted("first"), accepted("second")])
    queue = Queue(connection)

    with pytest.raises(psycopg.OperationalError):
        queue.enqueue("email.send", {})
    queue.enqueue("email.send", {})
    queue.enqueue("email.send", {})

    compatibility = [sql for sql, _ in connection.calls if "schema_version" in sql]
    assert len(compatibility) == 1


class ScriptedAsyncpg:
    def __init__(self, responses: list[list[dict[str, Any]]]) -> None:
        self.responses = responses
        self.calls: list[tuple[str, tuple[object, ...]]] = []

    async def fetch(self, sql: str, *parameters: object) -> Sequence[Mapping[str, object]]:
        self.calls.append((sql, parameters))
        return self.responses.pop(0)


@pytest.mark.asyncio
async def test_async_queue_caches_and_refreshes_on_mismatch() -> None:
    connection = ScriptedAsyncpg(
        [
            COMPATIBLE,
            [],
            COMPATIBLE,
            [definition("v1")],
            accepted("first"),
            accepted("second"),
            mismatch("email.send"),
            [definition("v2")],
            accepted("third"),
        ]
    )
    queue = AsyncQueue.from_asyncpg(connection)
    await queue.sync_contracts(contracts("v1"))
    await queue.enqueue("email.send", {"name": "warm-up"})

    before = len(connection.calls)
    await queue.enqueue("email.send", {"name": "warm"})
    assert len(connection.calls) - before == 1

    before = len(connection.calls)
    assert await queue.enqueue("email.send", {"name": "changed"}) == "third"
    refreshed = connection.calls[before:]
    assert len(refreshed) == 3
    assert contract_version(refreshed[2]) == "v2"


# A definition read during this call is current, so a local rejection never reads it again. Each
# script ends with a spare definition that a second read would consume.
COLD_BATCH: list[list[dict[str, Any]]] = [
    COMPATIBLE,
    [],
    COMPATIBLE,
    [definition("v1")],
    [definition("v1")],
]
MISMATCH_THEN_REJECT: list[list[dict[str, Any]]] = [
    COMPATIBLE,
    [],
    COMPATIBLE,
    [definition("v1")],
    mismatch("email.send"),
    [definition("v2", required="other")],
    [definition("v2", required="other")],
]
FRESHLY_READ = [
    pytest.param(COLD_BATCH, [{"name": "valid"}, {"missing": "name"}], id="cold-batch"),
    pytest.param(MISMATCH_THEN_REJECT, [{"name": "valid"}], id="mismatch-then-reject"),
]


@pytest.mark.parametrize(("script", "payloads"), FRESHLY_READ)
def test_a_definition_read_during_the_call_is_not_read_again(
    script: list[list[dict[str, Any]]], payloads: list[dict[str, Any]]
) -> None:
    connection = Connection([list(response) for response in script])
    queue = Queue(connection)
    queue.sync_contracts(contracts("v1"))

    with pytest.raises(TaskContractValidationError):
        queue.enqueue_many([EnqueueRequest("email.send", payload) for payload in payloads])
    assert len(connection.responses) == 1


@pytest.mark.parametrize(("script", "payloads"), FRESHLY_READ)
async def test_async_queues_do_not_reread_a_definition_read_during_the_call(
    script: list[list[dict[str, Any]]], payloads: list[dict[str, Any]]
) -> None:
    connection = ScriptedAsyncpg([list(response) for response in script])
    queue = AsyncQueue.from_asyncpg(connection)
    await queue.sync_contracts(contracts("v1"))

    with pytest.raises(TaskContractValidationError):
        await queue.enqueue_many([EnqueueRequest("email.send", payload) for payload in payloads])
    assert len(connection.responses) == 1


# A concurrent enqueue reads v1, and this batch then reads and publishes v2. The concurrent
# enqueue's slower load must not put v1 back in the shared cache, and the batch's last item must
# validate against the v2 it read. Its audit.log lookup is where it waits for the concurrent
# enqueue to finish. A later enqueue then validates against the cached v2 without a lookup.
INTERLEAVED_BATCH = [
    EnqueueRequest("email.send", {"other": "first"}),
    EnqueueRequest("audit.log", {}),
    EnqueueRequest("email.send", {"other": "third"}),
]


def interleaved_rows(actor: str, sql: str, parameters: Sequence[object]) -> list[dict[str, Any]]:
    if "'protocol' AS kind" in sql:
        return COMPATIBLE
    if "get_contract_definition_v1" in sql:
        if parameters[0] == "audit.log":
            return []
        return [definition("v1") if actor == "concurrent" else definition("v2", required="other")]
    if "enqueue_many_v1" in sql:
        if actor != "batch":
            return accepted(actor)
        return [
            {
                "ordinal": ordinal,
                "task_id": f"batch-{ordinal}",
                "outcome": "accepted",
                "reason": None,
            }
            for ordinal in range(1, len(INTERLEAVED_BATCH) + 1)
        ]
    return []


class InterleavingCursor:
    def __init__(self, connection: InterleavingConnection) -> None:
        self._connection = connection
        self.description: list[tuple[str]] = []
        self._rows: list[dict[str, Any]] = []

    def __enter__(self) -> InterleavingCursor:
        return self

    def __exit__(self, *_args: object) -> None:
        return None

    def execute(self, sql: str, parameters: Sequence[object] = ()) -> None:
        self._rows = self._connection.rows(sql, parameters)
        self.description = [(name,) for name in self._rows[0]] if self._rows else []

    def fetchall(self) -> list[tuple[object, ...]]:
        return [tuple(row.values()) for row in self._rows]


class InterleavingConnection:
    def __init__(self) -> None:
        self.concurrent_reading = threading.Event()
        self.batch_stored = threading.Event()
        self.concurrent_done = threading.Event()
        self.statements: list[str] = []

    def cursor(self, *, row_factory: Any = None) -> InterleavingCursor:
        assert row_factory is tuple_row
        return InterleavingCursor(self)

    def rows(self, sql: str, parameters: Sequence[object]) -> list[dict[str, Any]]:
        actor = threading.current_thread().name
        self.statements.append(sql)
        if "get_contract_definition_v1" in sql and actor == "concurrent":
            self.concurrent_reading.set()
            assert self.batch_stored.wait(5)
        if "get_contract_definition_v1" in sql and parameters[0] == "audit.log":
            self.batch_stored.set()
            assert self.concurrent_done.wait(5)
        if "enqueue_many_v1" in sql and actor == "concurrent":
            self.concurrent_done.set()
        return interleaved_rows(actor, sql, parameters)


def test_a_concurrent_late_store_does_not_change_the_definition_a_batch_read() -> None:
    connection = InterleavingConnection()
    queue = Queue(cast(Any, connection))
    queue.sync_contracts(contracts("v1"))
    outcomes: dict[str, object] = {}

    def run(actor: str, requests: list[EnqueueRequest]) -> None:
        try:
            outcomes[actor] = queue.enqueue_many(requests)
        except Exception as error:
            outcomes[actor] = error

    concurrent = threading.Thread(
        target=run,
        args=("concurrent", [EnqueueRequest("email.send", {"name": "v1"})]),
        name="concurrent",
    )
    concurrent.start()
    assert connection.concurrent_reading.wait(5)
    batch = threading.Thread(target=run, args=("batch", INTERLEAVED_BATCH), name="batch")
    batch.start()
    batch.join(5)
    concurrent.join(5)

    assert outcomes == {"concurrent": ["concurrent"], "batch": ["batch-1", "batch-2", "batch-3"]}
    before = len(connection.statements)
    assert queue.enqueue("email.send", {"other": "later"}) == threading.current_thread().name
    assert not any("get_contract_definition_v1" in sql for sql in connection.statements[before:])


class InterleavingAsyncpg:
    def __init__(self) -> None:
        self.concurrent_reading = asyncio.Event()
        self.batch_stored = asyncio.Event()
        self.concurrent_done = asyncio.Event()
        self.statements: list[str] = []

    async def fetch(self, sql: str, *parameters: object) -> Sequence[Mapping[str, object]]:
        task = asyncio.current_task()
        actor = task.get_name() if task is not None else ""
        self.statements.append(sql)
        if "get_contract_definition_v1" in sql and actor == "concurrent":
            self.concurrent_reading.set()
            await self.batch_stored.wait()
        if "get_contract_definition_v1" in sql and parameters[0] == "audit.log":
            self.batch_stored.set()
            await self.concurrent_done.wait()
        if "enqueue_many_v1" in sql and actor == "concurrent":
            self.concurrent_done.set()
        return interleaved_rows(actor, sql, parameters)


async def test_a_concurrent_late_store_does_not_change_the_definition_an_async_batch_read() -> None:
    connection = InterleavingAsyncpg()
    queue = AsyncQueue.from_asyncpg(cast(Any, connection))
    await queue.sync_contracts(contracts("v1"))

    concurrent = asyncio.create_task(
        queue.enqueue_many([EnqueueRequest("email.send", {"name": "v1"})]), name="concurrent"
    )
    await asyncio.wait_for(connection.concurrent_reading.wait(), 5)
    batch = asyncio.create_task(queue.enqueue_many(INTERLEAVED_BATCH), name="batch")
    results = await asyncio.wait_for(asyncio.gather(concurrent, batch, return_exceptions=True), 5)

    assert results == [["concurrent"], ["batch-1", "batch-2", "batch-3"]]
    before = len(connection.statements)
    later = asyncio.create_task(queue.enqueue("email.send", {"other": "later"}), name="later")
    assert await later == "later"
    assert not any("get_contract_definition_v1" in sql for sql in connection.statements[before:])


def test_a_load_older_than_the_cached_entry_or_a_clear_does_not_publish() -> None:
    cache = _ContractCache()
    slower = cache.start_load("email.send")
    newer = cache.start_load("email.send")
    cache.publish("email.send", newer, definition("v2"))
    cache.publish("email.send", slower, definition("v1"))
    assert cache.get("email.send") == definition("v2")

    before_clear = cache.start_load("email.send")
    cache.clear()
    cache.publish("email.send", before_clear, definition("v1"))
    with pytest.raises(KeyError):
        cache.get("email.send")


class StatementLog:
    """Forward a psycopg connection and record every statement sent to PostgreSQL."""

    def __init__(self, connection: psycopg.Connection[Any]) -> None:
        self.connection = connection
        self.statements: list[str] = []

    def cursor(self, *, row_factory: Any = None) -> Any:
        log = self
        cursor = self.connection.cursor(row_factory=row_factory)

        class LoggedCursor:
            description = property(lambda _self: cursor.description)

            def __enter__(self) -> LoggedCursor:
                cursor.__enter__()
                return self

            def __exit__(self, *arguments: Any) -> None:
                cursor.__exit__(*arguments)

            def execute(self, sql: str, parameters: Sequence[object] = ()) -> None:
                log.statements.append(sql)
                cursor.execute(sql, parameters)

            def fetchall(self) -> list[tuple[Any, ...]]:
                return cursor.fetchall()

        return LoggedCursor()


def set_policy(database_url: str, version: str) -> None:
    with psycopg.connect(database_url, autocommit=True) as other:
        Queue(other, default_queue="producer-cache").sync_contracts(contracts(version))


@pytest.mark.integration
def test_psycopg_warm_enqueue_is_one_round_trip(database_url: str) -> None:
    with psycopg.connect(database_url, autocommit=True) as connection:
        log = StatementLog(connection)
        queue = Queue(log, default_queue="producer-cache")  # type: ignore[arg-type]
        queue.sync_contracts(contracts("v1"))
        queue.enqueue("email.send", {"name": "warm-up"})

        before = len(log.statements)
        queue.enqueue("email.send", {"name": "warm"})
        warm = log.statements[before:]
        assert len(warm) == 1, warm
        assert "enqueue_many_v1" in warm[0]

        set_policy(database_url, "v2")
        before = len(log.statements)
        task_id = queue.enqueue("email.send", {"name": "after-change"})
        assert len(log.statements) - before == 3
        row = connection.execute(
            "SELECT contract_version FROM workhorse.task WHERE id = %s::uuid", (task_id,)
        ).fetchone()
        assert row == ("v2",)


class AsyncpgStatementLog:
    """Forward an asyncpg connection and record every statement sent to PostgreSQL."""

    def __init__(self, connection: asyncpg.Connection) -> None:
        self.connection = connection
        self.statements: list[str] = []

    async def fetch(self, sql: str, *parameters: object) -> Sequence[Mapping[str, object]]:
        self.statements.append(sql)
        return await self.connection.fetch(sql, *parameters)


@pytest.mark.integration
@pytest.mark.asyncio
async def test_asyncpg_warm_enqueue_is_one_round_trip(database_url: str) -> None:
    connection = await asyncpg.connect(database_url)
    try:
        log = AsyncpgStatementLog(connection)
        queue = AsyncQueue.from_asyncpg(log)  # type: ignore[arg-type]
        await queue.sync_contracts(contracts("v1"))
        await queue.enqueue("email.send", {"name": "warm-up"})

        before = len(log.statements)
        await queue.enqueue("email.send", {"name": "warm"})
        warm = log.statements[before:]
        assert len(warm) == 1, warm
        assert "enqueue_many_v1" in warm[0]

        set_policy(database_url, "v2")
        before = len(log.statements)
        await queue.enqueue("email.send", {"name": "after-change"})
        assert len(log.statements) - before == 3
    finally:
        await connection.close()


# After sync_contracts, an operator can select a version the cached definition rejects. That
# payload never reaches enqueue_many_v1, so the queue must reload the selection itself.
STALE_SHAPES = {
    "one": TaskContractVersion(
        payload_schema={"type": "object", "required": ["one"], "properties": {"one": True}},
        max_payload_bytes=128,
    ),
    "two": TaskContractVersion(
        payload_schema={"type": "object", "required": ["two"], "properties": {"two": True}},
    ),
    "roomy": TaskContractVersion(
        payload_schema={"type": "object", "required": ["one"], "properties": {"one": True}},
        max_payload_bytes=4096,
    ),
}


def stale_contracts(task_type: str) -> dict[str, TaskTypeContracts]:
    return {task_type: TaskTypeContracts("one", STALE_SHAPES)}


def override(connection: psycopg.Connection[Any], task_type: str, version: str) -> None:
    connection.execute(
        "SELECT workhorse.override_contract_version_v1(%s, %s)", (task_type, version)
    )


def stored_version(connection: psycopg.Connection[Any], task_id: str) -> object:
    row = connection.execute(
        "SELECT contract_version FROM workhorse.task WHERE id = %s::uuid", (task_id,)
    ).fetchone()
    return None if row is None else row[0]


def contract_reads(statements: Sequence[str]) -> int:
    return sum("get_contract_definition_v1" in statement for statement in statements)


@pytest.mark.integration
def test_a_payload_the_stale_cached_version_rejects_reloads_the_selection(
    database_url: str,
) -> None:
    with psycopg.connect(database_url, autocommit=True) as connection:
        queue = Queue(connection, default_queue="producer-cache")
        queue.sync_contracts(stale_contracts("stale.version"))
        queue.enqueue("stale.version", {"one": True})
        override(connection, "stale.version", "two")

        task_id = queue.enqueue("stale.version", {"two": True})

        assert stored_version(connection, task_id) == "two"
        with pytest.raises(TaskContractValidationError) as rejected:
            queue.enqueue("stale.version", {"one": True})
        assert rejected.value.version == "two"


@pytest.mark.integration
def test_a_payload_over_the_stale_size_limit_uses_the_raised_limit(database_url: str) -> None:
    with psycopg.connect(database_url, autocommit=True) as connection:
        queue = Queue(connection, default_queue="producer-cache")
        queue.sync_contracts(stale_contracts("stale.limit"))
        payload = {"one": "x" * 512}
        with pytest.raises(psycopg.errors.RaiseException, match="configured size limit"):
            queue.enqueue("stale.limit", payload)
        override(connection, "stale.limit", "roomy")

        task_id = queue.enqueue("stale.limit", payload)

        assert stored_version(connection, task_id) == "roomy"


@pytest.mark.integration
def test_the_reload_reads_the_callers_uncommitted_override(database_url: str) -> None:
    with psycopg.connect(database_url, autocommit=True) as connection:
        Queue(connection, default_queue="producer-cache").sync_contracts(
            stale_contracts("stale.transaction")
        )
    with psycopg.connect(database_url) as connection:
        queue = Queue(connection, default_queue="producer-cache")
        queue.enqueue("stale.transaction", {"one": True})
        connection.commit()
        override(connection, "stale.transaction", "two")

        task_id = queue.enqueue("stale.transaction", {"two": True})

        assert stored_version(connection, task_id) == "two"
        connection.rollback()


@pytest.mark.integration
def test_a_payload_the_current_version_also_rejects_raises_after_one_reload(
    database_url: str,
) -> None:
    with psycopg.connect(database_url, autocommit=True) as connection:
        log = StatementLog(connection)
        queue = Queue(log, default_queue="producer-cache")  # type: ignore[arg-type]
        queue.sync_contracts(stale_contracts("stale.invalid"))
        queue.enqueue_many([EnqueueRequest("stale.invalid", {"one": True}) for _ in range(2)])

        before = len(log.statements)
        with pytest.raises(TaskContractValidationError) as rejected:
            queue.enqueue_many(
                [EnqueueRequest("stale.invalid", {"neither": True}) for _ in range(2)]
            )
        assert rejected.value.version == "one"
        assert contract_reads(log.statements[before:]) == 1

        override(connection, "stale.invalid", "two")
        before = len(log.statements)
        with pytest.raises(TaskContractValidationError) as rejected:
            queue.enqueue("stale.invalid", {"neither": True})
        assert rejected.value.version == "two"
        assert contract_reads(log.statements[before:]) == 1


@pytest.mark.integration
async def test_async_queues_reload_a_selection_the_cached_version_rejects(
    database_url: str,
) -> None:
    with psycopg.connect(database_url, autocommit=True) as admin:
        Queue(admin, default_queue="producer-cache").sync_contracts(stale_contracts("stale.async"))
        connection = await asyncpg.connect(database_url)
        try:
            log = AsyncpgStatementLog(connection)
            queue = AsyncQueue.from_asyncpg(log)  # type: ignore[arg-type]
            await queue.sync_contracts(stale_contracts("stale.async"))
            await queue.enqueue("stale.async", {"one": True})
            override(admin, "stale.async", "two")

            task_id = await queue.enqueue("stale.async", {"two": True})
            assert stored_version(admin, task_id) == "two"

            before = len(log.statements)
            with pytest.raises(TaskContractValidationError) as rejected:
                await queue.enqueue("stale.async", {"neither": True})
            assert rejected.value.version == "two"
            assert contract_reads(log.statements[before:]) == 1
        finally:
            await connection.close()
        async with await psycopg.AsyncConnection.connect(database_url, autocommit=True) as other:
            queue = AsyncQueue.from_psycopg(other)
            await queue.sync_contracts(stale_contracts("stale.async"))
            await queue.enqueue("stale.async", {"two": True})
            override(admin, "stale.async", "one")

            task_id = await queue.enqueue("stale.async", {"one": True})
            assert stored_version(admin, task_id) == "one"
