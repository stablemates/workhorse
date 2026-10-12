"""A checkpoint with an input compares its fingerprint on replay (ADR 0098)."""

from __future__ import annotations

import asyncio
from threading import Event, Thread
from time import sleep
from typing import Any

import psycopg
import psycopg_pool
import pytest
from eventual_conditions import eventually
from psycopg_pool import ConnectionPool

from workhorse import (
    Admin,
    AsyncHandlerContext,
    AsyncWorker,
    CheckpointConflictError,
    CheckpointInputConflictError,
    EnqueueOptions,
    HandlerContext,
    Queue,
    Worker,
    checkpoint_input_fingerprint,
)

pytestmark = pytest.mark.integration


def _enqueue(connection: psycopg.Connection[Any], type: str, max_attempts: int = 3) -> str:
    task_id = Queue(connection).enqueue(
        type,
        {},
        EnqueueOptions(max_attempts=max_attempts, retry_policy={"type": "fixed", "delayMs": 1}),
    )
    connection.commit()
    return task_id


def _retry_due(connection: psycopg.Connection[Any], task_id: str) -> None:
    eventually(
        lambda: (
            connection.execute(
                "SELECT state = 'scheduled' AND run_at <= clock_timestamp() "
                "FROM workhorse.task_runtime WHERE task_id = %s",
                (task_id,),
            ).fetchone()
            == (True,)
        ),
        "the retry never came due",
    )


def _run_two_attempts(
    pool: ConnectionPool,
    connection: psycopg.Connection[Any],
    task_id: str,
    type: str,
    handler: Any,
) -> tuple[Any, ...]:
    assert _worker(pool, type, handler).run_once() is True
    _retry_due(connection, task_id)
    # The first tick of the next worker promotes the due retry, and its claim replays.
    assert _worker(pool, type, handler).run_once() is True
    row = connection.execute(
        "SELECT state, current_attempt, error, result FROM workhorse.task_outcome "
        "WHERE task_id = %s",
        (task_id,),
    ).fetchone()
    assert row is not None
    return tuple(row)


def _worker(pool: ConnectionPool, type: str, handler: Any) -> Worker:
    # A worker ticks on its first sweep and, with this interval, never again, so the retry of the
    # first attempt comes due only for the second run_once.
    return Worker(
        pool, worker_id="python-checkpoint-input", maintenance_interval_ms=3_600_000
    ).handle(type, handler)


def test_a_replay_with_a_different_input_fails_the_task_at_once(
    database_url: str, worker_pool: ConnectionPool
) -> None:
    runs = 0
    with (
        psycopg.connect(database_url) as enqueue_connection,
        psycopg.connect(database_url, autocommit=True) as connection,
    ):
        task_id = _enqueue(enqueue_connection, "checkpoint.input.mismatch")

        def handle(_payload: object, context: HandlerContext) -> dict[str, bool]:
            nonlocal runs
            amount = 1000 if context.task.attempt == 1 else 900

            def charge() -> dict[str, int]:
                nonlocal runs
                runs += 1
                return {"charged": amount}

            context.checkpoint("charge-card", charge, input={"amountCents": amount})
            if context.task.attempt == 1:
                raise RuntimeError("network")
            return {"charged": True}

        state, attempt, error, result = _run_two_attempts(
            worker_pool, connection, task_id, "checkpoint.input.mismatch", handle
        )
        assert (state, attempt, result) == ("failed", 2, None)
        assert error["name"] == "CheckpointInputConflictError"
        assert runs == 1
        stored = Admin(connection).get_checkpoint(task_id, "charge-card")
        assert stored is not None
        assert stored.input_fingerprint == checkpoint_input_fingerprint({"amountCents": 1000})


