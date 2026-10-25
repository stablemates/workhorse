"""Isolation of the reporter callbacks that an application gives to a worker.

A reporter callback observes the worker: ``on_registration_error`` and ``on_notification_error``.
It is not part of the dispatch contract, so its failure must not stop claims or change the result
of a run. The ``workhorse.worker.reporter_failed`` record is the diagnostic path, so the worker
never calls the failed reporter again for its own failure.
"""

from __future__ import annotations

import logging
from collections.abc import Callable
from contextlib import suppress
from threading import Lock
from time import monotonic
from typing import Final

from ._telemetry import emit_log

# A reporter callback that always fails writes to the log at most once in this interval.
REPORTER_FAILURE_REPORT_INTERVAL_SECONDS = 60.0
REPORTER_FAILED_EVENT: Final = "workhorse.worker.reporter_failed"

# The workhorse.worker.reporter value of each reporter callback. Every SDK uses the same values.
_REPORTER_VALUES = {
    "on_registration_error": "registration_error",
    "on_notification_error": "notification_error",
}

_LOGGER = logging.getLogger("workhorse.worker")


class ReporterFailures:
    """When the worker last logged a failure of each reporter callback."""

    def __init__(self, worker_id: str) -> None:
        self._worker_id = worker_id
        self._lock = Lock()
        # For each callback: when the worker last logged a failure, and the failures since then
        # that it did not log.
        self._state: dict[str, tuple[float, int]] = {}

    def call(
        self, name: str, reporter: Callable[[BaseException], None] | None, error: BaseException
    ) -> None:
        """Call ``reporter`` with ``error``, and log a failure of it instead of raising it."""
        if reporter is None:
            return
        try:
            reporter(error)
        except Exception as failure:
            self._failed(name, failure)

    def _failed(self, name: str, failure: Exception) -> None:
        now = monotonic()
        with self._lock:
            state = self._state.get(name)
            if state is not None and now - state[0] < REPORTER_FAILURE_REPORT_INTERVAL_SECONDS:
                self._state[name] = (state[0], state[1] + 1)
                return
            suppressed = 0 if state is None else state[1]
            self._state[name] = (now, 0)
        detail = f" after {suppressed} unreported failures" if suppressed > 0 else ""
        body = f"Workhorse worker {name} reporter failed{detail}"
        # The report names the error type only. The error message can hold application data.
        attributes = {
            "workhorse.worker.id": self._worker_id,
            "workhorse.worker.reporter": _REPORTER_VALUES[name],
            "error.type": _error_type(failure),
        }
        # Each path has its own guard, so a failure of one path does not stop the other. The
        # diagnostic path must not become a second failure.
        with suppress(Exception):
            _LOGGER.error(body, extra={"event.name": REPORTER_FAILED_EVENT, **attributes})
        with suppress(Exception):
            emit_log("WARN", REPORTER_FAILED_EVENT, body, attributes)


def _error_type(failure: Exception) -> str:
    """The class name of ``failure``. A class can define ``__name__`` so that the lookup raises."""
    try:
        return str(type(failure).__name__)
    except Exception:
        return "Exception"
