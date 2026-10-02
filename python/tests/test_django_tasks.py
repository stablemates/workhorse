from __future__ import annotations

import importlib
import os
import subprocess
import sys
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import psycopg
import pytest
import test_django_enqueue as transaction_fixture
from asgiref.sync import async_to_sync, sync_to_async
from django.core.exceptions import ImproperlyConfigured
from django.db import connections, transaction
from django.db.transaction import TransactionManagementError
from django.tasks import Task, TaskResult, TaskResultStatus, task_backends
from django.tasks.exceptions import InvalidTask
from django.test import override_settings
from psycopg_pool import ConnectionPool

from workhorse import EnqueueOptions, Worker, django as seam
from workhorse.django import WorkhorseTaskBackend, enqueue_in_atomic

pytestmark = pytest.mark.integration
PATH = "django_tasks.greet"
business_model = transaction_fixture.business_model
django_database = transaction_fixture.django_database
visible_counts = transaction_fixture.visible_counts


@pytest.fixture
def backend(django_database: str) -> Iterator[WorkhorseTaskBackend]:
    configured = {
        "default": {
            "BACKEND": "workhorse.django.WorkhorseTaskBackend",
            "QUEUES": ["default", "urgent"],
            "OPTIONS": {
                "DATABASE_ALIAS": django_database,
                "TASK_PATHS": [PATH],
                "MAX_ATTEMPTS": 2,
            },
        }
    }
    sys.path.insert(0, str(Path(__file__).parents[1] / "examples"))
    with override_settings(TASKS=configured):
        sys.modules.pop("django_tasks", None)
        importlib.import_module("django_tasks")
        yield task_backends["default"]
    sys.modules.pop("django_tasks", None)
    sys.path.pop(0)


def decorated() -> Any:
    return importlib.import_module("django_tasks").greet


@pytest.mark.parametrize("rollback", [False, True])
def test_joint_outcomes(backend: WorkhorseTaskBackend, database_url: str, rollback: bool) -> None:
    with transaction.atomic(using=backend.database_alias):
        with connections[backend.database_alias].cursor() as cursor:
            cursor.execute("INSERT INTO django_orders VALUES (1, 'accepted')")
        result = decorated().using(queue_name="urgent").enqueue(("world",), punctuation=b"?")
        assert isinstance(result, TaskResult)
        assert result.status == TaskResultStatus.READY
        assert result.args == [["world"]]
        assert result.kwargs == {"punctuation": "?"}
        assert result.worker_ids == [] and result.attempts == 0 and not result.is_finished
        assert visible_counts(database_url) == (0, 0)
        transaction.set_rollback(rollback, using=backend.database_alias)
    assert visible_counts(database_url) == ((0, 0) if rollback else (1, 1))
    with psycopg.connect(database_url, autocommit=True) as observer:
        row = observer.execute(
            "SELECT id::text, queue_name, max_attempts, payload FROM workhorse.task"
        ).fetchone()
        if not rollback:
            assert row is not None and row[:3] == (result.id, "urgent", 2)
            assert row[3]["args"] == [["world"]]


def test_savepoint_and_outside_atomic(backend: WorkhorseTaskBackend, database_url: str) -> None:
    with pytest.raises(TransactionManagementError):
        decorated().enqueue("outside")
    with transaction.atomic(using=backend.database_alias):
        decorated().enqueue("outer")
        with transaction.atomic(using=backend.database_alias):
            decorated().enqueue("inner")
            transaction.set_rollback(True, using=backend.database_alias)
        assert visible_counts(database_url) == (0, 0)
    assert visible_counts(database_url) == (0, 1)


@pytest.mark.parametrize("rollback", [False, True])
def test_inherited_async_transaction(
    backend: WorkhorseTaskBackend, database_url: str, rollback: bool
) -> None:
    def whole_transaction() -> TaskResult[Any, Any]:
        try:
            with transaction.atomic(using=backend.database_alias):
                with connections[backend.database_alias].cursor() as cursor:
                    cursor.execute("INSERT INTO django_orders VALUES (1, 'async')")
                result = async_to_sync(decorated().aenqueue)("async")
                assert visible_counts(database_url) == (0, 0)
                transaction.set_rollback(rollback, using=backend.database_alias)
                return result
        finally:
            connections[backend.database_alias].close()
            del connections[backend.database_alias]

    async def caller() -> TaskResult[Any, Any]:
        return await sync_to_async(whole_transaction, thread_sensitive=True)()

    result = async_to_sync(caller)()
    assert result.status == TaskResultStatus.READY
    assert visible_counts(database_url) == ((0, 0) if rollback else (1, 1))
    with pytest.raises(TransactionManagementError):
        async_to_sync(decorated().aenqueue)("outside")


@pytest.mark.parametrize(
    "override", [{"priority": 1}, {"run_after": "later"}, {"queue_name": "unregistered"}]
)
def test_unsupported_overrides(backend: WorkhorseTaskBackend, override: dict[str, Any]) -> None:
    assert not any(
        (
            backend.supports_defer,
            backend.supports_priority,
            backend.supports_async_task,
            backend.supports_get_result,
        )
    )
    with pytest.raises(InvalidTask):
        decorated().using(**override)


