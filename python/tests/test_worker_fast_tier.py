from __future__ import annotations

import time
from collections import Counter
from collections.abc import Callable, Sequence
from contextlib import suppress
from threading import Event, Lock, Thread
from typing import Any
from uuid import uuid4

import asyncpg
import psycopg
import pytest
from psycopg_pool import ConnectionPool

from workhorse import (
    Admin,
    AdminAudit,
    AsyncAdmin,
    Debounce,
    EnqueueOptions,
    EnqueueRequest,
    FastTierUnsupportedError,
    HandlerContext,
    Json,
    Queue,
    QueueHistory,
    Worker,
)
from workhorse._drivers import PooledSyncExecutor
from workhorse._statements import STATEMENTS, DriverStatement

pytestmark = pytest.mark.integration


def _audit() -> AdminAudit:
    return AdminAudit(
        actor="python-fast-tier-test", reason="exercise the fast tier", request_id=str(uuid4())
    )


def _make_fast(database_url: str, queue_name: str) -> None:
    with psycopg.connect(database_url, autocommit=True) as connection:
        assert Admin(connection).set_queue_tier(queue_name, "fast", _audit()) == "fast"


def _outcomes(database_url: str, task_ids: list[str]) -> list[tuple[str, str, int]]:
    with psycopg.connect(database_url, autocommit=True) as connection:
        rows = connection.execute(
            "SELECT task_id::text, state, attempt FROM workhorse.fast_task_outcome "
            "WHERE task_id = ANY(%s::uuid[])",
            (task_ids,),
        ).fetchall()
    return [(str(row[0]), str(row[1]), int(row[2])) for row in rows]


def _run_until(worker: Worker, done: Callable[[], bool], timeout: float = 20.0) -> None:
    thread = Thread(target=worker.run)
    thread.start()
    try:
        deadline = time.monotonic() + timeout
        while not done():
            assert time.monotonic() < deadline, "worker did not finish in time"
            time.sleep(0.02)
    finally:
        worker.stop()
        thread.join(timeout=10)
    assert not thread.is_alive()


def test_fast_queue_rejects_full_tier_enqueue_features(database_url: str) -> None:
    _make_fast(database_url, "fast-enqueue")
    with psycopg.connect(database_url, autocommit=True) as connection:
        queue = Queue(connection)
        with pytest.raises(FastTierUnsupportedError) as keyed:
            queue.enqueue("keyed", {}, EnqueueOptions(queue="fast-enqueue", concurrency_key="a"))
        assert (keyed.value.queue, keyed.value.feature) == ("fast-enqueue", "concurrency keys")

        with pytest.raises(FastTierUnsupportedError) as debounced:
            queue.enqueue_many(
                [
                    EnqueueRequest("plain", {}, EnqueueOptions(queue="fast-enqueue")),
                    EnqueueRequest(
                        "debounced",
                        {},
                        EnqueueOptions(
                            queue="fast-enqueue",
                            debounce=Debounce(key="k", window_ms=1_000, schedule="reset"),
                        ),
                    ),
                ]
            )
        assert (debounced.value.feature, debounced.value.ordinal) == ("debounce", 2)

        task_id = queue.enqueue("plain", {"n": 1}, EnqueueOptions(queue="fast-enqueue"))
        snapshot = Admin(connection).get_task(task_id)
        assert snapshot is not None and snapshot.state == "ready"


def test_tier_change_requires_an_empty_queue_and_history_is_opt_in(database_url: str) -> None:
    with psycopg.connect(database_url, autocommit=True) as connection:
        queue = Queue(connection)
        admin = Admin(connection)
        queue.enqueue("live", {}, EnqueueOptions(queue="tier-change"))
        with pytest.raises(FastTierUnsupportedError) as refused:
            admin.set_queue_tier("tier-change", "fast", _audit())
        assert refused.value.feature == "tier change"
        with pytest.raises(ValueError, match="tier must be"):
            admin.set_queue_tier("tier-change", "medium", _audit())  # type: ignore[arg-type]

        admin.purge_queue("tier-change", _audit())
        assert admin.set_queue_tier("tier-change", "fast", _audit()) == "fast"
        assert admin.set_queue_history("tier-change", record_attempts=True) == QueueHistory(
            record_attempts=True, record_claims=False
        )
        assert admin.set_queue_tier("tier-change", "full", _audit()) == "full"