def test_a_matching_input_or_a_missing_fingerprint_replays_the_stored_value(
    database_url: str,
    worker_pool: ConnectionPool,
) -> None:
    runs = 0
    with (
        psycopg.connect(database_url) as enqueue_connection,
        psycopg.connect(database_url, autocommit=True) as connection,
    ):
        task_id = _enqueue(enqueue_connection, "checkpoint.input.match")

        def handle(_payload: object, context: HandlerContext) -> dict[str, object]:
            first = context.task.attempt == 1

            def operation() -> int:
                nonlocal runs
                runs += 1
                return runs

            # The same input on both attempts.
            matched = context.checkpoint("matched", operation, input={"amountCents": 1000})
            # Stored without an input, replayed with one.
            added = context.checkpoint(
                "added", operation, **({} if first else {"input": {"amountCents": 900}})
            )
            # Stored with an input, replayed without one.
            removed = context.checkpoint("removed", operation, **({"input": None} if first else {}))
            if first:
                raise RuntimeError("retry after the durable boundary")
            return {"matched": matched, "added": added, "removed": removed}

        state, attempt, _error, result = _run_two_attempts(
            worker_pool, connection, task_id, "checkpoint.input.match", handle
        )
        assert (state, attempt, result) == (
            "succeeded",
            2,
            {"matched": 1, "added": 2, "removed": 3},
        )
        assert runs == 3
        stored = {
            checkpoint.name: checkpoint.input_fingerprint
            for checkpoint in Admin(connection).list_checkpoints(task_id)
        }
        assert stored == {
            "matched": checkpoint_input_fingerprint({"amountCents": 1000}),
            "added": None,
            "removed": checkpoint_input_fingerprint(None),
        }


def test_an_overlapping_call_with_a_different_input_conflicts(
    database_url: str, worker_pool: ConnectionPool
) -> None:
    started = Event()
    release = Event()
    conflicts: list[BaseException] = []
    with (
        psycopg.connect(database_url) as enqueue_connection,
        psycopg.connect(database_url, autocommit=True) as connection,
    ):
        task_id = _enqueue(enqueue_connection, "checkpoint.input.overlap", max_attempts=1)

        def handle(_payload: object, context: HandlerContext) -> object:
            def operation() -> int:
                started.set()
                assert release.wait(timeout=5)
                return 1

            values: list[object] = []
            first = Thread(
                target=lambda: values.append(
                    context.checkpoint("shared", operation, input={"amountCents": 1000})
                )
            )
            first.start()
            assert started.wait(timeout=5)
            try:
                context.checkpoint("shared", operation, input={"amountCents": 900})
            except CheckpointInputConflictError as error:
                conflicts.append(error)
            # An overlapping call with the same input, or with no input, shares the result.
            same = Thread(
                target=lambda: values.append(
                    context.checkpoint("shared", operation, input={"amountCents": 1000})
                )
            )
            plain = Thread(target=lambda: values.append(context.checkpoint("shared", operation)))
            same.start()
            plain.start()
            sleep(0.02)
            release.set()
            for thread in (first, same, plain):
                thread.join(timeout=5)
            return values

        assert _worker(worker_pool, "checkpoint.input.overlap", handle).run_once() is True
        assert connection.execute(
            "SELECT state, result FROM workhorse.task_outcome WHERE task_id = %s", (task_id,)
        ).fetchone() == ("succeeded", [1, 1, 1])
        assert len(conflicts) == 1
        conflict = conflicts[0]
        assert isinstance(conflict, CheckpointInputConflictError)
        assert isinstance(conflict, CheckpointConflictError)
        assert conflict.task_id == task_id
        assert conflict.checkpoint_name == "shared"
        assert conflict.stored_fingerprint == checkpoint_input_fingerprint({"amountCents": 1000})
        assert conflict.requested_fingerprint == checkpoint_input_fingerprint({"amountCents": 900})


