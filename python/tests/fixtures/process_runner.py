from __future__ import annotations

import os
import signal
import sys
from threading import Event, Lock

from workhorse import run_worker_process


def _emit(message: str) -> None:
    os.write(sys.stdout.fileno(), message.encode() + b"\n")


class FixtureWorker:
    def __init__(self, *, mode: str) -> None:
        self._mode = mode
        self._finished = Event()
        self._state_lock = Lock()
        self._stop_version = 0
        self._ready = False

    def _announce_ready(self) -> None:
        if not self._ready:
            _emit("ready")
            self._ready = True

    def _stop_version_snapshot(self) -> int:
        with self._state_lock:
            return self._stop_version

    def _run_continuously(self, requested_stop_version: int) -> None:
        if self._mode == "state-lock":
            with self._state_lock:
                self._announce_ready()
                signal.pause()
            self._finished.wait()
            return
        self._announce_ready()
        if self._mode == "pre-run-signal":
            os.kill(os.getpid(), signal.SIGTERM)
        if self._mode != "block" and requested_stop_version != self._stop_version:
            return
        self._finished.wait()

    def run(self) -> None:
        self._announce_ready()
        if self._mode == "pre-run-signal":
            os.kill(os.getpid(), signal.SIGTERM)
        self._run_continuously(self._stop_version_snapshot())

    def stop(self) -> None:
        with self._state_lock:
            self._stop_version += 1
        _emit("stopping")
        if self._mode != "block":
            self._finished.set()


run_worker_process(
    FixtureWorker(mode=sys.argv[1]),  # type: ignore[arg-type]
    shutdown_timeout_ms=int(sys.argv[2]),
)
