"""Run the Python snippets of the landing page against PostgreSQL.

Each module in ``landing_snippets`` is one Python snippet of the landing page, byte for byte.
``site/scripts/check-language-examples.ts`` fails when a module and its snippet in
``site/lib/landing-snippets.ts`` differ. These tests call each snippet on a scratch database, so a
snippet that sends a value PostgreSQL refuses fails here.

The ``hero``, ``schedules``, and ``deploy`` snippets run a worker until the process gets a signal.
A test gives such a snippet a worker that it can stop, and stops it after the result appears.
"""

from __future__ import annotations

import importlib.util
import time
from collections.abc import Callable, Iterator
from datetime import UTC, datetime, timedelta
from pathlib import Path
from threading import Thread
from types import ModuleType
from typing import Any

import psycopg
import pytest
from psycopg_pool import ConnectionPool

import workhorse
from workhorse import Admin, EnqueueOptions, HandlerContext, Json, Queue, TaskSnapshot, Worker

LANDING = Path(__file__).parent / "landing_snippets"
WAIT_SECONDS = 20.0


def load(name: str) -> ModuleType:
    spec = importlib.util.spec_from_file_location(f"landing_{name}", LANDING / f"{name}.py")
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.fixture
def connection(database_url: str) -> Iterator[psycopg.Connection[Any]]:
    with psycopg.connect(database_url, autocommit=True) as connection:
        yield connection


@pytest.fixture
def queue(connection: psycopg.Connection[Any]) -> Queue:
    return Queue(connection)


@pytest.fixture
def admin(connection: psycopg.Connection[Any]) -> Admin:
    return Admin(connection)


def polling_worker(pool: ConnectionPool, *queues: str) -> Worker:
    return Worker(pool, queues=queues or ("default",), concurrency=3, poll_ms=20)


def task(admin: Admin, task_id: str) -> TaskSnapshot:
    snapshot = admin.get_task(task_id)
    assert snapshot is not None, f"task {task_id} does not exist"
    return snapshot


def drain(worker: Worker, admin: Admin, task_id: str, state: str) -> TaskSnapshot:
    """Run ``worker`` once at a time until the task reaches ``state``."""
    deadline = time.monotonic() + WAIT_SECONDS
    while (snapshot := task(admin, task_id)).state != state:
        assert time.monotonic() < deadline, f"task {task_id} is {snapshot.state}, want {state}"
        if not worker.run_once():
            time.sleep(0.02)
    return snapshot


def task_of_type(
    connection: psycopg.Connection[Any], admin: Admin, task_type: str, state: str
) -> TaskSnapshot:
    """Wait until a task of ``task_type`` reaches ``state``, and return it."""
    deadline = time.monotonic() + WAIT_SECONDS
    while True:
        row = connection.execute(
            "SELECT id::text FROM workhorse.task WHERE task_type = %s", (task_type,)
        ).fetchone()
        if row is not None and (snapshot := task(admin, row[0])).state == state:
            return snapshot
        assert time.monotonic() < deadline, f"no {task_type} task reached {state}"
        time.sleep(0.02)


def stoppable_workers(module: ModuleType, monkeypatch: pytest.MonkeyPatch) -> list[Worker]:
    """Make each ``Worker`` that ``module`` builds poll often and record itself for a stop."""
    workers: list[Worker] = []

    class RecordedWorker(Worker):
        def __init__(self, *arguments: Any, **options: Any) -> None:
            super().__init__(*arguments, poll_ms=20, **options)
            workers.append(self)

    monkeypatch.setattr(module, "Worker", RecordedWorker)
    return workers


def run_in_background(run: Callable[[], None]) -> Callable[[list[Worker]], None]:
    """Start ``run``. The returned function stops the recorded workers and joins the thread."""
    failures: list[BaseException] = []

    def target() -> None:
        try:
            run()
        except BaseException as error:
            failures.append(error)

    thread = Thread(target=target, daemon=True)
    thread.start()

    def stop(workers: list[Worker]) -> None:
        assert thread.is_alive(), f"the snippet stopped early: {failures}"
        for worker in workers:
            worker.stop()
        thread.join(WAIT_SECONDS)
        assert not thread.is_alive(), "the snippet did not stop"
        assert failures == []

    return stop