def test_a_save_that_finds_a_different_input_raises_the_input_conflict(
    database_url: str, worker_pool: ConnectionPool
) -> None:
    conflicts: list[CheckpointInputConflictError] = []
    stored = checkpoint_input_fingerprint({"amountCents": 1000})
    with (
        psycopg.connect(database_url) as enqueue_connection,
        psycopg.connect(database_url, autocommit=True) as connection,
        psycopg.connect(database_url, autocommit=True) as competing,
    ):
        task_id = _enqueue(enqueue_connection, "checkpoint.input.save", max_attempts=1)

        def handle(_payload: object, context: HandlerContext) -> dict[str, bool]:
            # The read caches the empty checkpoint list before the competing save.
            assert context.get_checkpoint("charge-card") is None
            saved = competing.execute(
                "SELECT status FROM workhorse.save_checkpoint_v2(%s, %s, %s, %s, %s, %s)",
                (
                    task_id,
                    "python-checkpoint-input",
                    context.task.fence_token,
                    "charge-card",
                    '{"charged":1000}',
                    stored,
                ),
            ).fetchone()
            assert saved == ("saved",)
            try:
                context.checkpoint(
                    "charge-card", lambda: {"charged": 900}, input={"amountCents": 900}
                )
            except CheckpointInputConflictError as error:
                conflicts.append(error)
            return {"conflict": True}

        assert _worker(worker_pool, "checkpoint.input.save", handle).run_once() is True
        assert len(conflicts) == 1
        assert conflicts[0].stored_fingerprint == stored
        assert conflicts[0].requested_fingerprint == checkpoint_input_fingerprint(
            {"amountCents": 900}
        )
        checkpoint = Admin(connection).get_checkpoint(task_id, "charge-card")
        assert checkpoint is not None
        assert checkpoint.value == {"charged": 1000}


def test_an_input_that_is_not_json_fails_before_the_operation(
    database_url: str, worker_pool: ConnectionPool
) -> None:
    runs = 0
    errors: list[BaseException] = []
    with psycopg.connect(database_url) as enqueue_connection:
        _enqueue(enqueue_connection, "checkpoint.input.invalid", max_attempts=1)

        def handle(_payload: object, context: HandlerContext) -> None:
            def operation() -> int:
                nonlocal runs
                runs += 1
                return runs

            try:
                context.checkpoint("charge-card", operation, input={"amount": float("nan")})
            except ValueError as error:
                errors.append(error)

        assert _worker(worker_pool, "checkpoint.input.invalid", handle).run_once() is True
        assert runs == 0
        assert len(errors) == 1


@pytest.mark.asyncio
async def test_an_async_replay_with_a_different_input_fails_the_task_at_once(
    database_url: str,
) -> None:
    runs = 0
    with psycopg.connect(database_url) as enqueue_connection:
        task_id = _enqueue(enqueue_connection, "checkpoint.input.async")
    pool = psycopg_pool.AsyncConnectionPool(
        database_url, min_size=1, max_size=4, kwargs={"autocommit": True}, open=False
    )
    await pool.open(wait=True)
    try:

        async def handle(_payload: Any, context: AsyncHandlerContext) -> dict[str, bool]:
            amount = 1000 if context.task.attempt == 1 else 900

            async def charge() -> dict[str, int]:
                nonlocal runs
                runs += 1
                await asyncio.sleep(0)
                return {"charged": amount}

            await context.checkpoint("charge-card", charge, input={"amountCents": amount})
            if context.task.attempt == 1:
                raise RuntimeError("network")
            return {"charged": True}

        def worker() -> AsyncWorker:
            return AsyncWorker.from_psycopg(
                pool, worker_id="python-async-checkpoint-input", maintenance_interval_ms=3_600_000
            ).handle("checkpoint.input.async", handle)

        def retry_due() -> None:
            with psycopg.connect(database_url, autocommit=True) as connection:
                _retry_due(connection, task_id)

        def outcome() -> tuple[Any, ...] | None:
            with psycopg.connect(database_url, autocommit=True) as connection:
                return connection.execute(
                    "SELECT state, current_attempt, error FROM workhorse.task_outcome "
                    "WHERE task_id = %s",
                    (task_id,),
                ).fetchone()

        assert await worker().run_once() is True
        await asyncio.to_thread(retry_due)
        assert await worker().run_once() is True
        row = await asyncio.to_thread(outcome)
        assert row is not None
        state, attempt, error = row
        assert (state, attempt, error["name"]) == ("failed", 2, "CheckpointInputConflictError")
        assert runs == 1
    finally:
        await pool.close()
