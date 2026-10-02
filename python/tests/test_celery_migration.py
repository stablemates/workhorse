from __future__ import annotations

import json
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from threading import Barrier, Event
from typing import Any

import psycopg
import pytest
from eventual_conditions import eventually
from psycopg_pool import ConnectionPool

sys.path.insert(0, str(Path(__file__).parents[1] / "examples"))
import celery_migration as migration

from workhorse import HandlerContext, Json, Worker


@pytest.fixture
def application(database_url: str) -> str:
    with psycopg.connect(database_url, autocommit=True) as connection:
        connection.execute(migration.APPLICATION_SCHEMA)
        connection.execute("INSERT INTO celery_migration.account VALUES ('customer', 0)")
    return database_url


def payload(reference: str = "payment-001", amount: int = 1500) -> dict[str, Json]:
    return migration.credit_payload("customer", reference, amount)


def switch(database_url: str, destination: migration.Destination = "workhorse") -> None:
    with psycopg.connect(database_url) as connection, connection.transaction():
        migration.switch_producer(connection, destination)


def counts(database_url: str) -> tuple[int, int, int, int]:
    with psycopg.connect(database_url, autocommit=True) as observer:
        row = observer.execute(
            "SELECT (SELECT credit_cents FROM celery_migration.account "
            "WHERE account_id='customer'), "
            "(SELECT count(*) FROM celery_migration.operation), "
            "(SELECT count(*) FROM celery_migration.effect), "
            "(SELECT count(*) FROM workhorse.task WHERE task_type = %s)",
            (migration.TASK_TYPE,),
        ).fetchone()
        assert row is not None
        return row


def worker(database_url: str, pool: ConnectionPool[Any], handler: Any = None) -> Worker:
    return Worker(pool, queues=[migration.QUEUE], concurrency=1, retry_delay_ms=60_000).handle(
        migration.TASK_TYPE, handler or migration.workhorse_handler(database_url)
    )


def retry_now(database_url: str, task_id: str) -> None:
    with psycopg.connect(database_url, autocommit=True) as connection:
        connection.execute(
            "UPDATE workhorse.task_runtime SET run_at = now() - interval '1 second' "
            "WHERE task_id = %s",
            (task_id,),
        )
        connection.execute("SELECT workhorse.tick_v1()")


def test_operation_identity_survives_new_interpreter_and_rejects_changed_request(
    application: str,
) -> None:
    script = (
        "import sys,json;sys.path.insert(0,sys.argv[1]);"
        "from celery_migration import credit_payload;"
        "print(json.dumps(credit_payload('customer','payment-001',1500),sort_keys=True))"
    )
    restarted = subprocess.run(
        [sys.executable, "-c", script, str(Path(migration.__file__).parent)],
        check=True,
        capture_output=True,
        text=True,
    )
    assert json.loads(restarted.stdout) == payload()
    task = migration.create_local_celery_task(application)
    migration.submit(application, task, payload())
    with pytest.raises(ValueError, match="different business request"):
        migration.submit(application, task, payload(amount=2000))
    assert counts(application) == (1500, 1, 1, 0)


@pytest.mark.parametrize(
    "invalid",
    [
        None,
        [],
        {},
        {"operation_id": "x"},
        {"operation_id": "x", "account_id": "customer", "amount_cents": True},
        {"operation_id": "x", "account_id": "customer", "amount_cents": -1},
    ],
)
def test_json_shape_and_integer_amount_are_validated(invalid: object) -> None:
    with pytest.raises(ValueError):
        migration.validate_payload(invalid)


def test_real_celery_eager_json_handler_and_old_duplicates(application: str) -> None:
    task = migration.create_local_celery_task(application)
    staged = migration.submit(application, task, payload())
    assert staged == migration.StagedOperation("celery", None)
    assert task.app.conf.task_always_eager is True
    assert task.app.conf.task_serializer == "json"
    result = task.delay(payload())
    assert result.successful()
    assert result.get() == {"operation_id": payload()["operation_id"], "applied": False}
    assert result.id != payload()["operation_id"]
    assert counts(application) == (1500, 1, 1, 0)


@pytest.mark.parametrize("old_first", [True, False])
def test_old_new_duplicate_order_preserves_one_effect(
    application: str, worker_pool: ConnectionPool[Any], old_first: bool
) -> None:
    task = migration.create_local_celery_task(application)
    if old_first:
        migration.submit(application, task, payload())
    switch(application)
    staged = migration.submit(application, task, payload())
    assert staged.task_id is not None
    duplicate = migration.submit(application, task, payload())
    assert duplicate.task_id == staged.task_id
    assert worker(application, worker_pool).run_once()
    assert task.delay(payload()).get()["applied"] is False
    assert counts(application) == (1500, 1, 1, 1)


