from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from uuid import uuid4

import asyncpg
import psycopg
import pytest

from workhorse import (
    Admin,
    AdminAudit,
    AsyncAdmin,
    BulkRedriveOptions,
    DeadLetterFilter,
    DeadLetterQuery,
    EnqueueOptions,
    HandlerContext,
    JobListQuery,
    JobPayloadProjection,
    Queue,
    Worker,
)

pytestmark = pytest.mark.integration


@dataclass(frozen=True)
class AdminFixture:
    listed_job_id: str
    purge_job_id: str
    failed_job_ids: tuple[str, str]
    durable_job_id: str
    human_job_id: str
    worker_id: str


def _raise_failure(_payload: object, _context: HandlerContext) -> object:
    raise RuntimeError("operator fixture failure")


def _durable_wait(_payload: object, context: HandlerContext) -> object:
    context.checkpoint("prepared", lambda: {"ready": True})
    context.set_progress({"step": "waiting"})
    context.sleep("backoff", 60_000)
    raise AssertionError("sleep should suspend the handler")


def _human_wait(_payload: object, context: HandlerContext) -> object:
    context.wait_for_human("approval", {"question": "Ship it?"})
    raise AssertionError("human wait should suspend the handler")


def _prepare_admin_fixture(database_url: str) -> AdminFixture:
    with psycopg.connect(database_url, autocommit=True) as connection:
        queue = Queue(connection)
        listed_job_id = queue.enqueue("admin.listed", {"secret": "hidden", "safe": True})
        purge_job_id = queue.enqueue("admin.purge", {}, EnqueueOptions(queue="admin-purge"))
        failed_job_ids = (
            queue.enqueue(
                "admin.failure",
                {"number": 1},
                EnqueueOptions(queue="admin-failure", max_attempts=1),
            ),
            queue.enqueue(
                "admin.failure",
                {"number": 2},
                EnqueueOptions(queue="admin-failure", max_attempts=1),
            ),
        )
        durable_job_id = queue.enqueue("admin.durable", {}, EnqueueOptions(queue="admin-durable"))
        human_job_id = queue.enqueue("admin.human", {}, EnqueueOptions(queue="admin-human"))

    worker_id = "python-admin-worker"
    with psycopg.connect(database_url, autocommit=True) as connection:
        assert (
            Worker(connection, queue="admin-failure", worker_id=worker_id)
            .handle("admin.failure", _raise_failure)
            .run_once()
            is True
        )
        connection.execute(
            """SELECT workhorse.register_worker_v1(
                 %s::text, %s::uuid, %s::text, %s::integer, %s::text[], %s::integer,
                 %s::integer, %s::integer, %s::integer, %s::integer, %s::integer,
                 %s::integer, %s::integer, %s::boolean)""",
            (
                worker_id,
                uuid4(),
                "admin-test-host",
                42,
                ["admin-failure"],
                1,
                30_000,
                10_000,
                250,
                1_000,
                60_000,
                5_000,
                0,
                False,
            ),
        )
        assert (
            Worker(connection, queue="admin-durable", worker_id="python-admin-durable")
            .handle("admin.durable", _durable_wait)
            .run_once()
            is True
        )
        assert (
            Worker(connection, queue="admin-human", worker_id="python-admin-human")
            .handle("admin.human", _human_wait)
            .run_once()
            is True
        )

    return AdminFixture(
        listed_job_id,
        purge_job_id,
        failed_job_ids,
        durable_job_id,
        human_job_id,
        worker_id,
    )


def _assert_read_results(
    fixture: AdminFixture,
    *,
    get_job: Callable[[str], object],
    list_jobs: Callable[[], object],
) -> None:
    assert get_job(fixture.listed_job_id) is not None
    assert list_jobs() is not None


