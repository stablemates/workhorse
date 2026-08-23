from __future__ import annotations

import os
import re
import subprocess
import sys
from pathlib import Path

import psycopg


def _repository_file(*parts: str) -> str:
    repository = Path(__file__).parents[2]
    return repository.joinpath(*parts).read_text()


def _supported_postgres_majors() -> list[str]:
    support_source = _repository_file("typescript", "core", "src", "support.ts")
    match = re.search(
        r"SUPPORTED_POSTGRES_MAJORS: readonly number\[\] = \[([^]]+)]",
        support_source,
    )
    assert match is not None
    return [major.strip() for major in match.group(1).split(",")]


def test_python_support_contract_matches_repository_declarations(database_url: str) -> None:
    manifest = _repository_file("python", "pyproject.toml")
    readme = _repository_file("python", "README.md")
    compatibility = _repository_file("docs", "compatibility.md")
    package_manifest = _repository_file("package.json")

    python_minimum = re.search(r'requires-python = ">=([0-9]+\.[0-9]+)"', manifest)
    classifiers = re.findall(r'"Programming Language :: Python :: ([0-9]+\.[0-9]+)"', manifest)
    assert python_minimum is not None
    assert classifiers == ["3.10", "3.11", "3.12", "3.13", "3.14"]
    assert python_minimum.group(1) == classifiers[0]
    current_python = f"{sys.version_info.major}.{sys.version_info.minor}"
    assert current_python in classifiers
    package_description = re.search(r'^description = "([^"]+)"$', manifest, re.MULTILINE)
    assert package_description is not None
    assert "worker SDK" in package_description.group(1)

    postgres_majors = _supported_postgres_majors()
    assert f"PostgreSQL {', '.join(postgres_majors)}" in readme
    assert re.search(r"Python\s+\| 3\.10.3\.14", compatibility)
    assert 'psycopg = ["psycopg>=3.3,<4"]' in manifest
    assert 'asyncpg = ["asyncpg>=0.31,<1"]' in manifest
    assert "Psycopg 3.3 through the next major" in readme
    assert re.search(r"asyncpg 0\.31 through\s+the next major", readme)
    assert 'pip install "workhorse-pg[psycopg]"' in readme
    assert "run_worker_process(worker)" in readme
    assert 'workhorse dashboard --database-url "$DATABASE_URL"' in readme
    assert (
        '"python:test": "tsx scripts/with-env.ts uv run --project python pytest python/tests"'
        in package_manifest
    )

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
            str(installed_distribution_interpreters["sdist"]),
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
