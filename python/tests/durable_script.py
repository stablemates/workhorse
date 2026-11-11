"""Runs the durable-script fixtures of protocol/v1/runtime.json (SM-1950).

A handler runs the fixture's script through its handler context, and the runner drives the task
through the fixture's steps. protocol/README.md describes the operations and the steps. The sync
worker and the async worker run the same steps, each through its own handler context.

The phase ``suspend`` runs the steps before ``handOff``, and ``replay`` runs the steps after it, so
two SDKs can share one task. ``all`` runs every step and resets the counters at ``handOff``.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import threading
import time
from collections.abc import Awaitable, Callable, Mapping
from datetime import datetime
from typing import Any

import psycopg
from psycopg_pool import AsyncConnectionPool, ConnectionPool

from workhorse import (
    AsyncHandlerContext,
    AsyncWorker,
    ChildTaskRequest,
    EnqueueOptions,
    HandlerContext,
    Queue,
    Worker,
)

# A bound on the claims of one run step, so a defect cannot loop for ever. The run_once of each SDK
# can claim more than one task, so a step names the work that ends, not a count of claims.
MAXIMUM_DRAIN_PASSES = 20


# The operations that can suspend the task.
SUSPENDING = frozenset({"sleep", "sleepUntil", "waitForSignal", "waitForHuman", "runChild"})


class Counters:
    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.handler_runs = 0
        self.checkpoint_operations = 0
        self.caught_suspensions = 0
        # Handler runs that reached the end of the script. A run that suspends never does.
        self.completed_scripts = 0
        # Timer, wait, and child calls that returned. A call that suspends never returns.
        self.returned_suspending_calls = 0

    def add_operation(self) -> int:
        with self.lock:
            self.checkpoint_operations += 1
            return self.checkpoint_operations

    def reset(self) -> None:
        with self.lock:
            self.handler_runs = 0
            self.checkpoint_operations = 0
            self.caught_suspensions = 0
            self.completed_scripts = 0
            self.returned_suspending_calls = 0


def select_steps(fixture: Mapping[str, Any], phase: str) -> list[Mapping[str, Any]]:
    steps: list[Mapping[str, Any]] = list(fixture["steps"])
    if phase == "all":
        return steps
    hand_off = next(
        (index for index, step in enumerate(steps) if step["action"] == "handOff"), None
    )
    assert hand_off is not None, f"{fixture['id']} has no handOff step for the {phase} phase"
    if phase == "suspend":
        return steps[:hand_off]
    assert phase == "replay", f"unknown phase {phase}"
    return steps[hand_off + 1 :]


def prepare_task(
    connection: psycopg.Connection[Any], fixture: Mapping[str, Any], phase: str
) -> str:
    """Enqueues the task of the fixture, or finds the task that another SDK enqueued."""
    if phase == "replay":
        rows = connection.execute(
            "SELECT id::text FROM workhorse.task WHERE task_type = %s", (fixture["taskType"],)
        ).fetchall()
        assert len(rows) == 1, f"expected one {fixture['taskType']} task, found {len(rows)}"
        return str(rows[0][0])
    payload: Any = {}
    if "payloadSql" in fixture:
        row = connection.execute(fixture["payloadSql"]).fetchone()
        assert row is not None
        payload = json.loads(row[0])
    return Queue(connection).enqueue(
        fixture["taskType"], payload, EnqueueOptions(queue=queue_name(fixture))
    )


def queue_name(fixture: Mapping[str, Any]) -> str:
    return f"runtime-{fixture['id']}"


def run_step(
    connection: psycopg.Connection[Any],
    fixture: Mapping[str, Any],
    task_id: str,
    step: Mapping[str, Any],
    counters: Counters,
    where: str,
) -> None:
    """Runs one step that is not ``run``."""
    action = step["action"]
    if action == "sql":
        connection.execute(step["sql"].replace("$1", "%s"), (task_id,))
    elif action == "handOff":
        counters.reset()
    elif action == "expect":
        row = connection.execute(fixture["observe"].replace("$1", "%s"), (task_id,)).fetchone()
        assert row is not None
        observed = json.loads(row[0])
        assert json_equal(observed, step["observed"]), f"{where}: observed {observed}"
        for name, actual in (
            ("handlerRuns", counters.handler_runs),
            ("checkpointOperations", counters.checkpoint_operations),
            ("caughtSuspensions", counters.caught_suspensions),
            ("completedScripts", counters.completed_scripts),
            ("returnedSuspendingCalls", counters.returned_suspending_calls),
        ):
            if name in step:
                assert actual == step[name], f"{where}: {name} is {actual}, expected {step[name]}"
    else:
        raise AssertionError(f"{where}: unknown action {action}")


def json_equal(left: Any, right: Any) -> bool:
    """Compares two JSON values. Python == holds True equal to 1, so a boolean equals only a
    boolean. Numbers compare by value, so 1 and 1.0 are equal."""
    if isinstance(left, bool) or isinstance(right, bool):
        return type(left) is type(right) and left == right
    if isinstance(left, (int, float)) and isinstance(right, (int, float)):
        return left == right
    if isinstance(left, dict) and isinstance(right, dict):
        return left.keys() == right.keys() and all(json_equal(left[k], right[k]) for k in left)
    if isinstance(left, list) and isinstance(right, list):
        return len(left) == len(right) and all(map(json_equal, left, right))
    return type(left) is type(right) and left == right


def run_phase(
    connection: psycopg.Connection[Any],
    pool: ConnectionPool,
    fixture: Mapping[str, Any],
    phase: str,
) -> None:
    """Runs the steps of ``phase`` with the sync worker."""
    steps = select_steps(fixture, phase)
    task_id = prepare_task(connection, fixture, phase)
    counters = Counters()
    worker = Worker(
        pool, queue=queue_name(fixture), worker_id=f"python-{fixture['id']}", concurrency=1
    ).handle(
        fixture["taskType"],
        lambda payload, context: run_script(fixture, payload, context, counters),
    )
    workers: dict[str, Worker] = {"task": worker}
    if "childQueue" in fixture:
        workers["child"] = Worker(
            pool,
            queue=fixture["childQueue"],
            worker_id=f"python-{fixture['id']}-children",
            concurrency=1,
        ).handle(fixture["childTaskType"], lambda payload, _context: {"echo": payload})
    for index, step in enumerate(steps):
        where = f"{fixture['id']} step {index + 1} ({step['action']})"
        if step["action"] == "run":
            selected = workers[step.get("worker", "task")]
            assert selected.run_once() is True, f"{where}: the worker claimed no task"
            for _ in range(MAXIMUM_DRAIN_PASSES):
                if not selected.run_once():
                    break
            else:
                raise AssertionError(f"{where}: the queue did not drain")
        else:
            run_step(connection, fixture, task_id, step, counters, where)


async def run_async_phase(
    connection: psycopg.Connection[Any],
    database_url: str,
    fixture: Mapping[str, Any],
    phase: str,
    returned: Callable[[Awaitable[bool]], Awaitable[bool]],
) -> None:
    """Runs the steps of ``phase`` with the async worker. The sync connection runs in a thread,
    so a statement cannot stall the loop of the worker."""
    steps = select_steps(fixture, phase)
    task_id = await asyncio.to_thread(prepare_task, connection, fixture, phase)
    counters = Counters()
    async with AsyncConnectionPool(
        database_url, min_size=3, max_size=3, kwargs={"autocommit": True}
    ) as pool:
        worker = AsyncWorker.from_psycopg(
            pool,
            queue=queue_name(fixture),
            worker_id=f"python-async-{fixture['id']}",
            concurrency=1,
        )

        async def handler(payload: Any, context: AsyncHandlerContext) -> Any:
            return await run_async_script(fixture, payload, context, counters)

        async def child(payload: Any, _context: AsyncHandlerContext) -> Any:
            return {"echo": payload}

        worker.handle(fixture["taskType"], handler)
        workers = {"task": worker}
        if "childQueue" in fixture:
            workers["child"] = AsyncWorker.from_psycopg(
                pool,
                queue=fixture["childQueue"],
                worker_id=f"python-async-{fixture['id']}-children",
                concurrency=1,
            )
            workers["child"].handle(fixture["childTaskType"], child)
        for index, step in enumerate(steps):
            where = f"{fixture['id']} step {index + 1} ({step['action']})"
            if step["action"] == "run":
                selected = workers[step.get("worker", "task")]
                assert await returned(selected.run_once()) is True, f"{where}: no task claimed"
                for _ in range(MAXIMUM_DRAIN_PASSES):
                    if not await returned(selected.run_once()):
                        break
                else:
                    raise AssertionError(f"{where}: the queue did not drain")
            else:
                await asyncio.to_thread(
                    run_step, connection, fixture, task_id, step, counters, where
                )


def payload_time(payload: Any, field: str) -> datetime:
    value = payload[field]
    assert isinstance(value, str), f"the payload field {field} is not text"
    return datetime.fromisoformat(value)


def child_options(
    fixture: Mapping[str, Any], operation: Mapping[str, Any], payload: Any
) -> EnqueueOptions:
    return EnqueueOptions(
        queue=fixture["childQueue"],
        deadline=payload_time(payload, operation["deadlineField"])
        if "deadlineField" in operation
        else None,
        run_at=payload_time(payload, operation["runAtField"])
        if "runAtField" in operation
        else None,
    )


def child_requests(
    fixture: Mapping[str, Any], operation: Mapping[str, Any]
) -> list[ChildTaskRequest]:
    return [
        ChildTaskRequest(
            name=child["name"],
            type=fixture["childTaskType"],
            payload=child["payload"],
            options=EnqueueOptions(queue=fixture["childQueue"]),
        )
        for child in operation["children"]
    ]


def outcomes(results: Mapping[str, Any]) -> dict[str, Any]:
    return {
        name: {"status": outcome["status"], "result": outcome["result"]}
        if outcome["status"] == "succeeded"
        else {"status": outcome["status"]}
        for name, outcome in results.items()
    }


def run_script(
    fixture: Mapping[str, Any], payload: Any, context: HandlerContext, counters: Counters
) -> Any:
    with counters.lock:
        counters.handler_runs += 1
    result: dict[str, Any] = {}
    for operation in fixture["script"]:
        if operation["op"] == "catchSuspension":
            try:
                run_operation(fixture, operation["step"], payload, context, counters)
            except BaseException:
                # The handler catches the suspension and returns. The worker must suspend the task
                # anyway.
                with counters.lock:
                    counters.caught_suspensions += 1
                return {operation["key"]: True}
            result[operation["key"]] = False
            continue
        value = run_operation(fixture, operation, payload, context, counters)
        if "key" in operation:
            result[operation["key"]] = value
    with counters.lock:
        counters.completed_scripts += 1
    return result


def run_operation_once(
    fixture: Mapping[str, Any],
    operation: Mapping[str, Any],
    payload: Any,
    context: HandlerContext,
    counters: Counters,
) -> Any:
    op = operation["op"]
    if op == "checkpoint":

        def checkpoint_operation() -> Any:
            counters.add_operation()
            return operation["value"]

        if "input" in operation:
            return context.checkpoint(
                operation["name"], checkpoint_operation, input=operation["input"]
            )
        return context.checkpoint(operation["name"], checkpoint_operation)
    if op == "sleep":
        context.sleep(operation["name"], operation["durationMs"])
        return None
    if op == "sleepUntil":
        context.sleep_until(operation["name"], payload_time(payload, operation["wakeAtField"]))
        return None
    if op == "waitForSignal":
        return context.wait_for_signal(operation["name"])
    if op == "waitForHuman":
        return context.wait_for_human(operation["name"], operation["context"])
    if op == "runChild":
        return context.run_child(
            operation["name"],
            fixture["childTaskType"],
            operation["payload"],
            child_options(fixture, operation, payload),
        )
    if op == "runChildren":
        joined = context.run_children(child_requests(fixture, operation))
        # The set join counts as returned before the runner reads its outcomes, so a wrong value
        # still counts.
        with counters.lock:
            counters.returned_suspending_calls += 1
        return outcomes(joined)
    if op == "overlappingCheckpoints":
        return overlapping_checkpoints(operation, context, counters)
    raise AssertionError(f"unknown durable-script operation {op}")


def run_operation(
    fixture: Mapping[str, Any],
    operation: Mapping[str, Any],
    payload: Any,
    context: HandlerContext,
    counters: Counters,
) -> Any:
    value = run_operation_once(fixture, operation, payload, context, counters)
    if operation["op"] in SUSPENDING:
        with counters.lock:
            counters.returned_suspending_calls += 1
    return value


async def run_async_operation(
    fixture: Mapping[str, Any],
    operation: Mapping[str, Any],
    payload: Any,
    context: AsyncHandlerContext,
    counters: Counters,
) -> Any:
    value = await run_async_operation_once(fixture, operation, payload, context, counters)
    if operation["op"] in SUSPENDING:
        with counters.lock:
            counters.returned_suspending_calls += 1
    return value


def overlapping_checkpoints(
    operation: Mapping[str, Any], context: HandlerContext, counters: Counters
) -> Any:
    """Starts a second call with one name while the operation of the first call runs. The operation
    waits until a second operation starts or the window ends, so a call that does not join the call
    in flight runs the operation again."""
    started = threading.Event()

    def checkpoint_operation() -> Any:
        ordinal = counters.add_operation()
        started.set()
        deadline = time.monotonic() + operation["overlapWindowMs"] / 1000
        while counters.checkpoint_operations < 2 and time.monotonic() < deadline:
            time.sleep(0.01)
        return {"operation": ordinal}

    first: dict[str, Any] = {}

    def call_first() -> None:
        try:
            first["value"] = context.checkpoint(operation["name"], checkpoint_operation)
        except BaseException as error:
            first["error"] = error
            started.set()

    thread = threading.Thread(target=call_first)
    thread.start()
    started.wait()
    second = context.checkpoint(operation["name"], checkpoint_operation)
    thread.join()
    if "error" in first:
        raise first["error"]
    return [first["value"], second]


async def run_async_script(
    fixture: Mapping[str, Any], payload: Any, context: AsyncHandlerContext, counters: Counters
) -> Any:
    with counters.lock:
        counters.handler_runs += 1
    result: dict[str, Any] = {}
    for operation in fixture["script"]:
        if operation["op"] == "catchSuspension":
            try:
                await run_async_operation(fixture, operation["step"], payload, context, counters)
            except BaseException:
                # The handler catches the suspension and returns. The worker must suspend the task
                # anyway.
                with counters.lock:
                    counters.caught_suspensions += 1
                return {operation["key"]: True}
            result[operation["key"]] = False
            continue
        value = await run_async_operation(fixture, operation, payload, context, counters)
        if "key" in operation:
            result[operation["key"]] = value
    with counters.lock:
        counters.completed_scripts += 1
    return result


async def run_async_operation_once(
    fixture: Mapping[str, Any],
    operation: Mapping[str, Any],
    payload: Any,
    context: AsyncHandlerContext,
    counters: Counters,
) -> Any:
    op = operation["op"]
    if op == "checkpoint":

        async def checkpoint_operation() -> Any:
            counters.add_operation()
            return operation["value"]

        if "input" in operation:
            return await context.checkpoint(
                operation["name"], checkpoint_operation, input=operation["input"]
            )
        return await context.checkpoint(operation["name"], checkpoint_operation)
    if op == "sleep":
        await context.sleep(operation["name"], operation["durationMs"])
        return None
    if op == "sleepUntil":
        await context.sleep_until(
            operation["name"], payload_time(payload, operation["wakeAtField"])
        )
        return None
    if op == "waitForSignal":
        return await context.wait_for_signal(operation["name"])
    if op == "waitForHuman":
        return await context.wait_for_human(operation["name"], operation["context"])
    if op == "runChild":
        return await context.run_child(
            operation["name"],
            fixture["childTaskType"],
            operation["payload"],
            child_options(fixture, operation, payload),
        )
    if op == "runChildren":
        joined = await context.run_children(child_requests(fixture, operation))
        with counters.lock:
            counters.returned_suspending_calls += 1
        return outcomes(joined)
    if op == "overlappingCheckpoints":
        started = asyncio.Event()
        repeated = asyncio.Event()

        async def checkpoint_operation() -> Any:
            ordinal = counters.add_operation()
            (repeated if ordinal > 1 else started).set()
            with contextlib.suppress(TimeoutError):
                await asyncio.wait_for(repeated.wait(), operation["overlapWindowMs"] / 1000)
            return {"operation": ordinal}

        first = asyncio.ensure_future(context.checkpoint(operation["name"], checkpoint_operation))
        operation_started = asyncio.ensure_future(started.wait())
        await asyncio.wait((first, operation_started), return_when="FIRST_COMPLETED")
        operation_started.cancel()
        if not started.is_set():
            first.result()
            raise AssertionError("the first checkpoint call ended before its operation started")
        second = await context.checkpoint(operation["name"], checkpoint_operation)
        return [await first, second]
    raise AssertionError(f"unknown durable-script operation {op}")