def test_worker_runs_fast_tasks_within_its_concurrency(
    database_url: str, worker_pool: ConnectionPool
) -> None:
    _make_fast(database_url, "fast-run")
    with psycopg.connect(database_url, autocommit=True) as connection:
        task_ids = Queue(connection).enqueue_many(
            [
                EnqueueRequest("square", {"n": n}, EnqueueOptions(queue="fast-run"))
                for n in range(40)
            ]
        )
    lock = Lock()
    running = 0
    peak = 0

    def square(payload: dict[str, int], _context: HandlerContext) -> Json:
        nonlocal running, peak
        with lock:
            running += 1
            peak = max(peak, running)
        time.sleep(0.001 * (payload["n"] % 3))
        with lock:
            running -= 1
        return {"square": payload["n"] ** 2}

    worker = Worker(
        worker_pool, worker_id="python-fast-runner", queue="fast-run", concurrency=4, poll_ms=5
    ).handle("square", square)
    _run_until(worker, lambda: len(_outcomes(database_url, task_ids)) == len(task_ids))

    assert peak <= 4
    outcomes = _outcomes(database_url, task_ids)
    assert all(state == "succeeded" and attempt == 1 for _, state, attempt in outcomes)
    with psycopg.connect(database_url, autocommit=True) as connection:
        snapshot = Admin(connection).get_task(task_ids[7])
        remaining = connection.execute(
            "SELECT count(*) FROM workhorse.fast_task_runtime WHERE queue_name = 'fast-run'"
        ).fetchone()
    assert snapshot is not None and snapshot.result == {"square": 49}
    assert remaining == (0,)


@pytest.mark.parametrize(
    ("feature", "operation"),
    [
        ("checkpoints", lambda context: context.checkpoint("step", lambda: 1)),
        ("progress", lambda context: context.set_progress({"done": 1})),
        ("durable waits", lambda context: context.sleep("pause", 10)),
        ("signal waits", lambda context: context.wait_for_signal("go", timeout_ms=1_000)),
        ("child tasks", lambda context: context.run_child("child", "leaf", {})),
    ],
)
def test_fast_task_context_rejects_durable_features(
    database_url: str,
    worker_pool: ConnectionPool,
    feature: str,
    operation: Callable[[HandlerContext], object],
) -> None:
    _make_fast(database_url, "fast-guard")
    with psycopg.connect(database_url, autocommit=True) as connection:
        task_id = Queue(connection).enqueue(
            "guarded", {}, EnqueueOptions(queue="fast-guard", max_attempts=1)
        )
    rejections: list[BaseException] = []

    def guarded(_payload: object, context: HandlerContext) -> Json:
        try:
            operation(context)
        except FastTierUnsupportedError as error:
            rejections.append(error)
            raise
        raise AssertionError("the fast-tier context should reject the operation")

    worker = Worker(worker_pool, worker_id="python-fast-guard", queue="fast-guard").handle(
        "guarded", guarded
    )
    assert worker.run_once() is True

    assert len(rejections) == 1
    rejection = rejections[0]
    assert isinstance(rejection, FastTierUnsupportedError)
    assert (rejection.queue, rejection.feature) == ("fast-guard", feature)
    with psycopg.connect(database_url, autocommit=True) as connection:
        snapshot = Admin(connection).get_task(task_id)
    assert snapshot is not None and snapshot.state == "failed"