@pytest.mark.parametrize("value", [object(), float("nan"), float("inf"), {1: "bad key"}])
def test_invalid_json(backend: WorkhorseTaskBackend, value: Any) -> None:
    with transaction.atomic(using=backend.database_alias), pytest.raises((TypeError, ValueError)):
        decorated().enqueue("json", punctuation=value)


def test_invalid_definitions_and_arguments(backend: WorkhorseTaskBackend) -> None:
    def local() -> None:
        pass

    with pytest.raises(InvalidTask):
        Task(func=local)
    with pytest.raises(TypeError):
        decorated().enqueue()
    with pytest.raises(TypeError):
        decorated().enqueue("name", unknown=True)
    with pytest.raises(InvalidTask):
        backend._resolve("os.system")
    original = backend.task_paths
    backend.task_paths = ("os.system",)
    try:
        with pytest.raises(InvalidTask, match="decorated"):
            backend._resolve("os.system")
    finally:
        backend.task_paths = original


@pytest.mark.parametrize(
    "options",
    [
        {},
        {"DATABASE_ALIAS": "business", "TASK_PATHS": []},
        {"DATABASE_ALIAS": "business", "TASK_PATHS": [PATH], "MAX_ATTEMPTS": False},
    ],
)
def test_invalid_configuration(backend: WorkhorseTaskBackend, options: dict[str, Any]) -> None:
    assert backend.alias == "default"
    with pytest.raises(ImproperlyConfigured):
        WorkhorseTaskBackend("default", {"OPTIONS": options})


