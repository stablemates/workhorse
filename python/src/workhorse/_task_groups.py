"""Statements, validation, and row mapping that the task group calls share (ADR 0095)."""

from __future__ import annotations

import json
from collections.abc import Mapping, Sequence
from datetime import datetime
from typing import Any, cast

from ._drivers import Row
from ._statements import SQL_STATEMENTS, DriverStatement
from .types import (
    MAX_TASK_GROUP_DRIFT_LIMIT,
    MAX_TASK_GROUP_PAGE_SIZE,
    EnqueueRequest,
    Json,
    TaskGroup,
    TaskGroupCallback,
    TaskGroupCallbackKind,
    TaskGroupCounts,
    TaskGroupDrift,
    TaskGroupEvent,
    TaskGroupLink,
    TaskGroupMember,
    TaskGroupMemberPage,
    TaskGroupRecordedCounts,
    TaskGroupRepair,
)


def _statement(name: str) -> DriverStatement:
    psycopg, asyncpg = SQL_STATEMENTS[name]
    return DriverStatement(psycopg=psycopg, asyncpg=asyncpg)


CREATE = _statement("create_task_group_v1")
ADD = _statement("add_task_group_members_v1")
SEAL = _statement("seal_task_group_v1")
GET = _statement("get_task_group_v1")
FOR_TASK = _statement("task_group_for_task_v1")
LIST_MEMBERS = _statement("list_task_group_members_v1")
LIST_EVENTS = _statement("list_task_group_events_v1")
CANCEL = _statement("cancel_task_group_v1")
LIST_DRIFT = _statement("list_task_group_drift_v1")
REPAIR_DRIFT = _statement("repair_task_group_drift_v1")

# The documented callback order, with the keys that create_task_group_v1 reads.
CALLBACK_KEYS: tuple[tuple[TaskGroupCallbackKind, str], ...] = (
    ("on_finish", "onFinish"),
    ("on_success", "onSuccess"),
    ("on_failure", "onFailure"),
)


def callback_requests(
    on_finish: EnqueueRequest | None,
    on_success: EnqueueRequest | None,
    on_failure: EnqueueRequest | None,
) -> list[tuple[str, EnqueueRequest]]:
    """Return each requested callback with its JSON key, after the coalescing checks."""
    requested = zip(CALLBACK_KEYS, (on_finish, on_success, on_failure), strict=True)
    callbacks = [(key, request) for (_kind, key), request in requested if request is not None]
    for _key, request in callbacks:
        options = request.options
        if any((options.idempotency, options.debounce, options.throttle)):
            raise ValueError(
                "task group callbacks cannot use enqueue idempotency, debounce, or throttle"
            )
    return callbacks


def encode_callbacks(
    callbacks: Sequence[tuple[str, EnqueueRequest]], values: Sequence[dict[str, Json]]
) -> str:
    """Encode the serialized callback requests as the object create_task_group_v1 reads.

    PostgreSQL enqueues a callback when the group finishes, so it carries no run time unless the
    caller set one.
    """
    document: dict[str, Json] = {}
    for (key, request), value in zip(callbacks, values, strict=True):
        if request.options.run_at is None:
            value.pop("runAt", None)
        document[key] = value
    return json.dumps(document, separators=(",", ":"), ensure_ascii=False)


def validate_limit(limit: int, maximum: int) -> int:
    if isinstance(limit, bool) or not isinstance(limit, int) or not 1 <= limit <= maximum:
        raise ValueError(f"limit must be an integer from 1 to {maximum}")
    return limit


def member_parameters(group_id: str, after: int, limit: int) -> tuple[object, ...]:
    validate_limit(limit, MAX_TASK_GROUP_PAGE_SIZE)
    if isinstance(after, bool) or not isinstance(after, int) or after < 0:
        raise ValueError("after must be a non-negative integer")
    return (group_id, after, limit)


def event_parameters(group_id: str, limit: int) -> tuple[object, ...]:
    return (group_id, validate_limit(limit, MAX_TASK_GROUP_PAGE_SIZE))


def drift_limit(limit: int) -> int:
    return validate_limit(limit, MAX_TASK_GROUP_DRIFT_LIMIT)


def _text(value: object) -> str:
    return str(value)


def _optional_text(value: object) -> str | None:
    return None if value is None else str(value)


def _json_value(value: object) -> Any:
    return json.loads(value) if isinstance(value, str | bytes | bytearray) else value


def _integer(value: object) -> int:
    return int(cast(int | str, value))