def test_admin_exposes_each_operator_operation_over_psycopg(database_url: str) -> None:
    fixture = _prepare_admin_fixture(database_url)
    audit = AdminAudit("python-test", "exercise operator operation", "sync-admin-request")

    with psycopg.connect(database_url, autocommit=True) as connection:
        admin = Admin(connection)
        snapshot = admin.get_job(fixture.listed_job_id)
        assert snapshot is not None and snapshot.state == "ready"
        listed = admin.list_jobs(
            JobListQuery(payload=JobPayloadProjection(include=True, redact_keys=("secret",)))
        )
        assert fixture.listed_job_id in {job.id for job in listed.items}
        assert next(job for job in listed.items if job.id == fixture.listed_job_id).payload == {
            "safe": True
        }
        assert admin.get_job_timeline(fixture.listed_job_id).items

        dead_letters = admin.list_dead_letters(DeadLetterQuery(queue="admin-failure"))
        assert {letter.job_id for letter in dead_letters.items} == set(fixture.failed_job_ids)
        single = admin.redrive(fixture.failed_job_ids[0], audit)
        assert single.status == "redriven" and single.target_job_id is not None
        bulk = admin.redrive_many(
            DeadLetterFilter(queue="admin-failure"),
            AdminAudit("python-test", "preview remaining failures", "sync-admin-bulk"),
            BulkRedriveOptions(dry_run=True),
        )
        assert fixture.failed_job_ids[1] in {result.source_job_id for result in bulk.results}
        assert {result.status for result in bulk.results} == {"eligible"}

        assert admin.get_checkpoint(fixture.durable_job_id, "prepared") is not None
        assert len(admin.list_checkpoints(fixture.durable_job_id)) == 1
        assert admin.get_progress(fixture.durable_job_id) is not None
        assert admin.get_wait(fixture.durable_job_id, "backoff") is not None
        assert len(admin.list_waits(fixture.durable_job_id)) == 1
        human_waits = admin.list_human_waits()
        assert fixture.human_job_id in {wait.job_id for wait in human_waits.items}
        assert admin.list_signal_waits().items == ()

        workers = admin.list_workers()
        assert fixture.worker_id in {worker.worker_id for worker in workers}
        paused = admin.set_worker_paused(fixture.worker_id, True, audit)
        assert paused is not None and paused.paused is True
        assert admin.set_worker_paused("missing-worker", True, audit) is None

        admin.pause_queue("admin-listed", audit)
        assert connection.execute(
            "SELECT paused FROM workhorse.queue_control WHERE queue_name = 'admin-listed'"
        ).fetchone() == (True,)
        admin.resume_queue("admin-listed", audit)
        assert connection.execute(
            "SELECT paused FROM workhorse.queue_control WHERE queue_name = 'admin-listed'"
        ).fetchone() == (False,)
        assert admin.purge_queue("admin-purge", audit) == 1
        assert admin.purge_queue("admin-purge", audit) == 1
        assert admin.get_job(fixture.purge_job_id) is None


async def _assert_async_admin_operations(
    admin: AsyncAdmin, fixture: AdminFixture, driver: str
) -> None:
    audit = AdminAudit(
        "python-test", "exercise async operator operation", f"{driver}-admin-request"
    )
    snapshot = await admin.get_job(fixture.listed_job_id)
    assert snapshot is not None and snapshot.state == "ready"
    listed = await admin.list_jobs(JobListQuery(states=("ready",)))
    assert fixture.listed_job_id in {job.id for job in listed.items}
    assert (await admin.get_job_timeline(fixture.listed_job_id)).items

    dead_letters = await admin.list_dead_letters(DeadLetterQuery(queue="admin-failure"))
    assert {letter.job_id for letter in dead_letters.items} == set(fixture.failed_job_ids)
    single = await admin.redrive(fixture.failed_job_ids[0], audit)
    assert single.status == "redriven"
    bulk = await admin.redrive_many(
        DeadLetterFilter(queue="admin-failure"),
        AdminAudit("python-test", "preview remaining failures", f"{driver}-admin-bulk"),
        BulkRedriveOptions(dry_run=True),
    )
    assert bulk.results[0].status == "eligible"

    assert await admin.get_checkpoint(fixture.durable_job_id, "prepared") is not None
    assert len(await admin.list_checkpoints(fixture.durable_job_id)) == 1
    assert await admin.get_progress(fixture.durable_job_id) is not None
    assert await admin.get_wait(fixture.durable_job_id, "backoff") is not None
    assert len(await admin.list_waits(fixture.durable_job_id)) == 1
    assert fixture.human_job_id in {wait.job_id for wait in (await admin.list_human_waits()).items}
    assert (await admin.list_signal_waits()).items == ()

    assert fixture.worker_id in {worker.worker_id for worker in await admin.list_workers()}
    paused = await admin.set_worker_paused(fixture.worker_id, True, audit)
    assert paused is not None and paused.paused is True
    await admin.pause_queue("admin-listed", audit)
    await admin.resume_queue("admin-listed", audit)
    assert await admin.purge_queue("admin-purge", audit) == 1
    assert await admin.purge_queue("admin-purge", audit) == 1
    assert await admin.get_job(fixture.purge_job_id) is None


@pytest.mark.asyncio
async def test_async_admin_exposes_each_operator_operation_over_asyncpg(
    database_url: str,
) -> None:
    fixture = _prepare_admin_fixture(database_url)
    connection = await asyncpg.connect(database_url)
    try:
        await _assert_async_admin_operations(
            AsyncAdmin.from_asyncpg(connection), fixture, "asyncpg"
        )
    finally:
        await connection.close()


@pytest.mark.asyncio
async def test_async_admin_exposes_each_operator_operation_over_psycopg(
    database_url: str,
) -> None:
    fixture = _prepare_admin_fixture(database_url)
    connection = await psycopg.AsyncConnection.connect(database_url, autocommit=True)
    async with connection:
        await _assert_async_admin_operations(
            AsyncAdmin.from_psycopg(connection), fixture, "async-psycopg"
        )
