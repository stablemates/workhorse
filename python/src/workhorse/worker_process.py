from __future__ import annotations

import os
import signal
from collections.abc import Callable
from threading import Event, Lock, Thread, Timer
from types import FrameType
from typing import NoReturn

from .worker import Worker

_DEFAULT_SHUTDOWN_TIMEOUT_MS = 25_000
_MAX_SHUTDOWN_TIMEOUT_MS = 3_600_000
# How long the handlers have to unwind after the shutdown abort, as Go handlerUnwindPeriod. A
# handler that reacts to the abort gives its task back in this window.
_HANDLER_UNWIND_SECONDS = 0.25


def run_worker_process(
    worker: Worker,
    *,
    shutdown_timeout_ms: int = _DEFAULT_SHUTDOWN_TIMEOUT_MS,
    force_exit: Callable[[int], NoReturn] = os._exit,
) -> None:
    """Run one worker with a bounded drain after SIGINT, SIGTERM, or a fatal worker error.

    At the end of the shutdown grace, the runner cancels each handler that still runs. A handler
    that returns or raises in the next 250 ms gives its task back: a value completes the task, and
    an error releases it without an attempt. Then the process exits with code 1. Lease recovery
    settles the task of a handler that did not return.
    """
    if (
        isinstance(shutdown_timeout_ms, bool)
        or not isinstance(shutdown_timeout_ms, int)
        or not 1 <= shutdown_timeout_ms <= _MAX_SHUTDOWN_TIMEOUT_MS
    ):
        raise ValueError("shutdown_timeout_ms must be an integer between 1 and 3600000")

    first_signal: int | None = None
    deadline: Timer | None = None
    deadline_lock = Lock()
    finished = False
    drained = Event()
    # Set when the expiry of the grace started, and when it called force_exit. The main thread
    # does not return between the two, so a drain inside the unwind window still exits with 1.
    expiring = False
    exited = Event()
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

    def expire() -> None:
        # The end of the grace cancels the handlers, as Go does, and gives them one unwind window.
        # The process exits after that window or after the drain ends, whichever comes first.
        nonlocal expiring
        with deadline_lock:
            if finished:
                return
            expiring = True
        try:
            worker._abort_handlers_for_shutdown()
            drained.wait(_HANDLER_UNWIND_SECONDS)
            force_exit(1)
        finally:
            exited.set()

    def start_deadline() -> None:
        # A signal and a fatal worker error share one deadline. Whichever comes first starts it.
        nonlocal deadline
        with deadline_lock:
            if finished or deadline is not None:
                return
            deadline = Timer(shutdown_timeout_ms / 1000, expire)
            deadline.daemon = True
            deadline.start()

    def relay_signals() -> None:
        nonlocal first_signal
        while payload := os.read(signal_reader, 1):
            signum = payload[0]
            if first_signal is not None:
                force_exit(128 + signum)
            first_signal = signum
            start_deadline()
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
        # The worker reports its first fatal error before it drains, so a handler that ignores
        # cancellation cannot keep the deadline from starting.
        worker._run_continuously(requested_stop_version, lambda _error: start_deadline())
    finally:
        drained.set()
        for signum in installed_signals:
            signal.signal(signum, previous_handlers[signum])
        os.close(signal_writer)
        signal_relay.join()
        os.close(signal_reader)
        with deadline_lock:
            finished = True
            if deadline is not None:
                deadline.cancel()
            started_expiry = expiring
        if started_expiry:
            exited.wait()


__all__ = ["run_worker_process"]
