from __future__ import annotations

import os
import signal
from collections.abc import Callable
from threading import Thread, Timer
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
    signal_reader, signal_writer = os.pipe()
    os.set_blocking(signal_writer, False)
    signal_payloads: dict[int, bytes] = {
        signum: bytes((signum,)) for signum in (signal.SIGINT, signal.SIGTERM)
    }

    def handle_signal(signum: int, _frame: FrameType | None) -> None:
        try:  # noqa: SIM105 - keep the signal handler free of context manager machinery.
            os.write(signal_writer, signal_payloads[signum])
        except BlockingIOError:
            pass

    def relay_signals() -> None:
        nonlocal first_signal, deadline
        while payload := os.read(signal_reader, 1):
            signum = payload[0]
            if first_signal is not None:
                force_exit(128 + signum)
            first_signal = signum
            deadline = Timer(shutdown_timeout_ms / 1000, force_exit, args=(1,))
            deadline.daemon = True
            deadline.start()
            Thread(target=worker.stop, daemon=True).start()

    handled_signals = (signal.SIGINT, signal.SIGTERM)
    previous_handlers = {signum: signal.getsignal(signum) for signum in handled_signals}
    signal_relay = Thread(target=relay_signals, daemon=True)
    signal_relay.start()
    installed_signals: list[signal.Signals] = []
    try:
        for signum in handled_signals:
            signal.signal(signum, handle_signal)
            installed_signals.append(signum)
        worker._run_continuously(requested_stop_version)
    finally:
        for signum in installed_signals:
            signal.signal(signum, previous_handlers[signum])
        os.close(signal_writer)
        signal_relay.join()
        os.close(signal_reader)
        if deadline is not None:
            deadline.cancel()


__all__ = ["run_worker_process"]
