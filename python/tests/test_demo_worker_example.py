from __future__ import annotations

import importlib.util
from pathlib import Path
from types import SimpleNamespace
from typing import cast

import pytest

from workhorse import HandlerContext

module_spec = importlib.util.spec_from_file_location(
    "demo_worker", Path(__file__).parents[1] / "examples" / "demo_worker.py"
)
assert module_spec is not None and module_spec.loader is not None
demo_worker = importlib.util.module_from_spec(module_spec)
module_spec.loader.exec_module(demo_worker)


def test_worker_uses_dedicated_and_shared_queues() -> None:
    assert (demo_worker.PYTHON_QUEUE, demo_worker.SHARED_QUEUE) == (
        "demo-python",
        "demo-shared",
    )


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


def test_language_job_identifies_python_runtime() -> None:
    context = cast(HandlerContext, SimpleNamespace(job=SimpleNamespace(attempt=2)))

    assert demo_worker.language_job({"language": "python"}, context) == {
        "language": "python",
        "runtime": "python",
        "attempt": 2,
    }


def test_language_job_refuses_another_runtime() -> None:
    context = cast(HandlerContext, SimpleNamespace(job=SimpleNamespace(attempt=1)))

    with pytest.raises(ValueError, match="another language"):
        demo_worker.language_job({"language": "go"}, context)


def test_shared_job_identifies_python_runtime() -> None:
    context = cast(HandlerContext, SimpleNamespace(job=SimpleNamespace(attempt=3)))

    assert demo_worker.shared_job({"source": "schedule"}, context) == {
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
