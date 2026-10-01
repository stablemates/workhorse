from __future__ import annotations

from collections.abc import Callable
from typing import Any

import psycopg
import pytest

from workhorse import (
    AsyncHandlerContext,
    AsyncWorker,
    ChildTaskRequest,
    EnqueueOptions,
    HandlerContext,
    Queue,
    TaskContractValidationError,
    TaskContractVersion,
    TaskTypeContracts,
    Worker,
)

CHILD_OPTIONS = EnqueueOptions(queue="contract-children")
PARENT_TYPES = ("python.single-parent", "python.settled-parent", "python.all-parent")


def required_field_schema(field: str) -> dict[str, object]:
    return {
        "type": "object",
        "required": [field],
        "properties": {field: {"type": "integer"}},
    }


V1 = TaskContractVersion(payload_schema=required_field_schema("value"))


def sync_child_contract(
    database_url: str, task_type: str, current: str, versions: dict[str, TaskContractVersion]
) -> None:
    with psycopg.connect(database_url, autocommit=True) as connection:
        Queue(connection).sync_contracts({task_type: TaskTypeContracts(current, versions)})


def enqueue_parent(
    database_url: str, task_type: str, payload: object = None, **options: Any
) -> str:
    with psycopg.connect(database_url) as connection:
        task_id = Queue(connection).enqueue(
            task_type,
            payload,  # type: ignore[arg-type]
            EnqueueOptions(queue="contract-parents", **options),
        )
        connection.commit()
    return task_id


def child_rows(database_url: str, parent_id: str) -> list[tuple[object, ...]]:
    with psycopg.connect(database_url) as connection:
        return connection.execute(
            """
            SELECT task.contract_version, task.payload_max_bytes, task.payload_redact_keys
            FROM workhorse.task_child child
            JOIN workhorse.task task ON task.id = child.child_task_id
            WHERE child.parent_task_id = %s
            ORDER BY child.child_name
            """,
            (parent_id,),
        ).fetchall()


def parent_state(database_url: str, parent_id: str) -> str:
    with psycopg.connect(database_url) as connection:
        row = connection.execute(
            "SELECT state FROM workhorse.task_outcome WHERE task_id = %s", (parent_id,)
        ).fetchone()
    assert row is not None
    return str(row[0])


def setup_contracted_child(database_url: str) -> dict[str, str]:
    sync_child_contract(
        database_url,
        "python.contracted-child",
        "v1",
        {
            "v1": TaskContractVersion(
                payload_schema=required_field_schema("value"),
                max_payload_bytes=4096,
                sensitive_payload_keys=("secret",),
            )
        },
    )
    return {parent_type: enqueue_parent(database_url, parent_type) for parent_type in PARENT_TYPES}


def assert_contracted_children(database_url: str, parent_ids: dict[str, str]) -> None:
    for parent_type, parent_id in parent_ids.items():
        assert child_rows(database_url, parent_id) == [("v1", 4096, ["secret"])], parent_type
        assert parent_state(database_url, parent_id) == "succeeded", parent_type


def contracted_request(value: int) -> list[ChildTaskRequest]:
    return [ChildTaskRequest("child", "python.contracted-child", {"value": value}, CHILD_OPTIONS)]


INVALID_SET = [
    ChildTaskRequest("valid", "python.contracted-child", {"value": 1}),
    ChildTaskRequest("invalid", "python.contracted-child", {"other": 1}),
]


def assert_payload_validation_errors(errors: list[BaseException]) -> None:
    assert len(errors) == 3
    for error in errors:
        assert isinstance(error, TaskContractValidationError), repr(error)
        assert (error.task_type, error.version, error.kind) == (
            "python.contracted-child",
            "v1",
            "payload",
        )


def setup_replayed_children(database_url: str) -> dict[str, str]:
    for child_type in ("python.rejecting-child", "python.limited-child"):
        sync_child_contract(database_url, child_type, "v1", {"v1": V1})
    return {
        child_type: enqueue_parent(
            database_url, "python.replay-contract-parent", {"childType": child_type}
        )
        for child_type in ("python.rejecting-child", "python.limited-child")
    }