def task_group(row: Row) -> TaskGroup:
    callbacks = cast(Mapping[str, Mapping[str, object]], _json_value(row["callbacks"]) or {})
    return TaskGroup(
        id=_text(row["group_id"]),
        state=cast(Any, row["state"]),
        result=cast(Any, row["result"]),
        counts=TaskGroupCounts(
            total=_integer(row["total"]),
            succeeded=_integer(row["succeeded"]),
            failed=_integer(row["failed"]),
            canceled=_integer(row["canceled"]),
            pending=_integer(row["pending"]),
        ),
        created_at=cast(datetime, row["created_at"]),
        sealed_at=cast(datetime | None, row["sealed_at"]),
        finished_at=cast(datetime | None, row["finished_at"]),
        canceled_at=cast(datetime | None, row["canceled_at"]),
        canceled_by=cast(str | None, row["canceled_by"]),
        cancel_reason=cast(str | None, row["cancel_reason"]),
        # PostgreSQL returns the callbacks as jsonb, which orders keys by length. Read them in the
        # documented order instead.
        callbacks=tuple(
            TaskGroupCallback(
                kind=kind,
                task_id=_optional_text(callbacks[kind].get("taskId")),
            )
            for kind, _key in CALLBACK_KEYS
            if kind in callbacks
        ),
    )


def optional_task_group(rows: Sequence[Row]) -> TaskGroup | None:
    return None if not rows else task_group(rows[0])


def one_task_group(rows: Sequence[Row], operation: str) -> TaskGroup:
    if len(rows) != 1:
        raise RuntimeError(f"{operation} returned {len(rows)} rows; expected one")
    return task_group(rows[0])


def task_group_link(rows: Sequence[Row]) -> TaskGroupLink | None:
    if not rows:
        return None
    row = rows[0]
    return TaskGroupLink(
        role=cast(Any, row["role"]),
        callback=cast(Any, row["callback_kind"]),
        group=task_group(row),
    )


def member_probe_parameters(
    group_id: str, rows: Sequence[Row], limit: int
) -> tuple[object, ...] | None:
    """The parameters that read one member after a full page, or None for a page that is not full.

    A full page can be the last page. `list_task_group_members_v1` reads at most 1,000 members, so
    a read of `limit + 1` fails at the maximum. The read of one member tells the two apart.
    """
    return (group_id, _integer(rows[-1]["position"]), 1) if len(rows) == limit else None


def member_page(rows: Sequence[Row], more: bool) -> TaskGroupMemberPage:
    members = tuple(
        TaskGroupMember(
            position=_integer(row["position"]),
            task_id=_text(row["task_id"]),
            queue=cast(str | None, row["queue_name"]),
            type=cast(str | None, row["task_type"]),
            state=cast(Any, row["state"]),
            outcome=cast(Any, row["outcome"]),
            added_at=cast(datetime, row["added_at"]),
            counted_at=cast(datetime | None, row["counted_at"]),
        )
        for row in rows
    )
    return TaskGroupMemberPage(
        members=members,
        next_after=members[-1].position if more else None,
    )


def events(rows: Sequence[Row]) -> tuple[TaskGroupEvent, ...]:
    return tuple(
        TaskGroupEvent(
            id=_text(row["event_id"]),
            type=cast(Any, row["event_type"]),
            details=cast(Json, _json_value(row["details"])),
            occurred_at=cast(datetime, row["occurred_at"]),
        )
        for row in rows
    )


def drifts(rows: Sequence[Row]) -> tuple[TaskGroupDrift, ...]:
    return tuple(
        TaskGroupDrift(
            group_id=_text(row["group_id"]),
            state=cast(Any, row["state"]),
            recorded=TaskGroupRecordedCounts(
                total=_integer(row["recorded_total"]),
                succeeded=_integer(row["recorded_succeeded"]),
                failed=_integer(row["recorded_failed"]),
                canceled=_integer(row["recorded_canceled"]),
            ),
            counted=TaskGroupCounts(
                total=_integer(row["total"]),
                succeeded=_integer(row["succeeded"]),
                failed=_integer(row["failed"]),
                canceled=_integer(row["canceled"]),
                pending=_integer(row["pending"]),
            ),
            action=cast(Any, row["action"]),
        )
        for row in rows
    )


def repairs(rows: Sequence[Row]) -> tuple[TaskGroupRepair, ...]:
    return tuple(
        TaskGroupRepair(
            group_id=_text(row["group_id"]),
            recorded_pending=_integer(row["recorded_pending"]),
            pending=_integer(row["pending"]),
            action=cast(Any, row["action"]),
        )
        for row in rows
    )