def test_hero_enqueues_and_completes_a_welcome_email(
    database_url: str,
    connection: psycopg.Connection[Any],
    admin: Admin,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    hero = load("hero")
    workers = stoppable_workers(hero, monkeypatch)
    stop = run_in_background(lambda: hero.run(database_url))
    snapshot = task_of_type(connection, admin, "email.welcome", "succeeded")
    stop(workers)
    assert snapshot.result == {"deliveredTo": "ada@example.com"}


def test_language_enqueues_a_welcome_email(
    database_url: str, connection: psycopg.Connection[Any], admin: Admin
) -> None:
    load("language").enqueue_welcome(database_url)
    snapshot = task_of_type(connection, admin, "email.welcome", "ready")
    assert snapshot.payload == {"to": "ada@example.com"}


def test_enqueue_commits_the_order_and_its_task_together(
    database_url: str, connection: psycopg.Connection[Any], admin: Admin
) -> None:
    connection.execute("CREATE TABLE orders (id text PRIMARY KEY, total bigint)")
    load("enqueue").create_order(database_url, "order-1", 42)
    row = connection.execute("SELECT total FROM orders WHERE id = 'order-1'").fetchone()
    assert row == (42,)
    snapshot = task_of_type(connection, admin, "order.confirm", "ready")
    assert snapshot.payload == {"orderId": "order-1"}


def test_checkpoints_complete_an_invoice(
    worker_pool: ConnectionPool, queue: Queue, admin: Admin, capsys: pytest.CaptureFixture[str]
) -> None:
    worker = polling_worker(worker_pool)
    load("checkpoints").register_invoice(worker)
    task_id = queue.enqueue("invoice.issue", {"amount": 5, "email": "ada@example.com"})
    snapshot = drain(worker, admin, task_id, "succeeded")
    assert snapshot.result == {"chargeId": "ch_5"}
    assert "email ada@example.com {'chargeId': 'ch_5'}" in capsys.readouterr().out


def test_sleep_suspends_the_settlement(
    worker_pool: ConnectionPool, queue: Queue, admin: Admin
) -> None:
    worker = polling_worker(worker_pool)
    load("sleep").register_settlement(worker)
    task_id = queue.enqueue("order.settle", {"orderId": "order-1"})
    snapshot = drain(worker, admin, task_id, "scheduled")
    assert snapshot.run_at > datetime.now(UTC) + timedelta(minutes=59)


def test_retries_store_the_retry_policy(queue: Queue, admin: Admin) -> None:
    kickoff = datetime.now(UTC) + timedelta(hours=2)
    task_id = load("retries").enqueue_reminder(queue, "match-1", kickoff)
    snapshot = task(admin, task_id)
    assert snapshot.retry_policy == {
        "type": "exponential",
        "initialDelayMs": 1_000,
        "multiplier": 2,
        "maxDelayMs": 60_000,
    }
    assert (snapshot.max_attempts, snapshot.execution_timeout_ms) == (5, 30_000)


def test_idempotency_returns_the_same_task_twice(queue: Queue, admin: Admin) -> None:
    idempotency = load("idempotency")
    first = idempotency.capture_invoice(queue)
    second = idempotency.capture_invoice(queue)
    assert second == first
    assert task(admin, first).queue == "billing"


def test_schedules_sync_the_schedule_and_run_a_worker(
    database_url: str, connection: psycopg.Connection[Any], monkeypatch: pytest.MonkeyPatch
) -> None:
    schedules = load("schedules")
    workers = stoppable_workers(schedules, monkeypatch)
    stop = run_in_background(lambda: schedules.run_billing(database_url))
    deadline = time.monotonic() + WAIT_SECONDS
    while not workers:
        assert time.monotonic() < deadline, "the snippet built no worker"
        time.sleep(0.02)
    # The worker runs a maintenance pass before it waits for a stop.
    time.sleep(0.5)
    stop(workers)
    row = connection.execute(
        "SELECT cron_expression, task_type FROM workhorse.schedule_definition "
        "WHERE namespace = 'billing' AND schedule_name = 'nightly-invoice-run'"
    ).fetchone()
    assert row == ("0 2 * * *", "invoices.generate")


def test_flow_control_stores_its_policies_and_enqueues_mail(
    connection: psycopg.Connection[Any], queue: Queue, admin: Admin
) -> None:
    load("flow_control").configure_flow_control(queue, "msg-1", "acme")
    concurrency = connection.execute(
        "SELECT max_active, max_active_per_key FROM workhorse.concurrency_policy "
        "WHERE queue_name = 'mail'"
    ).fetchone()
    rate = connection.execute(
        "SELECT rate_limit, rate_interval_ms, rate_burst FROM workhorse.rate_limit_policy "
        "WHERE queue_name = 'provider-api'"
    ).fetchone()
    assert (concurrency, rate) == ((20, 2), (100, 1_000, 200))
    snapshot = task_of_type(connection, admin, "mail.send", "ready")
    assert (snapshot.queue, snapshot.concurrency_key) == ("mail", "tenant:acme")


def test_dependencies_block_the_confirmation_and_join_a_child(
    worker_pool: ConnectionPool, connection: psycopg.Connection[Any], queue: Queue, admin: Admin
) -> None:
    worker = polling_worker(worker_pool)
    load("dependencies").configure_checkout(queue, worker, "order-1")
    inventory = task_of_type(connection, admin, "inventory.reserve", "ready")
    confirmation = task_of_type(connection, admin, "order.confirm", "blocked")
    assert confirmation.prerequisite_task_ids == (inventory.id,)

    def capture(payload: Json, _context: HandlerContext) -> Json:
        return {"captured": payload}

    worker.handle("payment.capture", capture)
    task_id = queue.enqueue("order.fulfill", {"id": "order-1"})
    snapshot = drain(worker, admin, task_id, "succeeded")
    assert snapshot.result == {"receipt": {"captured": {"id": "order-1"}}}


def test_coalescing_keeps_the_latest_revision(
    connection: psycopg.Connection[Any], queue: Queue, admin: Admin
) -> None:
    load("coalescing").reindex(queue, "doc-1", 60_000)
    snapshot = task_of_type(connection, admin, "search.reindex", "scheduled")
    assert snapshot.payload == {"documentId": "doc-1", "revision": 2}


def test_external_waits_resume_with_the_scan_and_the_review(
    worker_pool: ConnectionPool, queue: Queue, admin: Admin
) -> None:
    external_waits = load("external_waits")
    worker = polling_worker(worker_pool)
    external_waits.configure_release(worker)
    task_id = queue.enqueue("release.publish", {"id": "v1"})
    drain(worker, admin, task_id, "scheduled")

    external_waits.deliver_scan(queue, task_id, {"clean": True}, "scan-1")
    drain(worker, admin, task_id, "scheduled")
    queue.complete_human_wait(
        task_id,
        "release-approval",
        {"approved": True},
        idempotency_key="review-1",
        requested_by="landing-test",
    )
    snapshot = drain(worker, admin, task_id, "succeeded")
    assert snapshot.result == {"published": True}


def test_batch_handlers_complete_each_task_with_its_payload(
    worker_pool: ConnectionPool, queue: Queue, admin: Admin
) -> None:
    worker = polling_worker(worker_pool)
    load("batch_handlers").register_email_batch(worker, 3, 50)
    payloads: dict[str, Json] = {}
    for name in ("ada", "grace", "edsger"):
        payload: Json = {"to": f"{name}@example.com"}
        payloads[queue.enqueue("email.send", payload)] = payload
    for task_id, payload in payloads.items():
        assert drain(worker, admin, task_id, "succeeded").result == payload


def test_cancellation_cancels_the_export_and_runs_the_next_one(
    worker_pool: ConnectionPool, queue: Queue, admin: Admin
) -> None:
    worker = polling_worker(worker_pool)
    rows: Json = {"rows": [{"id": 1}, {"id": 2}]}
    canceled = queue.enqueue("rows.export", rows)
    load("cancellation").configure_export(queue, worker, canceled)
    snapshot = task(admin, canceled)
    assert snapshot.state == "canceled"
    assert isinstance(snapshot.error, dict)
    assert snapshot.error["requested_by"] == "operator@example.com"
    assert snapshot.error["reason"] == "customer withdrew the request"

    task_id = queue.enqueue("rows.export", rows)
    assert drain(worker, admin, task_id, "succeeded").result == {"stopped": False}


class CardDeclined(Exception):
    """The failure that the dead-letters snippet filters for."""


def test_dead_letters_redrive_the_declined_billing_task(
    worker_pool: ConnectionPool, connection: psycopg.Connection[Any], queue: Queue, admin: Admin
) -> None:
    worker = polling_worker(worker_pool, "billing")

    def capture(_payload: Json, _context: HandlerContext) -> Json:
        raise CardDeclined("the card was declined")

    worker.handle("invoice.capture", capture)
    task_id = queue.enqueue("invoice.capture", {}, EnqueueOptions(queue="billing", max_attempts=1))
    drain(worker, admin, task_id, "failed")

    load("dead_letters").redrive_billing(admin)

    # A redrive leaves the failed task as it is and enqueues a copy of it.
    assert task(admin, task_id).state == "failed"
    row = connection.execute(
        "SELECT id::text FROM workhorse.task WHERE task_type = 'invoice.capture' AND id <> %s",
        (task_id,),
    ).fetchone()
    assert row is not None
    copy = task(admin, row[0])
    assert (copy.queue, copy.state) == ("billing", "ready")


def test_operate_dashboard_serves_an_operator_and_refuses_a_stranger(
    database_url: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("DATABASE_URL", database_url)
    operate_dashboard = load("operate_dashboard")
    try:
        environ: dict[str, object] = {"REQUEST_METHOD": "GET", "PATH_INFO": "/workhorse"}
        operator = operate_dashboard.dashboard.handle({**environ, "REMOTE_USER": "ada"})
        stranger = operate_dashboard.dashboard.handle(environ)
    finally:
        operate_dashboard.connection.close()
    assert operator.status not in (401, 403)
    assert operator.status < 500
    assert stranger.status == 401


def test_operate_health_reads_health_and_live_tasks(
    database_url: str, queue: Queue, capsys: pytest.CaptureFixture[str]
) -> None:
    queue.enqueue("email.send", {})
    load("operate_health").inspect(database_url)
    assert capsys.readouterr().out.splitlines()[-1] == "0"


def test_operate_fleet_pauses_only_billing_workers(
    database_url: str, worker_pool: ConnectionPool, admin: Admin
) -> None:
    workers = [
        Worker(worker_pool, queue=queue_name, worker_id=f"{queue_name}-worker", poll_ms=20)
        for queue_name in ("billing", "email")
    ]
    threads = [Thread(target=worker.run, daemon=True) for worker in workers]
    for thread in threads:
        thread.start()
    try:
        deadline = time.monotonic() + WAIT_SECONDS
        while len(admin.list_workers()) < 2:
            assert time.monotonic() < deadline, "the workers did not register"
            time.sleep(0.02)

        load("operate_fleet").pause_billing(database_url)

        paused = sorted((entry.worker_id, entry.paused) for entry in admin.list_workers())
        assert paused == [("billing-worker", True), ("email-worker", False)]
    finally:
        for worker in workers:
            worker.stop()
        for thread in threads:
            thread.join(WAIT_SECONDS)


def test_deploy_runs_an_email_worker(
    database_url: str,
    connection: psycopg.Connection[Any],
    queue: Queue,
    admin: Admin,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    queue.enqueue("email.send", {"to": "ada@example.com"}, EnqueueOptions(queue="email"))
    completed: list[TaskSnapshot] = []

    def run_until_sent(worker: Worker, *, shutdown_timeout_ms: int) -> None:
        assert shutdown_timeout_ms == 25_000
        stop = run_in_background(worker.run)
        completed.append(task_of_type(connection, admin, "email.send", "succeeded"))
        stop([worker])

    # The snippet runs at import, so the test sets its environment and replaces the process
    # runner before the import.
    monkeypatch.setenv("DATABASE_URL", database_url)
    monkeypatch.setattr(workhorse, "run_worker_process", run_until_sent)
    load("deploy")

    assert [snapshot.result for snapshot in completed] == [{"deliveredTo": "ada@example.com"}]
