from __future__ import annotations

import asyncio
import gc
import json
import re
import threading
import warnings
from collections.abc import Awaitable, Callable, Coroutine, Sequence
from contextlib import suppress
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import psycopg
import pytest

from workhorse import (
    AsyncHandlerContext,
    AsyncWorker,
    CancellationToken,
    ClaimedTask,
    EnqueueOptions,
    Json,
    Queue,
)
from workhorse._statements import STATEMENTS, DriverStatement
from workhorse.async_worker import _AsyncCheckpointAdapter, _BridgeThreads
from workhorse.worker import _AttemptOutcomeArbiter, _HandlerDurability

REPOSITORY = Path(__file__).parents[2]


class SyncCheckpoints:
    """Run each operation inline like the synchronous core, and record when the call ends."""

    def __init__(self) -> None:
        self.ended = threading.Event()
        self.errors: list[BaseException] = []
        self.saved: list[Json] = []

    def get_checkpoint(self, _name: str) -> None:
        return None

    def checkpoint(self, _name: str, operation: Callable[[], Json]) -> Json:
        try:
            value = operation()
            self.saved.append(value)
            return value
        except BaseException as error:
            self.errors.append(error)
            raise
        finally:
            self.ended.set()

    def get_progress(self) -> None:
        return None

    def set_progress(self, _value: Json) -> Any:
        return None


def other_tasks() -> set[asyncio.Task[Any]]:
    return {task for task in asyncio.all_tasks() if task is not asyncio.current_task()}


class SlowOperation:
    """A checkpoint operation whose cancellation cleanup takes a few loop turns."""

    def __init__(self) -> None:
        self.started = asyncio.Event()
        self.cleaned = False

    async def __call__(self) -> Json:
        self.started.set()
        try:
            await asyncio.sleep(30)
        finally:
            await asyncio.sleep(0.05)
            self.cleaned = True
        return "finished"


@pytest.mark.asyncio
async def test_a_timed_out_checkpoint_cancels_its_operation_and_waits_for_cleanup() -> None:
    threads = _BridgeThreads()
    context = SyncCheckpoints()
    adapter = _AsyncCheckpointAdapter(context, asyncio.get_running_loop(), threads)
    operation = SlowOperation()
    try:
        with pytest.raises(TimeoutError):
            await asyncio.wait_for(adapter.checkpoint("slow", operation), 0.1)

        assert operation.started.is_set()
        assert operation.cleaned, "the checkpoint returned before its operation cleaned up"
        assert context.ended.is_set(), "the bridge call was still inside checkpoint"
        assert len(context.errors) == 1
        assert other_tasks() == set()
    finally:
        threads.close()


@pytest.mark.asyncio
async def test_a_cancelled_checkpoint_does_not_start_its_operation_later() -> None:
    threads = _BridgeThreads()
    release = threading.Event()
    calls = 0

    class HeldCheckpoints(SyncCheckpoints):
        def checkpoint(self, name: str, operation: Callable[[], Json]) -> Json:
            # The core still reads stored checkpoints when the handler gives up.
            release.wait(5)
            return super().checkpoint(name, operation)

    async def operation() -> Json:
        nonlocal calls
        calls += 1
        return "ran"

    context = HeldCheckpoints()
    adapter = _AsyncCheckpointAdapter(context, asyncio.get_running_loop(), threads)
    try:
        call = asyncio.create_task(adapter.checkpoint("late", operation))
        await asyncio.sleep(0.05)
        call.cancel()
        await asyncio.sleep(0.05)
        assert not call.done(), "the checkpoint returned while its bridge call was running"
        release.set()
        with pytest.raises(asyncio.CancelledError):
            await call
        assert context.ended.is_set()
        assert calls == 0
    finally:
        release.set()
        threads.close()


class SuppressingOperation(SlowOperation):
    """A checkpoint operation that absorbs its cancellation and returns a value."""

    async def __call__(self) -> Json:
        self.started.set()
        try:
            await asyncio.sleep(30)
        except asyncio.CancelledError:
            await asyncio.sleep(0.05)
            self.cleaned = True
            return "suppressed"
        return "finished"


@pytest.mark.asyncio
async def test_a_checkpoint_saves_nothing_when_its_operation_absorbs_the_cancellation() -> None:
    threads = _BridgeThreads()
    context = SyncCheckpoints()
    adapter = _AsyncCheckpointAdapter(context, asyncio.get_running_loop(), threads)
    operation = SuppressingOperation()
    try:
        with pytest.raises(TimeoutError):
            await asyncio.wait_for(adapter.checkpoint("absorbed", operation), 0.1)

        assert operation.cleaned
        assert context.ended.is_set()
        assert context.saved == [], "the core received a value from a cancelled operation"
        assert len(context.errors) == 1
    finally:
        threads.close()


