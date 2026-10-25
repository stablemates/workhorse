"""SM-1696: a reporter callback that raises never stops the worker, and its log is bounded.

SM-1726: the log is the catalogued ``workhorse.worker.reporter_failed`` record.
"""

from __future__ import annotations

import logging
from typing import Any

import pytest

from workhorse import _reporters
from workhorse._reporters import REPORTER_FAILURE_REPORT_INTERVAL_SECONDS
from workhorse.async_worker import AsyncWorker
from workhorse.worker import Worker


class _Pool:
    """A pool the worker never draws a connection from. The executor answers every statement."""

    max_size = 5


class _OfflineExecutor:
    """An executor that fails every statement, as a short database outage does."""

    def rows(self, _statement: Any, _parameters: Any = ()) -> list[Any]:
        raise ConnectionError("registry is offline")


def _raise(_error: BaseException) -> None:
    raise RuntimeError("alert client is offline")


def _reports(caplog: pytest.LogCaptureFixture, name: str) -> list[logging.LogRecord]:
    return [
        record
        for record in caplog.records
        if record.name == "workhorse.worker" and f"{name} reporter failed" in record.getMessage()
    ]


def test_a_raising_registration_reporter_does_not_stop_the_worker(
    caplog: pytest.LogCaptureFixture, monkeypatch: pytest.MonkeyPatch
) -> None:
    emitted: list[tuple[Any, ...]] = []
    monkeypatch.setattr(_reporters, "emit_log", lambda *record: emitted.append(record))
    calls: list[BaseException] = []

    def reporter(error: BaseException) -> None:
        calls.append(error)
        _raise(error)

    worker = Worker(
        _Pool(),  # type: ignore[arg-type]
        queue="reporters",
        on_registration_error=reporter,
        worker_id="reporter-worker",
        _executor=_OfflineExecutor(),  # type: ignore[arg-type]
    )

    for _ in range(3):
        worker._refresh_registration(force=True)

    assert [type(error) for error in calls] == [ConnectionError] * 3
    assert worker._registered is False
    reports = _reports(caplog, "on_registration_error")
    assert len(reports) == 1
    assert reports[0].levelno == logging.ERROR
    attributes = {
        "workhorse.worker.id": "reporter-worker",
        "workhorse.worker.reporter": "registration_error",
        "error.type": "RuntimeError",
    }
    assert reports[0].__dict__["event.name"] == "workhorse.worker.reporter_failed"
    assert {key: reports[0].__dict__[key] for key in attributes} == attributes
    # The report never carries the error message.
    assert reports[0].exc_info is None
    assert "alert client is offline" not in caplog.text
    assert emitted == [
        (
            "WARN",
            "workhorse.worker.reporter_failed",
            "Workhorse worker on_registration_error reporter failed",
            attributes,
        )
    ]

    # After the interval, the next report states the failures that the worker did not log.
    state = worker._reporter_failures._state
    reported_at, suppressed = state["on_registration_error"]
    state["on_registration_error"] = (
        reported_at - REPORTER_FAILURE_REPORT_INTERVAL_SECONDS,
        suppressed,
    )
    worker._refresh_registration(force=True)
    reports = _reports(caplog, "on_registration_error")
    assert len(reports) == 2
    assert reports[1].getMessage().endswith("reporter failed after 2 unreported failures")
    assert len(emitted) == 2


def test_a_raising_notification_reporter_is_logged_once_in_each_interval(
    caplog: pytest.LogCaptureFixture,
) -> None:
    worker = Worker(_Pool(), queue="reporters", on_notification_error=_raise)  # type: ignore[arg-type]
    reporter = worker._notification_reporter()
    assert reporter is not None

    reporter(ConnectionError("listener is offline"))
    reporter(ConnectionError("listener is offline"))

    reports = _reports(caplog, "on_notification_error")
    assert len(reports) == 1
    assert reports[0].__dict__["workhorse.worker.reporter"] == "notification_error"
    # Each callback has its own interval.
    assert _reports(caplog, "on_registration_error") == []


def test_a_worker_without_a_notification_reporter_gives_the_listener_none() -> None:
    assert Worker(_Pool(), queue="reporters")._notification_reporter() is None  # type: ignore[arg-type]


def test_an_async_worker_isolates_its_reporters(caplog: pytest.LogCaptureFixture) -> None:
    worker = AsyncWorker(
        object(),  # type: ignore[arg-type]
        _Pool(),
        "asyncpg",
        on_notification_error=_raise,
        on_registration_error=_raise,
    )
    reporter = worker._notification_reporter
    assert reporter is not None

    reporter(ConnectionError("listener is offline"))

    assert len(_reports(caplog, "on_notification_error")) == 1
    # The core runs the registry refreshes, so it holds the registration reporter.
    assert worker._inner._on_registration_error is _raise


def test_a_raising_log_handler_does_not_stop_the_opentelemetry_record(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    emitted: list[tuple[Any, ...]] = []
    monkeypatch.setattr(_reporters, "emit_log", lambda *record: emitted.append(record))

    class _RaisingHandler(logging.Handler):
        def emit(self, _record: logging.LogRecord) -> None:
            raise OSError("log sink is offline")

        def handleError(self, _record: logging.LogRecord) -> None:
            raise OSError("log sink is offline")

    logger = logging.getLogger("workhorse.worker")
    handler = _RaisingHandler()
    logger.addHandler(handler)
    try:
        worker = Worker(_Pool(), queue="reporters", on_notification_error=_raise)  # type: ignore[arg-type]
        reporter = worker._notification_reporter()
        assert reporter is not None
        reporter(ConnectionError("listener is offline"))
    finally:
        logger.removeHandler(handler)

    assert [record[1] for record in emitted] == ["workhorse.worker.reporter_failed"]


def test_a_failure_whose_class_name_raises_does_not_reach_the_worker(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    emitted: list[tuple[Any, ...]] = []
    monkeypatch.setattr(_reporters, "emit_log", lambda *record: emitted.append(record))

    class _Meta(type):
        @property
        def __name__(cls) -> str:  # type: ignore[override]
            raise OSError("class name is offline")

    class _Odd(Exception, metaclass=_Meta):
        pass

    def reporter(_error: BaseException) -> None:
        raise _Odd

    worker = Worker(_Pool(), queue="reporters", on_notification_error=reporter)  # type: ignore[arg-type]
    notification_reporter = worker._notification_reporter()
    assert notification_reporter is not None

    notification_reporter(ConnectionError("listener is offline"))

    assert [record[3]["error.type"] for record in emitted] == ["Exception"]
