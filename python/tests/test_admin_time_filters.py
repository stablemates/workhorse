"""Admin time filters reach SQL as UTC text with ``Z``, and a naive bound never reaches SQL.

``list_tasks_v1``, ``list_dead_letters_v1``, and ``redrive_many_v1`` read each bound with
``::timestamptz``. PostgreSQL reads text without an offset in the session ``TimeZone``, so a naive
bound could select a different time range in each session.
"""

from __future__ import annotations

import json
from collections.abc import Callable, Sequence
from datetime import UTC, datetime, timedelta, timezone
from typing import Any, cast

import pytest

from workhorse import (
    Admin,
    AdminAudit,
    AsyncAdmin,
    DeadLetterFilter,
    DeadLetterQuery,
    TaskListQuery,
)
from workhorse._statements import (
    MINIMUM_SCHEMA_VERSION,
    PROTOCOL_VERSION,
    STATEMENTS,
    DriverStatement,
)

_COMPATIBLE = [
    {"kind": "schema", "version": MINIMUM_SCHEMA_VERSION},
    {"kind": "protocol", "version": PROTOCOL_VERSION},
]
_AUDIT = AdminAudit(actor="operator", reason="replay", request_id="request-1")
_NAIVE = datetime(2026, 10, 22, 10, 0, 0, 123456)
_BERLIN = datetime(2026, 10, 22, 12, 0, 0, 123456, tzinfo=timezone(timedelta(hours=2)))
_UTC_TEXT = "2026-10-22T10:00:00.123456Z"
_LATER = datetime(2026, 10, 23, tzinfo=UTC)


class _RecordingExecutor:
    """Answer the compatibility check, and record every other statement with an empty result."""

    def __init__(self) -> None:
        self.calls: list[tuple[DriverStatement, tuple[object, ...]]] = []

    def rows(self, statement: DriverStatement, parameters: Sequence[object] = ()) -> list[Any]:
        if statement is STATEMENTS.compatibility:
            return list(_COMPATIBLE)
        self.calls.append((statement, tuple(parameters)))
        return []


class _AsyncRecordingExecutor(_RecordingExecutor):
    async def rows(  # type: ignore[override]
        self, statement: DriverStatement, parameters: Sequence[object] = ()
    ) -> list[Any]:
        return _RecordingExecutor.rows(self, statement, parameters)


def _filter(executor: _RecordingExecutor) -> dict[str, object]:
    [(_, parameters)] = executor.calls
    return cast(dict[str, object], json.loads(str(parameters[0])))


_SyncCall = Callable[[Admin], object]

_NAIVE_CALLS: dict[str, _SyncCall] = {
    "list_tasks created_after": lambda admin: admin.list_tasks(TaskListQuery(created_after=_NAIVE)),
    "list_tasks created_before": lambda admin: admin.list_tasks(
        TaskListQuery(created_before=_NAIVE)
    ),
    "list_tasks naive and aware bounds": lambda admin: admin.list_tasks(
        TaskListQuery(created_after=_NAIVE, created_before=_LATER)
    ),
    "list_dead_letters finished_after": lambda admin: admin.list_dead_letters(
        DeadLetterQuery(finished_after=_NAIVE)
    ),
    "list_dead_letters finished_before": lambda admin: admin.list_dead_letters(
        DeadLetterQuery(finished_before=_NAIVE)
    ),
    "redrive_many finished_after": lambda admin: admin.redrive_many(
        DeadLetterFilter(finished_after=_NAIVE), _AUDIT
    ),
    "redrive_many finished_before": lambda admin: admin.redrive_many(
        DeadLetterFilter(finished_before=_NAIVE), _AUDIT
    ),
}


@pytest.mark.parametrize("call", _NAIVE_CALLS.values(), ids=_NAIVE_CALLS.keys())
def test_a_naive_time_filter_raises_before_the_sql_function_call(call: _SyncCall) -> None:
    executor = _RecordingExecutor()

    with pytest.raises(ValueError, match="timestamps must include a timezone"):
        call(Admin._from_executor(executor))  # type: ignore[arg-type]

    assert executor.calls == []


def test_list_tasks_sends_created_bounds_as_utc_text() -> None:
    executor = _RecordingExecutor()

    Admin._from_executor(executor).list_tasks(  # type: ignore[arg-type]
        TaskListQuery(created_after=_BERLIN, created_before=_LATER)
    )

    assert _filter(executor) == {
        "createdAfter": _UTC_TEXT,
        "createdBefore": "2026-10-23T00:00:00.000000Z",
    }


def test_list_dead_letters_sends_finished_bounds_as_utc_text() -> None:
    executor = _RecordingExecutor()

    Admin._from_executor(executor).list_dead_letters(  # type: ignore[arg-type]
        DeadLetterQuery(finished_after=_BERLIN, finished_before=_LATER)
    )

    assert _filter(executor) == {
        "finishedAfter": _UTC_TEXT,
        "finishedBefore": "2026-10-23T00:00:00.000000Z",
    }


def test_redrive_many_sends_finished_bounds_as_utc_text() -> None:
    executor = _RecordingExecutor()

    Admin._from_executor(executor).redrive_many(  # type: ignore[arg-type]
        DeadLetterFilter(finished_after=_BERLIN, finished_before=_LATER), _AUDIT
    )

    assert _filter(executor) == {
        "finishedAfter": _UTC_TEXT,
        "finishedBefore": "2026-10-23T00:00:00.000000Z",
    }


async def test_async_admin_applies_the_same_time_filter_rule() -> None:
    executor = _AsyncRecordingExecutor()
    admin = AsyncAdmin(executor)  # type: ignore[arg-type]

    with pytest.raises(ValueError, match="timestamps must include a timezone"):
        await admin.list_tasks(TaskListQuery(created_before=_NAIVE))
    with pytest.raises(ValueError, match="timestamps must include a timezone"):
        await admin.list_dead_letters(DeadLetterQuery(finished_before=_NAIVE))
    with pytest.raises(ValueError, match="timestamps must include a timezone"):
        await admin.redrive_many(DeadLetterFilter(finished_after=_NAIVE), _AUDIT)
    assert executor.calls == []

    await admin.redrive_many(DeadLetterFilter(finished_after=_BERLIN), _AUDIT)

    assert _filter(executor) == {"finishedAfter": _UTC_TEXT}