def test_concurrent_old_and_new_handlers_share_durable_effect_ledger(
    application: str, worker_pool: ConnectionPool[Any], monkeypatch: pytest.MonkeyPatch
) -> None:
    switch(application)
    task = migration.create_local_celery_task(application)
    migration.submit(application, task, payload())
    barrier = Barrier(2)
    original = migration.apply_credit

    def simultaneous(database_url: str, request: object) -> dict[str, Json]:
        barrier.wait(timeout=10)
        return original(database_url, request)

    monkeypatch.setattr(migration, "apply_credit", simultaneous)
    with ThreadPoolExecutor(max_workers=2) as executor:
        old_delivery = executor.submit(lambda: task.delay(payload()).get())
        new_delivery = executor.submit(worker(application, worker_pool).run_once)
        assert old_delivery.result(timeout=15)["operation_id"] == payload()["operation_id"]
        assert new_delivery.result(timeout=15)
    assert counts(application) == (1500, 1, 1, 1)


def test_concurrent_overlapping_producers_keep_operation_and_enqueue_identity(
    application: str,
) -> None:
    switch(application)
    barrier = Barrier(2)
    task = migration.create_local_celery_task(application)

    def producer() -> migration.StagedOperation:
        barrier.wait(timeout=10)
        return migration.submit(application, task, payload())

    with ThreadPoolExecutor(max_workers=2) as executor:
        submissions = [executor.submit(producer) for _ in range(2)]
        results = [submission.result(timeout=15) for submission in submissions]
    assert results[0].task_id == results[1].task_id
    assert counts(application) == (0, 1, 0, 1)


def test_transaction_identity_precommit_invisibility_and_joint_commit(application: str) -> None:
    switch(application)
    with psycopg.connect(application) as connection, connection.transaction():
        identity = connection.execute("SELECT pg_backend_pid(), txid_current()").fetchone()
        connection.execute("UPDATE celery_migration.account SET credit_cents=250")
        staged = migration.stage_operation(connection, payload())
        assert staged.task_id is not None
        assert connection.execute("SELECT pg_backend_pid(), txid_current()").fetchone() == identity
        assert counts(application) == (0, 0, 0, 0)
    assert counts(application) == (250, 1, 0, 1)
    assert connection.closed


def test_business_enqueue_and_route_switch_rollback_together(application: str) -> None:
    with (
        pytest.raises(RuntimeError, match="cutover failure"),
        psycopg.connect(application) as connection,
        connection.transaction(),
    ):
        migration.switch_producer(connection, "workhorse")
        connection.execute("UPDATE celery_migration.account SET credit_cents=250")
        migration.stage_operation(connection, payload())
        assert counts(application) == (0, 0, 0, 0)
        raise RuntimeError("cutover failure")
    assert counts(application) == (0, 0, 0, 0)
    assert (
        migration.submit(
            application, migration.create_local_celery_task(application), payload()
        ).destination
        == "celery"
    )
    assert counts(application) == (1500, 1, 1, 0)


def test_nested_savepoint_keeps_outer_business_write_and_connection_ownership(
    application: str,
) -> None:
    switch(application)
    with psycopg.connect(application) as connection, connection.transaction():
        connection.execute("UPDATE celery_migration.account SET credit_cents=250")
        with pytest.raises(RuntimeError), connection.transaction():
            migration.stage_operation(connection, payload())
            raise RuntimeError("nested rollback")
        assert not connection.closed
        assert connection.execute("SELECT count(*) FROM celery_migration.operation").fetchone() == (
            0,
        )
        assert counts(application) == (0, 0, 0, 0)
        migration.stage_operation(connection, payload("payment-002"))
    assert counts(application) == (250, 1, 0, 1)


def test_enqueue_failure_rolls_back_business_request(application: str) -> None:
    switch(application)
    with psycopg.connect(application, autocommit=True) as connection:
        connection.execute("""
            CREATE FUNCTION celery_migration.reject_enqueue() RETURNS trigger LANGUAGE plpgsql AS $$
            BEGIN RAISE EXCEPTION 'fixture enqueue failure' USING ERRCODE='23514'; END $$;
            CREATE TRIGGER reject_enqueue BEFORE INSERT ON workhorse.task
            FOR EACH ROW EXECUTE FUNCTION celery_migration.reject_enqueue();
        """)
    with (
        pytest.raises(psycopg.errors.CheckViolation, match="fixture enqueue failure"),
        psycopg.connect(application) as connection,
        connection.transaction(),
    ):
        connection.execute("UPDATE celery_migration.account SET credit_cents=250")
        migration.stage_operation(connection, payload())
    assert counts(application) == (0, 0, 0, 0)


