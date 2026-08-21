from __future__ import annotations

import psycopg
import pytest

from workhorse import (
    ChildConflictError,
    ChildJobRequest,
    ChildLeaseLostError,
    ChildLimitExceededError,
    ChildResultLimitExceededError,
    EnqueueOptions,
    HandlerContext,
    Queue,
    StaleLeaseError,
    Worker,
)


def test_child_job_suspends_the_parent_and_replays_its_retained_result(
    database_url: str,
) -> None:
    activations = 0

    with (
        psycopg.connect(database_url) as enqueue_connection,
        psycopg.connect(database_url, autocommit=True) as parent_connection,
        psycopg.connect(database_url, autocommit=True) as child_connection,
    ):
        parent_id = Queue(enqueue_connection).enqueue(
            "checkout",
            {"orderId": "order-2"},
            EnqueueOptions(queue="child-parents"),
        )
        enqueue_connection.commit()

        def handle_parent(_payload: object, context: HandlerContext) -> dict[str, object]:
            nonlocal activations
            activations += 1
            charge = context.run_child(
                "charge",
                "charge-card",
                {"amount": 42},
                EnqueueOptions(queue="child-workers"),
            )
            return {"receiptId": charge["receiptId"]}  # type: ignore[index]

        parent_worker = Worker(
            parent_connection,
            queue="child-parents",
            worker_id="python-child-parent-worker",
        ).handle("checkout", handle_parent)
        child_worker = Worker(
            child_connection,
            queue="child-workers",
            worker_id="python-child-worker",
        ).handle("charge-card", lambda _payload, _context: {"receiptId": "receipt-1"})

        assert parent_worker.run_once() is True
        assert parent_connection.execute(
            "SELECT state, worker_id FROM workhorse.job_runtime WHERE job_id = %s",
            (parent_id,),
        ).fetchone() == ("blocked", None)

        assert child_worker.run_once() is True
        assert parent_worker.run_once() is True
        assert activations == 2
        assert parent_connection.execute(
            "SELECT state, result FROM workhorse.job_outcome WHERE job_id = %s",
            (parent_id,),
        ).fetchone() == ("succeeded", {"receiptId": "receipt-1"})


def test_child_fan_out_joins_results_by_stable_name(database_url: str) -> None:
    activations = 0

    with (
        psycopg.connect(database_url) as enqueue_connection,
        psycopg.connect(database_url, autocommit=True) as parent_connection,
        psycopg.connect(database_url, autocommit=True) as child_connection,
    ):
        parent_id = Queue(enqueue_connection).enqueue(
            "fan-out-parent",
            None,
            EnqueueOptions(queue="fan-out-parents"),
        )
        enqueue_connection.commit()

        def handle_parent(_payload: object, context: HandlerContext) -> dict[str, object]:
            nonlocal activations
            activations += 1
            return context.run_children(
                (
                    ChildJobRequest(
                        "first",
                        "fan-out-child",
                        {"value": 1},
                        EnqueueOptions(queue="fan-out-children"),
                    ),
                    ChildJobRequest(
                        "second",
                        "fan-out-child",
                        {"value": 2},
                        EnqueueOptions(queue="fan-out-children"),
                    ),
                )
            )

        parent_worker = Worker(
            parent_connection,
            queue="fan-out-parents",
            worker_id="python-fan-out-parent-worker",
        ).handle("fan-out-parent", handle_parent)
        child_worker = Worker(
            child_connection,
            queue="fan-out-children",
            worker_id="python-fan-out-child-worker",
        ).handle(
            "fan-out-child",
            lambda payload, _context: {"value": payload["value"] * 10},  # type: ignore[index]
        )

        assert parent_worker.run_once() is True
        assert child_worker.run_once() is True
        assert parent_worker.run_once() is True
        assert activations == 2
        assert parent_connection.execute(
            "SELECT state, result FROM workhorse.job_outcome WHERE job_id = %s",
            (parent_id,),
        ).fetchone() == (
            "succeeded",
            {"first": {"value": 10}, "second": {"value": 20}},
        )