def advance_replayed_contracts(database_url: str) -> None:
    # v2 rejects one accepted payload and changes the other child's stamped payload limit.
    sync_child_contract(
        database_url,
        "python.rejecting-child",
        "v2",
        {"v1": V1, "v2": TaskContractVersion(payload_schema=required_field_schema("renamed"))},
    )
    sync_child_contract(
        database_url,
        "python.limited-child",
        "v2",
        {
            "v1": V1,
            "v2": TaskContractVersion(
                payload_schema=required_field_schema("value"), max_payload_bytes=2048
            ),
        },
    )


def assert_replayed_children(database_url: str, parent_ids: dict[str, str]) -> None:
    for child_type, parent_id in parent_ids.items():
        rows = child_rows(database_url, parent_id)
        assert [row[0] for row in rows] == ["v1"], child_type
        assert parent_state(database_url, parent_id) == "succeeded", child_type


def replay_request(payload: object) -> list[ChildTaskRequest]:
    child_type = payload["childType"]  # type: ignore[index]
    return [ChildTaskRequest("child", child_type, {"value": 1}, CHILD_OPTIONS)]


def drain(worker: Worker) -> None:
    assert worker.run_once() is True
    while worker.run_once():
        pass


async def drain_async(worker: AsyncWorker) -> None:
    assert await worker.run_once() is True
    while await worker.run_once():
        pass


def echo(payload: object, _context: object) -> object:
    return payload


def test_sync_child_apis_stamp_the_current_child_contract(
    database_url: str, worker_pool: Any
) -> None:
    parent_ids = setup_contracted_child(database_url)
    parent = (
        Worker(worker_pool, queue="contract-parents", worker_id="python-contract-parent")
        .handle(
            "python.single-parent",
            lambda _payload, context: context.run_child(
                "child", "python.contracted-child", {"value": 1}, CHILD_OPTIONS
            ),
        )
        .handle(
            "python.settled-parent",
            lambda _payload, context: context.run_children(contracted_request(2)),
        )
        .handle(
            "python.all-parent",
            lambda _payload, context: context.run_children_all(contracted_request(3)),
        )
    )
    child = Worker(
        worker_pool, queue="contract-children", worker_id="python-contract-child"
    ).handle("python.contracted-child", echo)

    for worker in (parent, child, parent):
        drain(worker)
    assert_contracted_children(database_url, parent_ids)


def test_sync_child_apis_reject_an_invalid_payload_before_writing(
    database_url: str, worker_pool: Any
) -> None:
    sync_child_contract(database_url, "python.contracted-child", "v1", {"v1": V1})
    parent_id = enqueue_parent(database_url, "python.invalid-contract-parent", max_attempts=1)
    errors: list[BaseException] = []

    def handle(_payload: object, context: HandlerContext) -> object:
        calls: list[Callable[[], object]] = [
            lambda: context.run_child("single", "python.contracted-child", {"other": 1}),
            lambda: context.run_children(INVALID_SET),
            lambda: context.run_children_all(INVALID_SET),
        ]
        for call in calls:
            try:
                call()
            except Exception as error:
                errors.append(error)
        raise errors[-1]

    parent = Worker(
        worker_pool, queue="contract-parents", worker_id="python-contract-parent"
    ).handle("python.invalid-contract-parent", handle)

    assert parent.run_once() is True
    assert_payload_validation_errors(errors)
    assert child_rows(database_url, parent_id) == []


def test_sync_parent_replays_contracted_children_after_the_contract_moves(
    database_url: str, worker_pool: Any
) -> None:
    parent_ids = setup_replayed_children(database_url)
    parent = Worker(
        worker_pool, queue="contract-parents", worker_id="python-contract-parent"
    ).handle(
        "python.replay-contract-parent",
        lambda payload, context: context.run_children_all(replay_request(payload)),
    )
    child = Worker(worker_pool, queue="contract-children", worker_id="python-contract-child")
    for child_type in parent_ids:
        child.handle(child_type, echo)

    drain(parent)
    advance_replayed_contracts(database_url)
    for worker in (child, parent):
        drain(worker)
    assert_replayed_children(database_url, parent_ids)


