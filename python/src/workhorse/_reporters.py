"""Isolation of the reporter callbacks that an application gives to a worker.

A reporter callback observes the worker: ``on_registration_error`` and ``on_notification_error``.
It is not part of the dispatch contract, so its failure must not stop claims or change the result
of a run. The ``workhorse.worker`` logger is the diagnostic path, so the worker never calls the
failed reporter again for its own failure.
"""

from __future__ import annotations

import logging
from collections.abc import Callable
from contextlib import suppress
from threading import Lock
from time import monotonic

# A reporter callback that always fails writes to the log at most once in this interval.
REPORTER_FAILURE_REPORT_INTERVAL_SECONDS = 60.0

_LOGGER = logging.getLogger("workhorse.worker")


class ReporterFailures:
    """When the worker last logged a failure of each reporter callback."""

    def __init__(self) -> None:
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
        # Formatting the failure can raise. The diagnostic path must not become a second failure.
        with suppress(Exception):
            _LOGGER.error("Workhorse worker %s reporter failed%s", name, detail, exc_info=failure)
