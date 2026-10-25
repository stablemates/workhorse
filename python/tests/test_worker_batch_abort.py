"""SM-1709: a batch member whose cancellation fires while it waits leaves the batch at once.

Before the fix, the member stayed in the waiting list. The batch callback then got a task that the
worker no longer owned, and the member settled only after the linger ended.
"""

from __future__ import annotations

from collections.abc import Callable
from threading import Event, Lock, Thread
from types import SimpleNamespace
from typing import Any

from psycopg_pool import ConnectionPool

from workhorse import CancellationToken, Worker


class _ObservedToken(CancellationToken):
    """A token that reports when the coordinator registers its cancellation callback."""

    def __init__(self) -> None:
        super().__init__()
        self.registered = Event()

    def _on_cancel(self, callback: Callable[[BaseException], None]) -> None:
        super()._on_cancel(callback)
        self.registered.set()


class _LateToken(_ObservedToken):
    """A token whose callback has not run yet, as for a cancellation before the registration."""

    def _on_cancel(self, _callback: Callable[[BaseException], None]) -> None:
        self.registered.set()


class _Member:
    def __init__(self, task_id: str, priority: int, *, late: bool = False) -> None:
        self.token = _LateToken() if late else _ObservedToken()
        task = SimpleNamespace(
            id=task_id, queue="default", priority=priority, attempt=1, fence_token=1
        )
        batch_context = SimpleNamespace(task=task, cancellation=self.token)
        self.context = SimpleNamespace(
            task=task, cancellation=self.token, _as_batch_context=lambda: batch_context
        )
        self.result: Any = None
        self.error: BaseException | None = None
        self.thread = Thread(target=self._run, daemon=True)
        self.adapter: Callable[[Any, Any], Any] | None = None
        self.on_leave: Callable[[], None] = lambda: None

    def start(self, adapter: Callable[[Any, Any], Any], *, waits: bool = True) -> None:
        self.adapter = adapter
        self.thread.start()
        if not waits:
            return
        # The coordinator registers the callback after the member joins the waiting list. A
        # coordinator that never registers one fails on the assertions about the outcome instead.
        self.token.registered.wait(timeout=5)

    def _run(self) -> None:
        assert self.adapter is not None
        try:
            self.result = self.adapter({}, self.context)
        except BaseException as error:
            self.error = error
        self.on_leave()


class _Recorder:
    def __init__(self) -> None:
        self.lock = Lock()
        self.events: list[str] = []
        self.batches: list[list[str]] = []

    def record(self, event: str) -> None:
        with self.lock:
            self.events.append(event)

    def handler(self, items: Any) -> list[dict[str, object]]:
        ids = [item.context.task.id for item in items]
        with self.lock:
            self.batches.append(ids)
            self.events.append("dispatch")
        return [{"status": "succeeded", "result": task_id} for task_id in ids]


def _adapter(
    pool: ConnectionPool, recorder: _Recorder, linger_ms: int, max_size: int = 4
) -> Callable[[Any, Any], Any]:
    # The fake tasks have no rows, so the evidence write only logs. The coordinator is the subject.
    worker = Worker(pool, worker_id="python-batch-abort", concurrency=4).handle_batch(
        "batch", recorder.handler, max_size=max_size, linger_ms=linger_ms
    )
    return worker._handlers["batch"]


def test_a_canceled_waiting_member_leaves_and_its_peers_keep_their_order(
    worker_pool: ConnectionPool,
) -> None:
    recorder = _Recorder()
    adapter = _adapter(worker_pool, recorder, linger_ms=2_000)
    first = _Member("first", priority=3)
    canceled = _Member("canceled", priority=2)
    last = _Member("last", priority=1)
    canceled.on_leave = lambda: recorder.record("canceled left")
    for member in (first, canceled, last):
        member.start(adapter)

    reason = RuntimeError("lease lost")
    assert canceled.token._cancel(reason)
    for member in (first, canceled, last):
        member.thread.join(timeout=30)
        assert not member.thread.is_alive()

    # The canceled member left before the linger ended, and the callback never got it.
    assert canceled.error is reason
    assert recorder.events == ["canceled left", "dispatch"]
    assert recorder.batches == [["first", "last"]]
    assert (first.result, first.error) == ("first", None)
    assert (last.result, last.error) == ("last", None)


def test_the_linger_ends_when_the_last_waiting_member_is_canceled(
    worker_pool: ConnectionPool,
) -> None:
    recorder = _Recorder()
    adapter = _adapter(worker_pool, recorder, linger_ms=60_000)
    only = _Member("only", priority=0)
    only.start(adapter)

    reason = RuntimeError("cancel requested")
    assert only.token._cancel(reason)
    only.thread.join(timeout=30)

    assert not only.thread.is_alive()
    assert only.error is reason
    assert recorder.batches == []

    # A later member starts a new linger window and dispatches alone.
    adapter_zero = _adapter(worker_pool, recorder, linger_ms=0)
    following = _Member("following", priority=0)
    following.start(adapter_zero, waits=False)
    following.thread.join(timeout=30)
    assert (following.result, following.error) == ("following", None)
    assert recorder.batches == [["following"]]


def test_a_member_canceled_before_it_arrives_never_joins_a_batch(
    worker_pool: ConnectionPool,
) -> None:
    recorder = _Recorder()
    adapter = _adapter(worker_pool, recorder, linger_ms=0)
    late = _Member("late", priority=0)
    reason = RuntimeError("cancel requested")
    assert late.token._cancel(reason)
    late.start(adapter, waits=False)
    late.thread.join(timeout=30)

    assert late.error is reason
    assert recorder.batches == []


def test_a_selection_skips_a_canceled_member_whose_callback_has_not_run(
    worker_pool: ConnectionPool,
) -> None:
    recorder = _Recorder()
    adapter = _adapter(worker_pool, recorder, linger_ms=30_000, max_size=2)
    canceled = _Member("canceled", priority=3, late=True)
    canceled.start(adapter)
    reason = RuntimeError("cancel requested")
    assert canceled.token._cancel(reason)

    # Two later members fill a batch. The selection must not take the canceled member.
    first = _Member("first", priority=2)
    last = _Member("last", priority=1)
    for member in (first, last):
        member.start(adapter, waits=False)
    for member in (canceled, first, last):
        member.thread.join(timeout=30)
        assert not member.thread.is_alive()

    assert canceled.error is reason
    assert recorder.batches == [["first", "last"]]
