from __future__ import annotations

import asyncio
import threading
from typing import Any

import pytest

from workhorse import AsyncWorker


class HeldCore:
    """Stand in for the synchronous core and hold its operation until released."""

    def __init__(self) -> None:
        self.started = threading.Event()
        self.release = threading.Event()
        self.exited = threading.Event()
        self.stops = 0

    def _hold(self) -> None:
        self.started.set()
        assert self.release.wait(10), "the test never released the core"
        self.exited.set()

    def run(self) -> None:
        self._hold()

    def run_once(self) -> bool:
        self._hold()
        return True

    def stop(self) -> None:
        self.stops += 1

    def _set_notification_listening(self, listening: bool) -> None:
        pass

    def _wake_from_notification(self) -> None:
        pass


class IdlePool:
    """Give the notification listener a connection request that never completes."""

    max_size = 3

    async def acquire(self) -> Any:
        await asyncio.Event().wait()


class ListeningConnection:
    """Stand in for an asyncpg notification connection."""

    def is_in_transaction(self) -> bool:
        return False

    def is_closed(self) -> bool:
        return False

    async def add_listener(self, _channel: str, _callback: object) -> None:
        pass

    async def remove_listener(self, _channel: str, _callback: object) -> None:
        pass


class HeldReleasePool:
    """Lend the listener a connection and hold its release until the test opens a gate."""

    max_size = 3

    def __init__(self) -> None:
        self.connection = ListeningConnection()
        self.acquired = asyncio.Event()
        self.releasing = asyncio.Event()
        self.gate = asyncio.Event()
        self.released = False

    async def acquire(self) -> ListeningConnection:
        self.acquired.set()
        return self.connection

    async def release(self, _connection: ListeningConnection) -> None:
        self.releasing.set()
        await self.gate.wait()
        self.released = True


def held_worker(pool: object | None = None) -> tuple[AsyncWorker, HeldCore]:
    worker = AsyncWorker(object(), pool or IdlePool(), "asyncpg")  # type: ignore[arg-type]
    core = HeldCore()
    worker._inner = core  # type: ignore[assignment]
    return worker, core


@pytest.mark.asyncio
@pytest.mark.parametrize("method", ["run", "run_once"])
async def test_repeated_cancellation_waits_for_the_core_to_drain(method: str) -> None:
    worker, core = held_worker()
    call = asyncio.create_task(getattr(worker, method)())
    assert await asyncio.to_thread(core.started.wait, 5)

    for _ in range(3):
        call.cancel()
        await asyncio.sleep(0.05)
        assert not call.done(), f"{method}() returned while the core was still draining"
    assert core.stops >= 1
    assert worker._running

    with pytest.raises(RuntimeError, match="already has an active run call"):
        await worker.run_once()

    core.release.set()
    with pytest.raises(asyncio.CancelledError):
        await call
    assert core.exited.is_set()
    assert not worker._running


@pytest.mark.asyncio
async def test_a_cancelled_run_rejects_context_calls_only_after_the_drain() -> None:
    worker, core = held_worker()
    call = asyncio.create_task(worker.run_once())
    assert await asyncio.to_thread(core.started.wait, 5)
    call.cancel()
    await asyncio.sleep(0.05)
    call.cancel()
    await asyncio.sleep(0.05)

    # A handler still draining on the core keeps its bridge to the event loop.
    assert worker._threads.run(lambda: 7).result(5) == 7

    core.release.set()
    with pytest.raises(asyncio.CancelledError):
        await call
    with pytest.raises(RuntimeError):
        worker._threads.run(lambda: 1)


@pytest.mark.asyncio
async def test_repeated_cancellation_waits_for_the_listener_to_release_its_connection() -> None:
    pool = HeldReleasePool()
    worker, core = held_worker(pool)
    call = asyncio.create_task(worker.run())
    assert await asyncio.to_thread(core.started.wait, 5)
    await asyncio.wait_for(pool.acquired.wait(), 5)

    call.cancel()
    await asyncio.sleep(0.05)
    core.release.set()
    await asyncio.wait_for(pool.releasing.wait(), 5)

    for _ in range(3):
        call.cancel()
        await asyncio.sleep(0.05)
        assert not call.done(), "run() returned while the listener was releasing its connection"
        assert worker._running

    pool.gate.set()
    with pytest.raises(asyncio.CancelledError):
        await call
    assert pool.released
    assert not worker._running