def async_worker(
    driver: str, async_psycopg_pool: Any, asyncpg_pool: Any, queue: str
) -> AsyncWorker:
    if driver == "psycopg":
        return AsyncWorker.from_psycopg(
            async_psycopg_pool, queue=queue, worker_id=f"{queue}-worker"
        )
    return AsyncWorker.from_asyncpg(asyncpg_pool, queue=queue, worker_id=f"{queue}-worker")


async def async_echo(payload: object, _context: AsyncHandlerContext) -> object:
    return payload


@pytest.mark.asyncio
@pytest.mark.parametrize("driver", ["psycopg", "asyncpg"])
async def test_async_child_apis_stamp_the_current_child_contract(
    database_url: str, driver: str, async_psycopg_pool: Any, asyncpg_pool: Any
) -> None:
    parent_ids = setup_contracted_child(database_url)

    async def single(_payload: object, context: AsyncHandlerContext) -> object:
        return await context.run_child(
            "child", "python.contracted-child", {"value": 1}, CHILD_OPTIONS
        )

    async def settled(_payload: object, context: AsyncHandlerContext) -> object:
        return await context.run_children(contracted_request(2))

    async def all_children(_payload: object, context: AsyncHandlerContext) -> object:
        return await context.run_children_all(contracted_request(3))

    parent = (
        async_worker(driver, async_psycopg_pool, asyncpg_pool, "contract-parents")
        .handle("python.single-parent", single)
        .handle("python.settled-parent", settled)
        .handle("python.all-parent", all_children)
    )
    child = async_worker(driver, async_psycopg_pool, asyncpg_pool, "contract-children").handle(
        "python.contracted-child", async_echo
    )

    for worker in (parent, child, parent):
        await drain_async(worker)
    assert_contracted_children(database_url, parent_ids)


@pytest.mark.asyncio
@pytest.mark.parametrize("driver", ["psycopg", "asyncpg"])
async def test_async_child_apis_reject_an_invalid_payload_before_writing(
    database_url: str, driver: str, async_psycopg_pool: Any, asyncpg_pool: Any
) -> None:
    sync_child_contract(database_url, "python.contracted-child", "v1", {"v1": V1})
    parent_id = enqueue_parent(database_url, "python.invalid-contract-parent", max_attempts=1)
    errors: list[BaseException] = []

    async def handle(_payload: object, context: AsyncHandlerContext) -> object:
        calls = [
            lambda: context.run_child(
                "single", "python.contracted-child", {"other": 1}, EnqueueOptions()
            ),
            lambda: context.run_children(INVALID_SET),
            lambda: context.run_children_all(INVALID_SET),
        ]
        for call in calls:
            try:
                await call()
            except Exception as error:
                errors.append(error)
        raise errors[-1]

    parent = async_worker(driver, async_psycopg_pool, asyncpg_pool, "contract-parents").handle(
        "python.invalid-contract-parent", handle
    )

    assert await parent.run_once() is True
    assert_payload_validation_errors(errors)
    assert child_rows(database_url, parent_id) == []


@pytest.mark.asyncio
@pytest.mark.parametrize("driver", ["psycopg", "asyncpg"])
async def test_async_parent_replays_contracted_children_after_the_contract_moves(
    database_url: str, driver: str, async_psycopg_pool: Any, asyncpg_pool: Any
) -> None:
    parent_ids = setup_replayed_children(database_url)

    async def handle(payload: object, context: AsyncHandlerContext) -> object:
        return await context.run_children_all(replay_request(payload))

    parent = async_worker(driver, async_psycopg_pool, asyncpg_pool, "contract-parents").handle(
        "python.replay-contract-parent", handle
    )
    child = async_worker(driver, async_psycopg_pool, asyncpg_pool, "contract-children")
    for child_type in parent_ids:
        child.handle(child_type, async_echo)

    await drain_async(parent)
    advance_replayed_contracts(database_url)
    for worker in (child, parent):
        await drain_async(worker)
    assert_replayed_children(database_url, parent_ids)