def test_worker_retry_and_final_failure(
    backend: WorkhorseTaskBackend,
    database_url: str,
    worker_pool: ConnectionPool,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    with transaction.atomic(using=backend.database_alias):
        successful = decorated().enqueue("success")
        transient = decorated().enqueue("transient")
        failing = decorated().enqueue("failure")
    original = decorated().func
    calls: list[str] = []

    def fails(name: str, *, punctuation: str = "!") -> Any:
        calls.append(name)
        if name == "failure" or (name == "transient" and calls.count(name) == 1):
            raise RuntimeError("handler failed")
        return original(name, punctuation=punctuation)

    fails.__module__ = "django_tasks"
    fails.__qualname__ = "greet"
    monkeypatch.setattr(importlib.import_module("django_tasks"), "greet", Task(func=fails))
    for _attempt in range(5):
        worker = Worker(worker_pool, retry_delay_ms=0)
        backend.bind_worker(worker)
        worker.run_once()
    with psycopg.connect(database_url, autocommit=True) as observer:
        rows = observer.execute(
            "SELECT task_id::text, state, current_attempt, result FROM workhorse.task_outcome"
        ).fetchall()
    outcomes = {row[0]: row[1:] for row in rows}
    assert outcomes[successful.id] == ("succeeded", 1, None)
    assert outcomes[transient.id] == ("succeeded", 2, None)
    assert outcomes[failing.id] == ("failed", 2, None)
    assert calls.count("failure") == 2
    assert successful.status == TaskResultStatus.READY
    for operation in (
        successful.refresh,
        lambda: backend.get_result(successful.id),
        lambda: async_to_sync(backend.aget_result)(successful.id),
    ):
        with pytest.raises(NotImplementedError):
            operation()


def test_cross_process_worker_and_results(
    backend: WorkhorseTaskBackend, database_url: str, tmp_path: Path
) -> None:
    with transaction.atomic(using=backend.database_alias):
        result = decorated().using(queue_name="urgent").enqueue("other process")
    configuration = {
        "default": {
            "BACKEND": "workhorse.django.WorkhorseTaskBackend",
            "QUEUES": ["default", "urgent"],
            "OPTIONS": {"DATABASE_ALIAS": "business", "TASK_PATHS": [PATH]},
        }
    }
    (tmp_path / "tasks_settings.py").write_text(
        f"TASKS = {configuration!r}\nDATABASES = {{'default': {{}}}}\n"
        "INSTALLED_APPS = []\nUSE_TZ = True\n"
    )
    examples = Path(__file__).parents[1] / "examples"
    environment = {
        **os.environ,
        "DJANGO_SETTINGS_MODULE": "tasks_settings",
        "PYTHONPATH": os.pathsep.join((str(tmp_path), str(examples))),
    }
    completed = subprocess.run(
        [
            sys.executable,
            "-c",
            "import django; django.setup(); import django_tasks; django_tasks.main()",
            "--database-url",
            database_url,
            "--once",
        ],
        env=environment,
        check=False,
        capture_output=True,
        text=True,
        timeout=30,
    )
    assert completed.returncode == 0, completed.stderr
    with psycopg.connect(database_url, autocommit=True) as observer:
        assert observer.execute(
            "SELECT state, result FROM workhorse.task_outcome WHERE task_id = %s", (result.id,)
        ).fetchone() == ("succeeded", None)
    lookup = subprocess.run(
        [
            sys.executable,
            "-c",
            "import django; django.setup(); "
            "from django.tasks import task_backends; "
            f"task_backends['default'].get_result({result.id!r})",
        ],
        env=environment,
        check=False,
        capture_output=True,
        text=True,
        timeout=30,
    )
    assert lookup.returncode != 0 and "NotImplementedError" in lookup.stderr


@pytest.mark.parametrize("distribution", ["wheel", "sdist"])
def test_optional_installed_module(
    distribution: str, installed_distribution_interpreters: dict[str, Path]
) -> None:
    bare = subprocess.run(
        [
            str(installed_distribution_interpreters[distribution]),
            "-c",
            "import importlib.util; import workhorse; "
            "assert importlib.util.find_spec('django') is None",
        ],
        check=False,
        capture_output=True,
        text=True,
        timeout=30,
    )
    assert bare.returncode == 0, bare.stderr
    optional = subprocess.run(
        [
            str(installed_distribution_interpreters[f"{distribution}-django"]),
            "-c",
            "from workhorse.django import WorkhorseTaskBackend, enqueue_in_atomic; "
            "from django.tasks.backends.base import BaseTaskBackend; "
            "assert issubclass(WorkhorseTaskBackend, BaseTaskBackend)",
        ],
        check=False,
        capture_output=True,
        text=True,
        timeout=30,
    )
    assert optional.returncode == 0, optional.stderr


async def coroutine_handler(name: str) -> str:
    return name


def context_handler(context: Any) -> None:
    assert context is not None


@pytest.mark.parametrize("kind", ["coroutine", "context"])
def test_rejected_handler_kinds(backend: WorkhorseTaskBackend, kind: str) -> None:
    function = coroutine_handler if kind == "coroutine" else context_handler
    backend.task_paths = (*backend.task_paths, f"{function.__module__}.{function.__qualname__}")
    with pytest.raises(InvalidTask, match=r"async|TaskContext"):
        Task(func=function, takes_context=kind == "context")


def test_backend_override_maps_explicit_database(
    backend: WorkhorseTaskBackend, database_url: str
) -> None:
    options = {"DATABASE_ALIAS": backend.database_alias, "TASK_PATHS": [PATH]}
    configured = {
        "default": {"BACKEND": "workhorse.django.WorkhorseTaskBackend", "OPTIONS": options},
        "alternate": {
            "BACKEND": "workhorse.django.WorkhorseTaskBackend",
            "QUEUES": ["urgent"],
            "OPTIONS": options,
        },
    }
    with override_settings(TASKS=configured), transaction.atomic(using=backend.database_alias):
        selected = decorated().using(backend="alternate", queue_name="urgent")
        result = selected.enqueue("override")
        assert result.task is selected and result.backend == "alternate"
        assert task_backends["alternate"].database_alias == backend.database_alias
        assert visible_counts(database_url) == (0, 0)
    with psycopg.connect(database_url, autocommit=True) as observer:
        assert observer.execute(
            "SELECT task_type, queue_name, payload->>'backend' FROM workhorse.task"
        ).fetchone() == ("django.tasks.alternate", "urgent", "alternate")


@pytest.mark.parametrize("alteration", ["path", "backend", "queue", "version", "args"])
def test_worker_rejects_envelope_without_importing_payload(
    backend: WorkhorseTaskBackend,
    database_url: str,
    worker_pool: ConnectionPool,
    monkeypatch: pytest.MonkeyPatch,
    alteration: str,
) -> None:
    worker = Worker(worker_pool)
    backend.bind_worker(worker)
    payload: dict[str, Any] = {
        "version": 1,
        "backend": "default",
        "path": PATH,
        "queue": "default",
        "args": ["valid"],
        "kwargs": {},
    }
    payload[alteration] = {
        "path": "os.system",
        "backend": "other",
        "queue": "urgent",
        "version": True,
        "args": {"wrong": "shape"},
    }[alteration]
    with transaction.atomic(using=backend.database_alias):
        result = enqueue_in_atomic(
            backend.task_type,
            payload,
            using=backend.database_alias,
            options=EnqueueOptions(max_attempts=1),
        )

    def forbidden_import(_path: str) -> None:
        pytest.fail("Execution imported a path instead of using its startup registry")

    monkeypatch.setattr(seam, "import_string", forbidden_import)
    assert worker.run_once()
    with psycopg.connect(database_url, autocommit=True) as observer:
        assert observer.execute(
            "SELECT state, error->>'message' FROM workhorse.task_outcome WHERE task_id = %s",
            (result.task_id,),
        ).fetchone() == ("failed", "Invalid or unregistered Workhorse Django task envelope")


def test_callable_identity_cannot_spoof_registered_path(backend: WorkhorseTaskBackend) -> None:
    assert backend.alias == "default"

    def spoof(name: str) -> str:
        return name

    spoof.__module__ = "django_tasks"
    spoof.__qualname__ = "greet"
    impostor = Task(func=spoof)
    with pytest.raises(InvalidTask, match="differs"):
        impostor.enqueue("not registered")
