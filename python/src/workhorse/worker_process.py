from __future__ import annotations

import os
import signal
from collections.abc import Callable
from threading import Timer
from types import FrameType
from typing import NoReturn

from .worker import Worker

_DEFAULT_SHUTDOWN_TIMEOUT_MS = 25_000
_MAX_SHUTDOWN_TIMEOUT_MS = 3_600_000


def run_worker_process(
    worker: Worker,
    *,
    shutdown_timeout_ms: int = _DEFAULT_SHUTDOWN_TIMEOUT_MS,
    force_exit: Callable[[int], NoReturn] = os._exit,
) -> None:
    """Run one worker with bounded SIGINT and SIGTERM drain handling."""
    if (
        isinstance(shutdown_timeout_ms, bool)
        or not isinstance(shutdown_timeout_ms, int)
        or not 1 <= shutdown_timeout_ms <= _MAX_SHUTDOWN_TIMEOUT_MS
    ):
        raise ValueError("shutdown_timeout_ms must be an integer between 1 and 3600000")

    first_signal: int | None = None
    deadline: Timer | None = None
    requested_stop_version = worker._stop_version_snapshot()

    def handle_signal(signum: int, _frame: FrameType | None) -> None:
        nonlocal first_signal, deadline
        if first_signal is not None:
            force_exit(128 + signum)
        first_signal = signum
        worker.stop()
        deadline = Timer(shutdown_timeout_ms / 1000, force_exit, args=(1,))
        deadline.daemon = True
        deadline.start()

    handled_signals = (signal.SIGINT, signal.SIGTERM)
    previous_handlers = {signum: signal.getsignal(signum) for signum in handled_signals}
    for signum in handled_signals:
        signal.signal(signum, handle_signal)
    try:
        worker._run_continuously(requested_stop_version)
    finally:
        if deadline is not None:
            deadline.cancel()
        for signum, previous in previous_handlers.items():
            signal.signal(signum, previous)