def test_empty_child_fan_out_completes_without_replay(database_url: str) -> None:
    activations = 0

    with (
        psycopg.connect(database_url) as enqueue_connection,
        psycopg.connect(database_url, autocommit=True) as worker_connection,
    ):
        parent_id = Queue(enqueue_connection).enqueue("empty-fan-out", None)
        enqueue_connection.commit()

        def handle(_payload: object, context: HandlerContext) -> dict[str, object]:
            nonlocal activations
            activations += 1
            return context.run_children(())

        assert Worker(worker_connection).handle("empty-fan-out", handle).run_once() is True
        assert activations == 1
        assert worker_connection.execute(
            "SELECT state, result FROM workhorse.job_outcome WHERE job_id = %s",
            (parent_id,),
        ).fetchone() == ("succeeded", {})


def test_changed_child_request_replays_as_a_typed_conflict(database_url: str) -> None:
    version = 1
    conflicts: list[ChildConflictError] = []

    with (
        psycopg.connect(database_url) as enqueue_connection,
        psycopg.connect(database_url, autocommit=True) as parent_connection,
        psycopg.connect(database_url, autocommit=True) as child_connection,
    ):
        parent_id = Queue(enqueue_connection).enqueue(
            "conflicting-parent",
            None,
            EnqueueOptions(queue="conflicting-parents"),
        )
        enqueue_connection.commit()

        def handle(_payload: object, context: HandlerContext) -> dict[str, bool]:
            try:
                context.run_child(
                    "child",
                    "conflicting-child",
                    {"version": version},
                    EnqueueOptions(queue="conflicting-children"),
                )
            except ChildConflictError as error:
                conflicts.append(error)
            return {"conflict": bool(conflicts)}

        parent_worker = Worker(
            parent_connection,
            queue="conflicting-parents",
            worker_id="python-conflicting-parent-worker",
        ).handle("conflicting-parent", handle)
        child_worker = Worker(
            child_connection,
            queue="conflicting-children",
            worker_id="python-conflicting-child-worker",
        ).handle("conflicting-child", lambda _payload, _context: None)

        assert parent_worker.run_once() is True
        assert child_worker.run_once() is True
        version = 2
        assert parent_worker.run_once() is True
        assert len(conflicts) == 1
        assert conflicts[0].parent_job_id == parent_id


def test_child_calls_surface_stale_fences_and_local_limits_as_typed_errors(
    database_url: str,
) -> None:
    stale_errors: list[ChildLeaseLostError] = []
    limit_errors: list[ChildLimitExceededError] = []
    result_limit_errors: list[ChildResultLimitExceededError] = []

    with (
        psycopg.connect(database_url) as enqueue_connection,
        psycopg.connect(database_url, autocommit=True) as worker_connection,
        psycopg.connect(database_url, autocommit=True) as competing_connection,
    ):
        parent_id = Queue(enqueue_connection).enqueue("typed-child-errors", None)
        enqueue_connection.commit()

        def handle(_payload: object, context: HandlerContext) -> None:
            competing_connection.execute(
                "UPDATE workhorse.job SET result_max_bytes = 1 WHERE id = %s",
                (parent_id,),
            )
            try:
                context.run_children(())
            except ChildResultLimitExceededError as error:
                result_limit_errors.append(error)
            competing_connection.execute(
                "UPDATE workhorse.job SET result_max_bytes = 1048576 WHERE id = %s",
                (parent_id,),
            )
            try:
                context.run_children(
                    tuple(
                        ChildJobRequest(f"child-{index}", "limited-child", None)
                        for index in range(101)
                    )
                )
            except ChildLimitExceededError as error:
                limit_errors.append(error)
            assert competing_connection.execute(
                "SELECT workhorse.complete_v1(%s, %s, %s, %s)",
                (parent_id, "python-typed-child-worker", context.job.fence_token, "null"),
            ).fetchone() == (True,)
            try:
                context.run_child("too-late", "stale-child", None)
            except ChildLeaseLostError as error:
                stale_errors.append(error)

        worker = Worker(worker_connection, worker_id="python-typed-child-worker").handle(
            "typed-child-errors", handle
        )
        with pytest.raises(StaleLeaseError):
            worker.run_once()
        assert len(limit_errors) == 1
        assert limit_errors[0].parent_job_id == parent_id
        assert len(result_limit_errors) == 1
        assert result_limit_errors[0].parent_job_id == parent_id
        assert result_limit_errors[0].result_bytes == 2
        assert result_limit_errors[0].result_limit_bytes == 1
        assert len(stale_errors) == 1
        assert stale_errors[0].parent_job_id == parent_id
