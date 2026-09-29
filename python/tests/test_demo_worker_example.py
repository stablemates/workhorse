from __future__ import annotations

import importlib.util
import time
from pathlib import Path
from threading import Thread
from types import SimpleNamespace
from typing import cast
from uuid import uuid4

import psycopg
import pytest
from psycopg_pool import ConnectionPool

from workhorse import Admin, AdminAudit, EnqueueOptions, HandlerContext, Queue

module_spec = importlib.util.spec_from_file_location(
    "demo_worker", Path(__file__).parents[1] / "examples" / "demo_worker.py"
)
assert module_spec is not None and module_spec.loader is not None
demo_worker = importlib.util.module_from_spec(module_spec)
module_spec.loader.exec_module(demo_worker)


def test_worker_uses_dedicated_and_shared_queues() -> None:
    assert (
        demo_worker.PYTHON_QUEUE,
        demo_worker.SHARED_QUEUE,
        demo_worker.PYTHON_FAST_QUEUE,
    ) == ("demo-python", "demo-shared", "demo-python-fast")


def test_database_url_reads_development_primary_database() -> None:
    assert (
        demo_worker.database_url(
            {
                "DATABASE_URL_PRIMARY": "postgresql:///dev_primary",
                "DATABASE_URL": "postgresql:///ambient",
            }
        )
        == "postgresql:///dev_primary"
    )


def test_language_task_identifies_python_runtime() -> None:
    context = cast(HandlerContext, SimpleNamespace(task=SimpleNamespace(attempt=2)))

    assert demo_worker.language_task({"language": "python"}, context) == {
        "language": "python",
        "runtime": "python",
        "attempt": 2,
    }


def test_language_task_refuses_another_runtime() -> None:
    context = cast(HandlerContext, SimpleNamespace(task=SimpleNamespace(attempt=1)))

    with pytest.raises(ValueError, match="another language"):
        demo_worker.language_task({"language": "go"}, context)


def test_shared_task_identifies_python_runtime() -> None:
    context = cast(HandlerContext, SimpleNamespace(task=SimpleNamespace(attempt=3)))

    assert demo_worker.shared_task({"source": "schedule"}, context) == {
        "source": "schedule",
        "runtime": "python",
        "attempt": 3,
    }


def test_worker_identity_exposes_runtime_and_stays_process_unique() -> None:
    first = demo_worker.worker_id()
    second = demo_worker.worker_id()

    assert first.startswith("demo-python-")
    assert second.startswith("demo-python-")
    assert first != second


@pytest.mark.integration
def test_worker_completes_a_task_on_its_fast_tier_queue(database_url: str) -> None:
    with psycopg.connect(database_url, autocommit=True) as connection:
        audit = AdminAudit(
            actor="python-demo-worker-test", reason="seed the fast tier", request_id=str(uuid4())
        )
        admin = Admin(connection)
        assert admin.set_queue_tier(demo_worker.PYTHON_FAST_QUEUE, "fast", audit) == "fast"
        admin.set_queue_history(demo_worker.PYTHON_FAST_QUEUE, record_claims=True)
        task_id = Queue(connection).enqueue(
            demo_worker.LANGUAGE_TASK_TYPE,
            {"language": "python"},
            EnqueueOptions(queue=demo_worker.PYTHON_FAST_QUEUE, max_attempts=1),
        )

    def outcome() -> tuple[str, object] | None:
        with psycopg.connect(database_url, autocommit=True) as connection:
            row = connection.execute(
                "SELECT state, result FROM workhorse.fast_task_outcome WHERE task_id = %s",
                (task_id,),
            ).fetchone()
        return None if row is None else (str(row[0]), row[1])

    with ConnectionPool(
        database_url, min_size=1, max_size=6, kwargs={"autocommit": True}, open=True
    ) as pool:
        worker = demo_worker.build_worker(pool, 50)
        thread = Thread(target=worker.run)
        thread.start()
        try:
            deadline = time.monotonic() + 20
            while outcome() is None:
                assert time.monotonic() < deadline, "worker did not finish in time"
                time.sleep(0.05)
        finally:
            worker.stop()
            thread.join(timeout=10)
        assert not thread.is_alive()

    assert outcome() == (
        "succeeded",
        {"language": "python", "runtime": "python", "attempt": 1},
    )


def test_only_the_development_demo_waits_for_the_schema() -> None:
    assert demo_worker.waits_for_schema({"WORKHORSE_DEMO_MODE": "development"})
    assert not demo_worker.waits_for_schema({"WORKHORSE_DEMO_MODE": "production"})
    assert not demo_worker.waits_for_schema({})
    with pytest.raises(RuntimeError, match="WORKHORSE_DEMO_MODE"):
        demo_worker.waits_for_schema({"WORKHORSE_DEMO_MODE": "staging"})


@pytest.mark.integration
def test_worker_waits_for_a_missing_schema_until_it_is_installed(database_url: str) -> None:
    with ConnectionPool(
        database_url, min_size=1, max_size=2, kwargs={"autocommit": True}, open=True
    ) as pool:
        demo_worker.wait_for_schema(pool, retry_seconds=0.05)

        with psycopg.connect(database_url, autocommit=True) as connection:
            connection.execute("DROP SCHEMA workhorse CASCADE")
        waiting = Thread(target=demo_worker.wait_for_schema, args=(pool, 0.05))
        waiting.start()
        time.sleep(0.5)
        assert waiting.is_alive(), "the worker stopped waiting for a missing schema"

        schema = (Path(__file__).parents[2] / "sql/schema/current.sql").read_text()
        with psycopg.connect(database_url, autocommit=True) as connection:
            connection.execute(schema)
        waiting.join(timeout=10)
        assert not waiting.is_alive(), "the wait did not end once the schema existed"
