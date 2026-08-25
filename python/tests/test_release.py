from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path
from typing import Any

import psycopg
import tomli


def _repository_file(*parts: str) -> str:
    repository = Path(__file__).parents[2]
    return repository.joinpath(*parts).read_text()


def _repository_json(*parts: str) -> dict[str, Any]:
    return json.loads(_repository_file(*parts))


def _repository_toml(*parts: str) -> dict[str, Any]:
    return tomli.loads(_repository_file(*parts))


def test_python_support_contract_matches_repository_declarations(database_url: str) -> None:
    manifest = _repository_toml("python", "pyproject.toml")
    support = _repository_json("support.json")["support"]
    python_support = support["python"]
    project = manifest["project"]
    classifier_prefix = "Programming Language :: Python :: "
    classifiers = [
        classifier.removeprefix(classifier_prefix)
        for classifier in project["classifiers"]
        if classifier.startswith(classifier_prefix)
        and classifier != f"{classifier_prefix}3 :: Only"
    ]

    assert project["requires-python"] == f">={python_support['minimum']}"
    assert classifiers == python_support["tested"]
    current_python = f"{sys.version_info.major}.{sys.version_info.minor}"
    assert current_python in classifiers
    assert manifest["tool"]["mypy"]["python_version"] == python_support["minimum"]
    assert manifest["tool"]["ruff"]["target-version"] == (
        f"py{python_support['minimum'].replace('.', '')}"
    )
    assert "worker SDK" in project["description"]
    assert project["dependencies"] == [
        "jsonschema>=4.25,<5",
        "psycopg>=3.3,<4",
        "typing-extensions>=4.12,<5",
    ]
    assert project["optional-dependencies"]["psycopg"] == []
    assert project["optional-dependencies"]["asyncpg"] == ["asyncpg>=0.31,<1"]
    assert project["name"] == "stablemates-workhorse"
    assert project["version"] == "0.1.0a1"

    postgres_majors = [str(major) for major in support["postgres"]["tested"]]

    with psycopg.connect(database_url) as connection:
        version_number = connection.execute(
            "SELECT current_setting('server_version_num')::integer"
        ).fetchone()
    assert version_number is not None
    assert str(version_number[0] // 10_000) in postgres_majors


def test_built_distributions_run_the_documented_examples(
    database_url: str,
    tmp_path: Path,
    installed_distribution_interpreters: dict[str, Path],
) -> None:
    repository = Path(__file__).parents[2]
    environment = os.environ.copy()
    environment.pop("PYTHONPATH", None)
    result = subprocess.run(
        [
            str(installed_distribution_interpreters["wheel"]),
            str(repository / "python" / "examples" / "lifecycle.py"),
            database_url,
        ],
        check=False,
        cwd=tmp_path,
        env=environment,
        capture_output=True,
        text=True,
        timeout=20,
    )
    assert result.returncode == 0, result.stderr
    assert result.stdout.strip() == "Python lifecycle example completed"

    async_result = subprocess.run(
        [
            str(installed_distribution_interpreters["sdist-asyncpg"]),
            str(repository / "python" / "examples" / "async_enqueue.py"),
            database_url,
        ],
        check=False,
        cwd=tmp_path,
        env=environment,
        capture_output=True,
        text=True,
        timeout=20,
    )
    assert async_result.returncode == 0, async_result.stderr
    assert async_result.stdout.strip() == "Python async driver example completed"

    for distribution in ("wheel", "sdist"):
        for driver in ("psycopg", "asyncpg"):
            interpreter = installed_distribution_interpreters[f"{distribution}-{driver}"]
            import_result = subprocess.run(
                [
                    str(interpreter),
                    "-c",
                    (
                        "from workhorse import Admin, AdminAudit, AsyncAdmin, "
                        "ConcurrencyPolicyDefinition, RateLimit, RateLimitPolicyDefinition"
                    ),
                ],
                check=False,
                cwd=tmp_path,
                env=environment,
                capture_output=True,
                text=True,
                timeout=20,
            )
            assert import_result.returncode == 0, import_result.stderr
            worker_result = subprocess.run(
                [
                    str(interpreter),
                    str(repository / "python" / "examples" / "async_worker.py"),
                    database_url,
                    driver,
                ],
                check=False,
                cwd=tmp_path,
                env=environment,
                capture_output=True,
                text=True,
                timeout=20,
            )
            assert worker_result.returncode == 0, worker_result.stderr
            assert worker_result.stdout.strip() == (
                f"Python {driver} async worker example completed"
            )
