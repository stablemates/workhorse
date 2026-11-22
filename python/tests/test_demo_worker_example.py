from __future__ import annotations

import importlib.util
import json
import logging
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


def test_demo_log_file_needs_a_directory_and_a_service_name() -> None:
    assert demo_worker.demo_log_file({}) is None
    assert demo_worker.demo_log_file({"WORKHORSE_DEMO_LOG_DIRECTORY": "/tmp/x"}) is None


def test_demo_log_file_writes_the_typescript_record_shape(tmp_path: Path) -> None:
    log_file = demo_worker.demo_log_file(
        {
            "WORKHORSE_DEMO_LOG_DIRECTORY": str(tmp_path),
            "WORKHORSE_DEMO_SERVICE_NAME": "workhorse-demo-worker-python",
            "WORKHORSE_DEMO_ENV": "test env",
        }
    )
    assert log_file is not None
    provider = demo_worker.DemoLoggerProvider(log_file)
    provider.get_logger("workhorse").emit(
        severity_text="INFO",
        event_name="workhorse.task.completed",
        body="Task completed",
        attributes={"workhorse.task.id": "a", "workhorse.worker.queues": ("q1", "q2")},
    )

    path = tmp_path / "test_env" / "workhorse-demo-worker-python.ndjson"
    record = json.loads(path.read_text())
    assert list(record) == [
        "timestamp",
        "observedTimestamp",
        "severityText",
        "severityNumber",
        "eventName",
        "body",
        "attributes",
        "resource",
        "scope",
    ]
    assert record["timestamp"].endswith("Z")
    assert record["severityNumber"] == 9
    assert record["eventName"] == "workhorse.task.completed"
    assert record["attributes"] == {
        "workhorse.task.id": "a",
        "workhorse.worker.queues": ["q1", "q2"],
    }
    assert record["resource"]["service.name"] == "workhorse-demo-worker-python"
    assert record["resource"]["deployment.environment.name"] == "test env"
    assert record["resource"]["telemetry.sdk.language"] == "python"
    assert record["scope"] == {"name": "workhorse"}


def test_demo_log_file_rotates_before_the_limit(tmp_path: Path) -> None:
    log_file = demo_worker.DemoLogFile(tmp_path / "w.ndjson", 400, 2, {"service.name": "w"})
    for index in range(12):
        log_file.write(severity_text="INFO", body=f"record {index}", scope="test")

    names = sorted(path.name for path in tmp_path.iterdir())
    assert names == ["w.ndjson", "w.ndjson.1", "w.ndjson.2"]
    for path in tmp_path.iterdir():
        assert path.stat().st_size <= 400
    assert json.loads((tmp_path / "w.ndjson").read_text().splitlines()[-1])["body"] == "record 11"


def test_demo_log_handler_copies_standard_library_events(tmp_path: Path) -> None:
    log_file = demo_worker.DemoLogFile(tmp_path / "w.ndjson", 10_000, 1, {})
    logger = logging.getLogger("workhorse.demo-test")
    handler = demo_worker.DemoLogHandler(log_file)
    logger.addHandler(handler)
    try:
        logger.error(
            "Reporter failed",
            extra={"event.name": "workhorse.worker.reporter_failed", "error.type": "ValueError"},
        )
        logger.error("echo", extra={demo_worker.ECHO_MARKER: True})
    finally:
        logger.removeHandler(handler)

    lines = (tmp_path / "w.ndjson").read_text().splitlines()
    assert len(lines) == 1
    record = json.loads(lines[0])
    assert record["severityText"] == "ERROR"
    assert record["severityNumber"] == 17
    assert record["eventName"] == "workhorse.worker.reporter_failed"
    assert record["attributes"] == {"error.type": "ValueError"}


def test_demo_log_file_refuses_an_invalid_size() -> None:
    with pytest.raises(RuntimeError, match="WORKHORSE_DEMO_LOG_MAX_BYTES"):
        demo_worker.demo_log_file(
            {
                "WORKHORSE_DEMO_LOG_DIRECTORY": "/tmp/x",
                "WORKHORSE_DEMO_SERVICE_NAME": "w",
                "WORKHORSE_DEMO_LOG_MAX_BYTES": "0",
            }
        )


def test_demo_log_file_writes_strict_json_and_never_raises(tmp_path: Path) -> None:
    log_file = demo_worker.DemoLogFile(tmp_path / "w.ndjson", 10_000, 1, {})
    log_file.write(
        severity_text="INFO",
        body="numbers",
        scope="test",
        attributes={"nan": float("nan"), "list": [float("inf"), 1.5]},
    )
    log_file.write(
        severity_text="INFO", body="bad key", scope="test", attributes={"x": {(1, 2): 3}}
    )

    lines = (tmp_path / "w.ndjson").read_text().splitlines()
    record = json.loads(lines[0], parse_constant=lambda name: pytest.fail(f"non-JSON {name}"))
    assert record["attributes"] == {"nan": None, "list": [None, 1.5]}