def test_explicit_transaction_required_for_staging_and_switch(application: str) -> None:
    with psycopg.connect(application, autocommit=True) as connection:
        with pytest.raises(ValueError, match="transaction"):
            migration.stage_operation(connection, payload())
        with pytest.raises(ValueError, match="transaction"):
            migration.switch_producer(connection, "workhorse")
    assert counts(application) == (0, 0, 0, 0)


def test_old_postcommit_publish_failure_is_retained_and_reconciled(
    application: str, worker_pool: ConnectionPool[Any], monkeypatch: pytest.MonkeyPatch
) -> None:
    task = migration.create_local_celery_task(application)

    def unavailable(_request: object) -> None:
        raise ConnectionError("publication outcome unknown")

    monkeypatch.setattr(task, "delay", unavailable)
    with pytest.raises(ConnectionError, match="unknown"):
        migration.submit(application, task, payload())
    assert counts(application) == (0, 1, 0, 0)
    with psycopg.connect(application, autocommit=True) as connection:
        assert migration.unresolved_operations(connection) == [payload()]
    switch(application)
    migration.submit(application, task, payload())
    assert worker(application, worker_pool).run_once()
    assert counts(application) == (1500, 1, 1, 1)


def test_old_backlog_late_delivery_and_switch_rollback_are_safe(
    application: str, worker_pool: ConnectionPool[Any]
) -> None:
    task = migration.create_local_celery_task(application)
    with psycopg.connect(application) as connection, connection.transaction():
        assert migration.stage_operation(connection, payload()).destination == "celery"
    assert counts(application) == (0, 1, 0, 0)
    switch(application)
    migration.submit(application, task, payload())
    switch(application, "celery")
    migration.submit(application, task, payload())
    assert worker(application, worker_pool).run_once()
    assert task.delay(payload()).get()["applied"] is False
    migration.submit(application, task, payload("payment-002", 200))
    assert counts(application) == (1700, 2, 2, 1)


def test_switch_waits_for_inflight_producer_but_not_unknown_old_delivery(application: str) -> None:
    started = Event()
    finished = Event()

    def cutover() -> None:
        with (
            psycopg.connect(
                application, application_name="celery-migration-cutover-test"
            ) as connection,
            connection.transaction(),
        ):
            started.set()
            migration.switch_producer(connection, "workhorse")
        finished.set()

    with ThreadPoolExecutor(max_workers=1) as executor:
        with psycopg.connect(application) as connection, connection.transaction():
            migration.stage_operation(connection, payload())
            pending = executor.submit(cutover)
            assert started.wait(timeout=5)
            with psycopg.connect(application, autocommit=True) as observer:

                def switch_is_blocked() -> bool:
                    return observer.execute(
                        "SELECT EXISTS(SELECT 1 FROM pg_stat_activity "
                        "WHERE application_name='celery-migration-cutover-test' "
                        "AND wait_event_type='Lock')"
                    ).fetchone() == (True,)

                eventually(switch_is_blocked, "route switch waits on the producer's database lock")
            assert not finished.is_set()
        pending.result(timeout=10)
    assert finished.is_set()
    task = migration.create_local_celery_task(application)
    assert migration.submit(application, task, payload()).destination == "workhorse"
    assert task.delay(payload()).get()["applied"] is True
    assert counts(application) == (1500, 1, 1, 1)