def run_on_a_fresh_loop(scenario: Callable[[], Coroutine[Any, Any, None]]) -> list[str]:
    """Run the scenario on its own loop, close the loop, and return what the loop reported.

    The loop reports a future whose exception nobody retrieved when the future is
    collected, and asyncio warns about a coroutine that was never awaited at the same
    point, so both are collected before the loop closes.
    """
    reported: list[str] = []
    loop = asyncio.new_event_loop()
    loop.set_exception_handler(lambda _loop, context: reported.append(context["message"]))
    try:
        with warnings.catch_warnings(record=True) as caught:
            warnings.simplefilter("always")
            loop.run_until_complete(scenario())
            gc.collect()
            loop.run_until_complete(asyncio.sleep(0))
            gc.collect()
        reported.extend(str(warning.message) for warning in caught)
    finally:
        loop.close()
    return reported


class FailingCheckpoints(SyncCheckpoints):
    """A core whose checkpoint call fails after the operation ends."""

    def checkpoint(self, name: str, operation: Callable[[], Json]) -> Json:
        with suppress(BaseException):
            super().checkpoint(name, operation)
        raise RuntimeError("cleanup failed")

    def set_progress(self, _value: Json) -> Any:
        threading.Event().wait(0.1)
        raise RuntimeError("progress failed")


@pytest.mark.parametrize("core", [SyncCheckpoints, FailingCheckpoints])
def test_a_cancelled_checkpoint_retrieves_its_bridge_outcome(core: type[SyncCheckpoints]) -> None:
    async def scenario() -> None:
        threads = _BridgeThreads()
        loop = asyncio.get_running_loop()
        adapter = _AsyncCheckpointAdapter(core(), loop, threads)
        failing = _AsyncCheckpointAdapter(FailingCheckpoints(), loop, threads)
        try:
            with pytest.raises(TimeoutError):
                await asyncio.wait_for(adapter.checkpoint("slow", SlowOperation()), 0.1)
            with pytest.raises(TimeoutError):
                await asyncio.wait_for(failing.set_progress("half"), 0.01)
        finally:
            threads.close()

    assert run_on_a_fresh_loop(scenario) == []


def factory_returning_a_coroutine(operation: SlowOperation) -> Awaitable[Json]:
    return operation()


def factory_returning_a_task(operation: SlowOperation) -> Awaitable[Json]:
    return asyncio.ensure_future(operation())


@pytest.mark.parametrize("factory", [factory_returning_a_coroutine, factory_returning_a_task])
def test_a_cancellation_as_the_operation_is_created_still_cancels_it(
    factory: Callable[[SlowOperation], Awaitable[Json]],
) -> None:
    """The caller is cancelled in the same loop step that creates the operation."""
    created: list[Awaitable[Json]] = []
    operation = SlowOperation()

    async def scenario() -> None:
        threads = _BridgeThreads()
        adapter = _AsyncCheckpointAdapter(SyncCheckpoints(), asyncio.get_running_loop(), threads)
        caller: asyncio.Task[Json] | None = None

        def create() -> Awaitable[Json]:
            assert caller is not None
            caller.cancel()
            created.append(factory(operation))
            return created[-1]

        try:
            caller = asyncio.create_task(adapter.checkpoint("racing", create))
            with pytest.raises(asyncio.CancelledError):
                await caller
            assert len(created) == 1
            if isinstance(created[0], asyncio.Future):
                assert created[0].done(), "the operation's task kept running"
            assert other_tasks() == set()
        finally:
            # A coroutine that was never awaited warns when it is collected.
            created.clear()
            threads.close()

    assert run_on_a_fresh_loop(scenario) == []


def attempt(number: int) -> ClaimedTask:
    return ClaimedTask(
        id="00000000-0000-0000-0000-000000001089",
        queue="checkpoints",
        type="charge",
        priority=0,
        payload=None,
        contract_version=None,
        result_max_bytes=1_048_576,
        redact_error_details=False,
        trace_context=None,
        attempt=number,
        max_attempts=2,
        retry_policy=None,
        deadline_at=None,
        execution_timeout_ms=None,
        attempt_timeout_at=None,
        fence_token=number,
        lease_expires_at=datetime.fromtimestamp(0, UTC),
    )


class HeldSaves:
    """Answer the checkpoint statements like PostgreSQL, holding each save until released."""

    dialect = "psycopg"

    def __init__(self) -> None:
        self.saving = threading.Event()
        self.release = threading.Event()
        self.rows_by_name: dict[str, dict[str, Any]] = {}

    def rows(self, statement: DriverStatement, parameters: Sequence[object] = ()) -> list[Any]:
        if statement is STATEMENTS.list_checkpoints:
            return list(self.rows_by_name.values())
        assert statement is STATEMENTS.save_checkpoint
        task_id, worker_id, fence_token, name, encoded = parameters
        self.saving.set()
        assert self.release.wait(5), "the test never released the held save"
        row = {
            "task_id": task_id,
            "checkpoint_name": name,
            "checkpoint_value": json.loads(str(encoded)),
            "attempt": fence_token,
            "fence_token": str(fence_token),
            "worker_id": worker_id,
            "created_at": datetime.now(UTC),
        }
        self.rows_by_name[str(name)] = row
        return [{"status": "saved", **row}]


