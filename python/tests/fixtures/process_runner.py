from __future__ import annotations

import os
import signal
import sys
from threading import Event

from workhorse import run_worker_process


class FixtureWorker:
    def __init__(self, *, mode: str) -> None:
        self._mode = mode
        self._finished = Event()
        self._stop_version = 0
        self._ready = False

    def _announce_ready(self) -> None:
        if not self._ready:
            print("ready", flush=True)
            self._ready = True

    def _stop_version_snapshot(self) -> int:
        return self._stop_version

    def _run_continuously(self, requested_stop_version: int) -> None:
        self._announce_ready()
        if self._mode == "pre-run-signal":
            os.kill(os.getpid(), signal.SIGTERM)
        if requested_stop_version != self._stop_version:
            return
        self._finished.wait()

    def run(self) -> None:
        self._announce_ready()
        if self._mode == "pre-run-signal":
            os.kill(os.getpid(), signal.SIGTERM)
        self._run_continuously(self._stop_version_snapshot())

    def stop(self) -> None:
        print("stopping", flush=True)
        self._stop_version += 1
        if self._mode == "drain":
            self._finished.set()


run_worker_process(
    FixtureWorker(mode=sys.argv[1]),  # type: ignore[arg-type]
    shutdown_timeout_ms=int(sys.argv[2]),
)
