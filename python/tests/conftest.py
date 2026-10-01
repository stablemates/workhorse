from __future__ import annotations
# ruff: noqa

import hashlib
import os
import subprocess
import sys
from collections.abc import Iterator
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit

import asyncpg
import psycopg
import pytest
import pytest_asyncio
from psycopg_pool import AsyncConnectionPool, ConnectionPool

from distributions import BUILD_CONSTRAINTS, install_distribution


def pytest_collection_modifyitems(items: list[pytest.Item]) -> None:
    """Keep every test that provisions PostgreSQL out of the fast unit lane."""
    for item in items:
        if "database_url" in getattr(item, "fixturenames", ()):
            item.add_marker(pytest.mark.integration)


REPOSITORY = Path(__file__).parents[2]


@pytest.fixture(scope="session")
def built_distributions(tmp_path_factory: pytest.TempPathFactory) -> dict[str, Path]:
    scratch = tmp_path_factory.mktemp("python-distributions")
    configured_distributions = os.environ.get("WORKHORSE_PYTHON_DISTRIBUTIONS")
    if configured_distributions:
        distribution_directory = Path(configured_distributions)
        if not distribution_directory.is_absolute():
            distribution_directory = REPOSITORY / distribution_directory
    else:
        distribution_directory = scratch / "dist"
        subprocess.run(
            [
                "uv",
                "build",
                "--project",
                str(REPOSITORY / "python"),
                "--build-constraints",
                str(BUILD_CONSTRAINTS),
                "--require-hashes",
                "--out-dir",
                str(distribution_directory),
            ],
            check=True,
            cwd=REPOSITORY,
        )
    return {
        "wheel": next(distribution_directory.glob("*.whl")),
        "sdist": next(distribution_directory.glob("*.tar.gz")),
    }


@pytest.fixture(scope="session")
def installed_distribution_interpreters(
    tmp_path_factory: pytest.TempPathFactory, built_distributions: dict[str, Path]
) -> dict[str, Path]:
    scratch = tmp_path_factory.mktemp("python-environments")
    interpreters: dict[str, Path] = {}
    for distribution, artifact in built_distributions.items():
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
            install_distribution(artifact, installed_python, extras, scratch)
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


@pytest.fixture
def worker_pool(database_url: str) -> Iterator[ConnectionPool]:
    """A real pooled worker resource for integration tests."""
    with ConnectionPool(
        database_url, min_size=3, max_size=3, kwargs={"autocommit": True}, open=True
    ) as pool:
        yield pool


@pytest.fixture(autouse=True)
def _install_worker_pool(request: pytest.FixtureRequest) -> Iterator[None]:
    """Expose the per-test pool to legacy tests while they migrate call sites."""
    if "database_url" not in request.fixturenames:
        yield
        return
    pool = request.getfixturevalue("worker_pool")
    request.module.worker_pool = pool
    try:
        yield
    finally:
        if getattr(request.module, "worker_pool", None) is pool:
            delattr(request.module, "worker_pool")


@pytest_asyncio.fixture
async def async_psycopg_pool(database_url: str) -> AsyncConnectionPool:
    async with AsyncConnectionPool(
        database_url, min_size=3, max_size=3, kwargs={"autocommit": True}, open=True
    ) as pool:
        yield pool


@pytest_asyncio.fixture
async def asyncpg_pool(database_url: str) -> asyncpg.Pool:
    pool = await asyncpg.create_pool(database_url, min_size=3, max_size=3)
    try:
        yield pool
    finally:
        await pool.close()