def test_a_cancellation_during_the_save_leaves_a_checkpoint_the_next_attempt_replays() -> None:
    """The operation returned, so the save is under way when the caller is cancelled."""
    store = HeldSaves()
    calls: list[int] = []

    def durability(number: int) -> _HandlerDurability:
        return _HandlerDurability(
            store,
            attempt(number),
            "python-held-save",
            CancellationToken(),
            _AttemptOutcomeArbiter(),
        )

    def operation(number: int) -> Callable[[], Awaitable[Json]]:
        async def run() -> Json:
            calls.append(number)
            return {"completed": True}

        return run

    async def scenario() -> None:
        threads = _BridgeThreads()
        loop = asyncio.get_running_loop()
        first = durability(1)
        try:
            caller = asyncio.create_task(
                _AsyncCheckpointAdapter(first, loop, threads).checkpoint("charge", operation(1))
            )
            assert await asyncio.to_thread(store.saving.wait, 5)
            caller.cancel()
            await asyncio.sleep(0.05)
            assert not caller.done(), "the checkpoint returned while its save was running"
            store.release.set()
            with pytest.raises(asyncio.CancelledError):
                await caller
            assert first._checkpoint_calls == {}, "the bridge call was still inside checkpoint"
            assert other_tasks() == set()

            assert store.rows_by_name["charge"]["checkpoint_value"] == {"completed": True}
            replayed = await _AsyncCheckpointAdapter(durability(2), loop, threads).checkpoint(
                "charge", operation(2)
            )
            assert replayed == {"completed": True}
            assert calls == [1], "the next attempt ran the operation instead of replaying it"
        finally:
            store.release.set()
            threads.close()

    assert run_on_a_fresh_loop(scenario) == []


CANCELLATION_DOCUMENTS = (
    "docs/guides/310-workers.md",
    "site/content/docs/workers.mdx",
    "docs/architecture/schema-and-protocol.md",
    "python/README.md",
)


@pytest.mark.parametrize("document", CANCELLATION_DOCUMENTS)
def test_the_checkpoint_cancellation_documentation_admits_a_save_already_under_way(
    document: str,
) -> None:
    text = re.sub(r"\s+", " ", (REPOSITORY / document).read_text())
    assert re.search(r"save (may already be|is already) under way", text), (
        f"{document} does not say that a save already under way may still commit"
    )
    assert "never proves that no checkpoint exists" in text, document
    assert "does not undo the operation's effects on other systems" in text, document


@pytest.mark.asyncio
@pytest.mark.parametrize("operation_type", [SlowOperation, SuppressingOperation])
@pytest.mark.parametrize("mode", ["run_once", "run"])
async def test_a_handler_that_absorbs_a_checkpoint_timeout_leaves_nothing_running(
    database_url: str, asyncpg_pool: Any, operation_type: type[SlowOperation], mode: str
) -> None:
    queue = "async-checkpoint-timeout"
    with psycopg.connect(database_url) as connection:
        task_id = Queue(connection).enqueue(
            "async.checkpoint.timeout", {}, EnqueueOptions(queue=queue)
        )
    operation = operation_type()
    reported: list[str] = []
    loop = asyncio.get_running_loop()
    previous_handler = loop.get_exception_handler()
    loop.set_exception_handler(lambda _loop, context: reported.append(context["message"]))

    worker = AsyncWorker.from_asyncpg(asyncpg_pool, queue=queue, worker_id="python-timeout")

    async def handler(_payload: Json, context: AsyncHandlerContext) -> Json:
        try:
            return await asyncio.wait_for(context.checkpoint("slow", operation), 0.1)
        except TimeoutError:
            worker.stop()
            return "gave up"

    worker.handle("async.checkpoint.timeout", handler)

    try:
        if mode == "run_once":
            assert await worker.run_once() is True
        else:
            await asyncio.wait_for(worker.run(), 30)
        gc.collect()
        await asyncio.sleep(0)
    finally:
        loop.set_exception_handler(previous_handler)
    assert reported == []
    assert operation.cleaned
    assert other_tasks() == set()
    with psycopg.connect(database_url) as connection:
        row = connection.execute(
            "SELECT state, result FROM workhorse.task_outcome WHERE task_id = %s", (task_id,)
        ).fetchone()
        saved = connection.execute(
            "SELECT count(*) FROM workhorse.task_checkpoint WHERE task_id = %s", (task_id,)
        ).fetchone()
    assert row == ("succeeded", "gave up")
    assert saved == (0,)