def test_worker_claims_a_full_tier_queue_after_the_probe_is_rejected(
    database_url: str, worker_pool: ConnectionPool
) -> None:
    worker = Worker(worker_pool, worker_id="python-prober", queue="full-queue").handle(
        "full-work", lambda _payload, _context: {"ok": True}
    )
    task_ids: list[str] = []
    for _ in range(2):
        with psycopg.connect(database_url, autocommit=True) as connection:
            task_ids.append(
                Queue(connection).enqueue("full-work", {}, EnqueueOptions(queue="full-queue"))
            )
        assert worker.run_once() is True
        # The rejected probe holds the queue on claim_many until the next probe interval.
        assert "full-queue" in worker._full_tier_until
    with psycopg.connect(database_url, autocommit=True) as connection:
        admin = Admin(connection)
        states = [admin.get_task(task_id) for task_id in task_ids]
    assert [snapshot.state if snapshot else None for snapshot in states] == [
        "succeeded",
        "succeeded",
    ]


def test_expired_fast_claim_reruns_once_and_rejects_the_stale_completion(
    database_url: str,
    worker_pool: ConnectionPool,
) -> None:
    _make_fast(database_url, "fast-crash")
    with psycopg.connect(database_url, autocommit=True) as connection:
        task_ids = Queue(connection).enqueue_many(
            [
                EnqueueRequest("effect", {"n": n}, EnqueueOptions(queue="fast-crash"))
                for n in range(12)
            ]
        )
        # A worker that crashed after claiming leaves three leases to expire.
        crashed = connection.execute(
            "SELECT task_id::text, fence_token FROM workhorse.complete_many_and_claim_v1("
            "'crashed', '{}', '{}', '{}', 'fast-crash', 3, 100) WHERE task_id IS NOT NULL"
        ).fetchall()
        assert len(crashed) == 3
        time.sleep(0.2)
        connection.execute("SELECT * FROM workhorse.recover_expired_telemetry_v1(100, 0)")

    effects: Counter[str] = Counter()
    lock = Lock()

    def effect(_payload: object, context: HandlerContext) -> Json:
        with lock:
            effects[context.task.id] += 1
        return {"ok": True}

    worker = Worker(
        worker_pool, worker_id="python-survivor", queue="fast-crash", concurrency=3, poll_ms=5
    ).handle("effect", effect)
    _run_until(worker, lambda: len(_outcomes(database_url, task_ids)) == len(task_ids))

    outcomes = _outcomes(database_url, task_ids)
    assert sorted(task_id for task_id, _, _ in outcomes) == sorted(task_ids)
    assert all(state == "succeeded" for _, state, _ in outcomes)
    assert all(effects[task_id] == 1 for task_id in task_ids)
    with psycopg.connect(database_url, autocommit=True) as connection:
        stale = connection.execute(
            "SELECT accepted FROM workhorse.complete_many_and_claim_v1("
            "'crashed', %s::uuid[], %s::bigint[], ARRAY['{}'::jsonb], 'fast-crash', 0, 30000)",
            ([crashed[0][0]], [crashed[0][1]]),
        ).fetchone()
        recorded = connection.execute(
            "SELECT count(*) FROM workhorse.fast_task_outcome WHERE task_id = %s::uuid",
            (crashed[0][0],),
        ).fetchone()
    assert stale is not None and stale[0] == []
    assert recorded == (1,)


class _CrashAfterCompletions:
    """Run statements until some completions are written, then fail every statement.

    From the crash on, nothing the worker sends reaches PostgreSQL. That models the process
    vanishing with its handlers done and their outcomes unwritten.
    """

    dialect = "psycopg"

    def __init__(self, pool: ConnectionPool, completions: int) -> None:
        self._inner = PooledSyncExecutor(pool)
        self._lock = Lock()
        self._remaining = completions
        self.crashed = Event()

    def rows(self, statement: DriverStatement, parameters: Sequence[object] = ()) -> list[Any]:
        with self._lock:
            if statement is STATEMENTS.complete_many_and_claim and parameters[1]:
                task_ids = parameters[1]
                assert isinstance(task_ids, list)
                self._remaining -= len(task_ids)
                if self._remaining < 0:
                    self.crashed.set()
            if self.crashed.is_set():
                raise psycopg.OperationalError("the worker process vanished")
        return self._inner.rows(statement, parameters)


