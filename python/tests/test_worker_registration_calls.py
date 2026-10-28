"""SM-1847: a failed registration refresh does not keep the failed refreshes before it."""

from __future__ import annotations

import gc
import threading
import weakref
from typing import Any

import pytest

import workhorse.worker
from workhorse.worker import Worker


class _Pool:
    """A pool the worker never draws a connection from. The executor answers every statement."""

    max_size = 5


class _OfflineExecutor:
    """An executor that fails every statement, as a database outage does."""

    def rows(self, _statement: Any, _parameters: Any = ()) -> list[Any]:
        raise ConnectionError("registry is offline")


def test_a_failed_registration_call_does_not_keep_the_call_before_it(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    worker = Worker(
        _Pool(),  # type: ignore[arg-type]
        queue="registration-calls",
        worker_id="registration-calls-worker",
        _executor=_OfflineExecutor(),  # type: ignore[arg-type]
    )
    # A registration thread holds its call until it ends, and the call fails before the thread
    # ends. The test records each thread, so it can wait for each thread before it collects.
    threads: list[threading.Thread] = []

    def recorded_thread(*args: Any, **kwargs: Any) -> threading.Thread:
        thread = threading.Thread(*args, **kwargs)
        threads.append(thread)
        return thread

    monkeypatch.setattr(workhorse.worker, "Thread", recorded_thread)

    calls: list[weakref.ref[Any]] = []
    for _ in range(10):
        worker._refresh_registration(force=True)
        call = worker._registration_call
        assert call is not None
        assert isinstance(call.exception(), ConnectionError)
        calls.append(weakref.ref(call))
        del call
    for thread in threads:
        thread.join(5)
    assert [thread.is_alive() for thread in threads] == [False] * 10
    gc.collect()

    assert worker._registered is False
    # The worker keeps only its newest call, so every failed call before it is collectable.
    assert [call() is None for call in calls[:-1]] == [True] * 9
    assert calls[-1]() is worker._registration_call
