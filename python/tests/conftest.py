from __future__ import annotations

import hashlib
import os
import subprocess
import sys
from collections.abc import Iterator
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit

import psycopg
import pytest

REPOSITORY = Path(__file__).parents[2]


@pytest.fixture(scope="session")
def installed_distribution_interpreters(
    tmp_path_factory: pytest.TempPathFactory,
) -> dict[str, Path]:
    scratch = tmp_path_factory.mktemp("python-distributions")
    distribution_directory = scratch / "dist"
    subprocess.run(
        [
            "uv",
            "build",
            "--project",
            str(REPOSITORY / "python"),
            "--out-dir",
            str(distribution_directory),
        ],
        check=True,
        cwd=REPOSITORY,
    )
    artifacts = {
        "wheel": next(distribution_directory.glob("*.whl")),
        "sdist": next(distribution_directory.glob("*.tar.gz")),
    }
    interpreters: dict[str, Path] = {}
    for distribution, artifact in artifacts.items():
        environments = (
            (distribution, None),
            (f"{distribution}-psycopg", "psycopg"),
            (f"{distribution}-asyncpg", "asyncpg"),
        )
        for name, extras in environments:
            environment_directory = scratch / f"{name}-environment"
            subprocess.run(
                ["uv", "venv", str(environment_directory), "--python", sys.executable],
                check=True,
                cwd=REPOSITORY,
            )
            installed_python = environment_directory / "bin" / "python"
            subprocess.run(
                [
                    "uv",
                    "pip",
                    "install",
                    "--python",
                    str(installed_python),
                    f"{artifact}[{extras}]" if extras else str(artifact),
                ],
                check=True,
                cwd=REPOSITORY,
            )
            interpreters[name] = installed_python
    return interpreters


@pytest.fixture
def database_url(request: pytest.FixtureRequest) -> Iterator[str]:
    source = os.environ.get("DATABASE_URL_TEST")
    if source is None:
        pytest.skip("DATABASE_URL_TEST is required for integration tests")
    parsed = urlsplit(source)
    if parsed.hostname not in {"localhost", "127.0.0.1", "::1"}:
        pytest.fail("Python integration tests refuse a non-loopback database")
    source_name = parsed.path.removeprefix("/")
    if "test" not in source_name:
        pytest.fail("DATABASE_URL_TEST must name a test database")
    digest = hashlib.sha256(f"{request.node.nodeid}\0{os.getpid()}".encode()).hexdigest()[:10]
    database_name = f"{source_name[:45]}_py_{digest}"
    admin_url = urlunsplit(parsed._replace(path="/postgres"))
    isolated_url = urlunsplit(parsed._replace(path=f"/{database_name}"))
    with psycopg.connect(admin_url, autocommit=True) as admin:
        admin.execute(f'DROP DATABASE IF EXISTS "{database_name}"')
        admin.execute(f'CREATE DATABASE "{database_name}"')
    try:
        with psycopg.connect(isolated_url, autocommit=True) as connection:
            connection.execute((REPOSITORY / "sql/schema/current.sql").read_text())
        yield isolated_url
    finally:
        with psycopg.connect(admin_url, autocommit=True) as admin:
            admin.execute(
                "SELECT pg_terminate_backend(pid) FROM pg_stat_activity "
                "WHERE datname = %s AND usename = current_user AND pid <> pg_backend_pid()",
                (database_name,),
            )
            admin.execute(f'DROP DATABASE IF EXISTS "{database_name}"')