# Concurrency 4 has one cohort and 16 has two, so the crash drops every cohort's batch at once.
@pytest.mark.parametrize("concurrency", [4, 16])
def test_crash_mid_batch_loses_no_task_and_records_one_outcome_each(
    database_url: str, concurrency: int
) -> None:
    queue_name = f"fast-batch-crash-{concurrency}"
    _make_fast(database_url, queue_name)
    total = concurrency * 15
    with psycopg.connect(database_url, autocommit=True) as connection:
        task_ids = Queue(connection).enqueue_many(
            [
                EnqueueRequest("effect", {"n": n}, EnqueueOptions(queue=queue_name, max_attempts=3))
                for n in range(total)
            ]
        )

    effects: Counter[str] = Counter()
    lock = Lock()

    def effect(_payload: object, context: HandlerContext) -> Json:
        with lock:
            effects[context.task.id] += 1
        return {"ok": True}

    # Six connections leave four for cohorts, so concurrency 16 keeps its default of two.
    with ConnectionPool(
        database_url, min_size=1, max_size=6, kwargs={"autocommit": True}, open=True
    ) as pool:
        executor = _CrashAfterCompletions(pool, total // 3)
        crashing = Worker(
            pool,
            worker_id=f"python-crashing-{concurrency}",
            queue=queue_name,
            concurrency=concurrency,
            lease_ms=500,
            heartbeat_ms=100,
            poll_ms=5,
            _executor=executor,
        ).handle("effect", effect)
        assert crashing.cohorts == (1 if concurrency < 8 else 2)
        thread = Thread(target=lambda: _run_and_ignore(crashing))
        thread.start()
        assert executor.crashed.wait(timeout=20), "the worker never reached the crash"
        crashing.stop()
        thread.join(timeout=10)
        assert not thread.is_alive()

        time.sleep(0.6)
        with psycopg.connect(database_url, autocommit=True) as connection:
            connection.execute("SELECT * FROM workhorse.recover_expired_telemetry_v1(100, 0)")
        survivor = Worker(
            pool,
            worker_id=f"python-survivor-{concurrency}",
            queue=queue_name,
            concurrency=concurrency,
            poll_ms=5,
        ).handle("effect", effect)
        _run_until(survivor, lambda: len(_outcomes(database_url, task_ids)) == total)

    outcomes = _outcomes(database_url, task_ids)
    assert len({task_id for task_id, _, _ in outcomes}) == total
    assert len(outcomes) == total
    assert all(state == "succeeded" for _, state, _ in outcomes)
    assert all(effects[task_id] >= 1 for task_id in task_ids)
    rerun = [task_id for task_id in task_ids if effects[task_id] > 1]
    assert 0 < len(rerun) <= concurrency
    assert max(effects.values()) == 2


def _run_and_ignore(worker: Worker) -> None:
    # The crash surfaces as a statement error. The test checks what reached the database.
    with suppress(Exception):
        worker.run()


@pytest.mark.asyncio
async def test_async_admin_sets_the_tier_and_history_over_asyncpg(database_url: str) -> None:
    connection = await asyncpg.connect(database_url)
    try:
        admin = AsyncAdmin.from_asyncpg(connection)
        assert await admin.set_queue_tier("async-tier", "fast", _audit()) == "fast"
        assert await admin.set_queue_history("async-tier", record_claims=True) == QueueHistory(
            record_attempts=False, record_claims=True
        )
    finally:
        await connection.close()
