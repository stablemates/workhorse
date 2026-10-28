"""SM-1883: a batch checks the options of every request before its first statement.

A child set, a task group create, and a task group add can read a payload contract, run the
compatibility query, or read the membership of a task. Each case puts a valid request before an
invalid one. The fake connections record each statement, so a statement before the refusal fails
the case.
"""

from __future__ import annotations

import asyncio
from collections.abc import Mapping, Sequence
from datetime import UTC, datetime

import pytest
from test_enqueue import Connection

from workhorse import (
    AsyncQueue,
    CancellationToken,
    ChildTaskRequest,
    ClaimedTask,
    EnqueueOptions,
    EnqueueRequest,
    Queue,
)
from workhorse.async_worker import _AsyncContextAdapter, _BridgeThreads
from workhorse.worker import _AttemptOutcomeArbiter, _HandlerDurability

MESSAGE = "max_attempts must be between 1 and 100, or 0 for the default"
VALID = EnqueueRequest("valid", {})
INVALID = EnqueueRequest("invalid", {}, EnqueueOptions(max_attempts=101))


class RecordingExecutor:
    """Records each statement and answers it with no rows."""

    def __init__(self) -> None:
        self.statements: list[object] = []

    def rows(self, statement: object, _parameters: Sequence[object] = ()) -> list[object]:
        self.statements.append(statement)
        return []


class AsyncpgConnection:
    """Records each statement and answers it with no rows."""

    def __init__(self) -> None:
        self.calls: list[str] = []

    async def fetch(self, sql: str, *_parameters: object) -> Sequence[Mapping[str, object]]:
        self.calls.append(sql)
        return []


def task() -> ClaimedTask:
    return ClaimedTask(
        id="00000000-0000-4000-8000-000000001883",
        queue="parents",
        type="parent",
        priority=0,
        payload=None,
        contract_version=None,
        result_max_bytes=1_048_576,
        redact_error_details=False,
        trace_context=None,
        attempt=1,
        max_attempts=1,
        retry_policy=None,
        deadline_at=None,
        execution_timeout_ms=None,
        attempt_timeout_at=None,
        fence_token=1,
        lease_expires_at=datetime.fromtimestamp(0, UTC),
    )


def test_a_child_set_and_a_member_add_check_every_request_before_a_read() -> None:
    executor = RecordingExecutor()
    # A statement through the queue pops from an empty response list and fails the case.
    connection = Connection([])
    context = _HandlerDurability(
        executor,
        task(),
        "python-option-order",
        CancellationToken(),
        _AttemptOutcomeArbiter(),
        task_groups=Queue(connection),
    )
    children = [
        ChildTaskRequest("valid", "valid", {}),
        ChildTaskRequest("invalid", "invalid", {}, EnqueueOptions(max_attempts=101)),
    ]

    with pytest.raises(ValueError, match=MESSAGE):
        context.run_children(children)
    with pytest.raises(ValueError, match=MESSAGE):
        context.run_children_all(children)
    with pytest.raises(ValueError, match=MESSAGE):
        context.add_to_task_group([VALID, INVALID])
    assert executor.statements == []
    assert connection.calls == []


async def test_an_async_handler_checks_every_child_and_added_request_before_a_read() -> None:
    executor = RecordingExecutor()
    connection = Connection([])
    durability = _HandlerDurability(
        executor,
        task(),
        "python-option-order",
        CancellationToken(),
        _AttemptOutcomeArbiter(),
        task_groups=Queue(connection),
    )
    threads = _BridgeThreads()
    try:
        context = _AsyncContextAdapter(
            durability.context(), asyncio.get_running_loop(), threads
        ).context()
        children = [
            ChildTaskRequest("valid", "valid", {}),
            ChildTaskRequest("invalid", "invalid", {}, EnqueueOptions(max_attempts=101)),
        ]
        with pytest.raises(ValueError, match=MESSAGE):
            await context.run_children(children)
        with pytest.raises(ValueError, match=MESSAGE):
            await context.task_group.add([VALID, INVALID])
    finally:
        threads.close()
    assert executor.statements == []
    assert connection.calls == []


def test_a_task_group_checks_every_callback_and_member_before_a_statement() -> None:
    connection = Connection([])
    queue = Queue(connection)

    with pytest.raises(ValueError, match=MESSAGE):
        queue.create_task_group(on_finish=VALID, on_success=INVALID)
    with pytest.raises(ValueError, match=MESSAGE), queue.task_group(on_finish=INVALID) as group:
        group.add([VALID])
    with pytest.raises(ValueError, match=MESSAGE), queue.task_group() as group:
        group.add([VALID, INVALID])
    with pytest.raises(ValueError, match=MESSAGE):
        queue.add_to_task_group("00000000-0000-4000-8000-000000000002", [VALID, INVALID])
    assert connection.calls == []


async def test_an_async_task_group_checks_every_callback_and_member_before_a_statement() -> None:
    connection = AsyncpgConnection()
    queue = AsyncQueue.from_asyncpg(connection)

    with pytest.raises(ValueError, match=MESSAGE):
        await queue.create_task_group(on_finish=VALID, on_success=INVALID)
    with pytest.raises(ValueError, match=MESSAGE):
        async with queue.task_group() as group:
            group.add([VALID, INVALID])
    with pytest.raises(ValueError, match=MESSAGE):
        await queue.add_to_task_group("00000000-0000-4000-8000-000000000002", [VALID, INVALID])
    assert connection.calls == []