def test_celery_autoretry_after_effect_commit_does_not_repeat_credit(
    application: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    original = migration.apply_credit
    attempts = 0

    def response_loss(database_url: str, request: object) -> dict[str, Json]:
        nonlocal attempts
        attempts += 1
        result = original(database_url, request)
        if attempts == 1:
            raise psycopg.OperationalError("effect committed; reply lost")
        return result

    monkeypatch.setattr(migration, "apply_credit", response_loss)
    migration.submit(application, migration.create_local_celery_task(application), payload())
    assert attempts == 2
    assert counts(application) == (1500, 1, 1, 0)


@pytest.mark.parametrize("after_effect", [False, True])
def test_workhorse_handler_retry_before_or_after_business_commit(
    application: str, worker_pool: ConnectionPool[Any], after_effect: bool
) -> None:
    switch(application)
    staged = migration.submit(
        application, migration.create_local_celery_task(application), payload()
    )
    assert staged.task_id is not None
    handler = migration.workhorse_handler(application)
    attempts = 0

    def crash(request: Any, context: HandlerContext) -> dict[str, Json]:
        nonlocal attempts
        attempts += 1
        if attempts == 1:
            if after_effect:
                handler(request, context)
            raise RuntimeError("lost handler process before Workhorse completion")
        return handler(request, context)

    running_worker = worker(application, worker_pool, crash)
    assert running_worker.run_once()
    assert counts(application) == (1500 if after_effect else 0, 1, int(after_effect), 1)
    retry_now(application, staged.task_id)
    assert running_worker.run_once()
    assert attempts == 2
    assert counts(application) == (1500, 1, 1, 1)
    with psycopg.connect(application, autocommit=True) as connection:
        assert connection.execute(
            "SELECT state FROM workhorse.task_outcome WHERE task_id=%s", (staged.task_id,)
        ).fetchone() == ("succeeded",)


def test_actual_restart_after_effect_commit_before_queue_receipt(
    application: str, worker_pool: ConnectionPool[Any]
) -> None:
    switch(application)
    staged = migration.submit(
        application, migration.create_local_celery_task(application), payload()
    )
    assert staged.task_id is not None
    script = (
        "import sys,os\n"
        "sys.path.insert(0,sys.argv[1])\n"
        "from celery_migration import apply_credit,QUEUE,TASK_TYPE\n"
        "from workhorse import Worker\n"
        "from psycopg_pool import ConnectionPool\n"
        "def crash(payload,context):\n"
        "    apply_credit(sys.argv[2],payload)\n"
        "    os._exit(73)\n"
        "with ConnectionPool(sys.argv[2],min_size=3,max_size=3,"
        "kwargs={'autocommit':True}) as pool:\n"
        "    Worker(pool,queues=[QUEUE],concurrency=1).handle(TASK_TYPE,crash).run_once()\n"
    )
    crashed = subprocess.run(
        [
            sys.executable,
            "-c",
            script,
            str(Path(migration.__file__).parent),
            application,
        ],
        check=False,
    )
    assert crashed.returncode == 73
    assert counts(application) == (1500, 1, 1, 1)
    with psycopg.connect(application, autocommit=True) as connection:
        assert connection.execute(
            "SELECT state FROM workhorse.task_runtime WHERE task_id=%s", (staged.task_id,)
        ).fetchone() == ("active",)
        connection.execute(
            "UPDATE workhorse.task_runtime SET expires_at=now()-interval '1 second' "
            "WHERE task_id=%s",
            (staged.task_id,),
        )
        connection.execute("SELECT workhorse.tick_v1()")
    retry_now(application, staged.task_id)
    assert worker(application, worker_pool).run_once()
    assert (
        migration.create_local_celery_task(application).delay(payload()).get()["applied"] is False
    )
    assert counts(application) == (1500, 1, 1, 1)


def test_effect_ledger_survives_enqueue_idempotency_window(
    application: str, worker_pool: ConnectionPool[Any]
) -> None:
    switch(application)
    task = migration.create_local_celery_task(application)
    original = migration.submit(application, task, payload())
    assert worker(application, worker_pool).run_once()
    with psycopg.connect(application, autocommit=True) as connection:
        connection.execute(
            "UPDATE workhorse.enqueue_idempotency SET expires_at=now()-interval '1 second'"
        )
    replacement = migration.submit(application, task, payload())
    assert replacement.task_id != original.task_id
    assert worker(application, worker_pool).run_once()
    assert counts(application) == (1500, 1, 1, 2)


def test_effect_transaction_rolls_back_ledger_and_credit_together(application: str) -> None:
    with psycopg.connect(application) as connection, connection.transaction():
        migration.stage_operation(connection, payload())
        connection.execute("""
            CREATE FUNCTION celery_migration.reject_effect() RETURNS trigger LANGUAGE plpgsql AS $$
            BEGIN RAISE EXCEPTION 'fixture credit failure' USING ERRCODE='23514'; END $$;
            CREATE TRIGGER reject_effect BEFORE UPDATE ON celery_migration.account
            FOR EACH ROW EXECUTE FUNCTION celery_migration.reject_effect();
        """)
    with pytest.raises(psycopg.errors.CheckViolation):
        migration.apply_credit(application, payload())
    assert counts(application) == (0, 1, 0, 0)
    with psycopg.connect(application, autocommit=True) as connection:
        connection.execute("DROP TRIGGER reject_effect ON celery_migration.account")
    assert migration.apply_credit(application, payload())["applied"] is True
    assert counts(application) == (1500, 1, 1, 0)


def test_uncommitted_or_conflicting_delivery_fails_closed(application: str) -> None:
    with pytest.raises(ValueError, match="committed business operation"):
        migration.apply_credit(application, payload())
    with psycopg.connect(application) as connection, connection.transaction():
        migration.stage_operation(connection, payload())
        with pytest.raises(ValueError, match="committed business operation"):
            migration.apply_credit(application, payload())
    with pytest.raises(ValueError, match="committed business operation"):
        migration.apply_credit(application, payload(amount=99))
    assert counts(application) == (0, 1, 0, 0)
