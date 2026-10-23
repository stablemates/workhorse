from __future__ import annotations
# ruff: noqa

import functools
import hashlib
import os
import subprocess
import sys
import time
from collections.abc import Iterator
from datetime import UTC, datetime
from pathlib import Path
from urllib.parse import SplitResult, urlsplit, urlunsplit

import asyncpg
import psycopg
import pytest
import pytest_asyncio
from psycopg_pool import AsyncConnectionPool, ConnectionPool

from distributions import BUILD_CONSTRAINTS, install_distribution
from required_database import source_database_url


def pytest_collection_modifyitems(items: list[pytest.Item]) -> None:
    """Keep every test that provisions PostgreSQL out of the fast unit lane.

    Under ``pytest -n --dist loadgroup``, also send every test that uses the built distributions
    to one worker process, so that only one process builds and installs them.
    """
    for item in items:
        fixtures = getattr(item, "fixturenames", ())
        if "database_url" in fixtures:
            item.add_marker(pytest.mark.integration)
        if "built_distributions" in fixtures:
            item.add_marker(pytest.mark.xdist_group("built_distributions"))


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
            (f"{distribution}-django", "django"),
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
    source = source_database_url(os.environ)
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
        template_name = ensure_schema_template(admin, parsed)
        drop_scratch_database(admin, database_name)
        admin.execute(f'CREATE DATABASE "{database_name}" TEMPLATE "{template_name}"')
    try:
        with psycopg.connect(isolated_url, autocommit=True) as connection:
            connection.execute(REFRESH_INSTALL_CLOCK)
        yield isolated_url
    finally:
        with psycopg.connect(admin_url, autocommit=True) as admin:
            try:
                drop_scratch_database(admin, database_name)
            except psycopg.Error as error:
                raise RuntimeError(
                    f"could not drop scratch database {database_name}; run pnpm db:sweep"
                ) from error


SCHEMA = REPOSITORY / "sql/schema/current.sql"

# Shared with `typescript/core/test/support/schema-template.ts`. Both suites install the same
# `current.sql`, so they share one template, and `pnpm db:sweep` keeps it and retires the others.
SCHEMA_TEMPLATE_PREFIX = "workhorse_test_template_"

# The install seeds these values from the clock. A copy of the template has the values of the
# moment the template was built, so set them again as `current.sql` sets them. The list holds
# every seeded row with a `clock_timestamp()` default and every clock-derived seed value.
REFRESH_INSTALL_CLOCK = """
UPDATE workhorse.schema_version SET installed_at = clock_timestamp();
UPDATE workhorse.schema_migration SET applied_at = clock_timestamp();
UPDATE workhorse.protocol_version SET recorded_at = clock_timestamp();
UPDATE workhorse.maintenance_policy SET updated_at = clock_timestamp();
UPDATE workhorse.queue_health_policy SET updated_at = clock_timestamp();
UPDATE workhorse.maintenance_state SET updated_at = clock_timestamp();
UPDATE workhorse.cold_export_policy SET updated_at = clock_timestamp();
UPDATE workhorse.retention_policy SET updated_at = clock_timestamp();
UPDATE workhorse.task_stat_state
   SET updated_at = clock_timestamp(),
       rolled_up_through = date_bin(
         '1 minute', clock_timestamp(), timestamp '2000-01-01' AT TIME ZONE 'UTC'
       ),
       hourly_rolled_up_through = date_bin(
         '1 hour', clock_timestamp(), timestamp '2000-01-01' AT TIME ZONE 'UTC'
       ),
       daily_rolled_up_through = date_bin(
         '1 day', clock_timestamp(), timestamp '2000-01-01' AT TIME ZONE 'UTC'
       )
 WHERE singleton;
UPDATE workhorse.maintenance_state
   SET history_retained_before = date_trunc('day', clock_timestamp() AT TIME ZONE 'UTC')
         AT TIME ZONE 'UTC' - interval '14 days'
 WHERE routine_name = 'history_retention';
SELECT workhorse.create_history_day_v1(
         ((clock_timestamp() AT TIME ZONE 'UTC')::date + day_offset)::date
       )
  FROM workhorse.maintenance_policy policy
  CROSS JOIN generate_series(
    0, workhorse.history_partition_horizon_days_v1(policy.partition_preparation_interval_ms)
  ) AS days(day_offset)
 WHERE policy.singleton;
"""


@functools.cache
def schema_digest() -> str:
    return hashlib.sha256(SCHEMA.read_bytes()).hexdigest()[:16]


def schema_template_name() -> str:
    """The name `schemaTemplateName` gives the current schema on the current UTC day."""
    utc_day = datetime.now(UTC).strftime("%Y%m%d")
    return f"{SCHEMA_TEMPLATE_PREFIX}{schema_digest()}_{utc_day}"


def ensure_schema_template(admin: psycopg.Connection, source: SplitResult) -> str:
    """Install ``current.sql`` once into a template database, as ``ensureSchemaTemplate`` does.

    A copy of the template costs much less than a new install of the 1 MB schema in each test.
    The advisory lock and the staging name let a TypeScript run build the same template at the
    same time: the first builder renames a complete staging database, and the other one reuses it.
    """
    name = schema_template_name()
    staging_name = f"{name}_building"
    admin.execute("SELECT pg_advisory_lock(hashtextextended(%s, 0))", (name,))
    try:
        existing = admin.execute("SELECT 1 FROM pg_database WHERE datname = %s", (name,))
        if existing.fetchone() is not None:
            return name
        drop_scratch_database(admin, staging_name)
        admin.execute(f'CREATE DATABASE "{staging_name}"')
        try:
            with psycopg.connect(
                urlunsplit(source._replace(path=f"/{staging_name}")), autocommit=True
            ) as staging:
                staging.execute(SCHEMA.read_text())
        except BaseException:
            drop_scratch_database(admin, staging_name)
            raise
        admin.execute(f'ALTER DATABASE "{staging_name}" RENAME TO "{name}"')
        return name
    finally:
        admin.execute("SELECT pg_advisory_unlock(hashtextextended(%s, 0))", (name,))


# Drop attempts before giving up. PostgreSQL waits a few seconds inside each attempt for other
# sessions to exit, so the bound is a count rather than a deadline.
SCRATCH_DROP_ATTEMPTS = 10


def drop_scratch_database(admin: psycopg.Connection, name: str) -> None:
    """Drop ``name`` without ``WITH (FORCE)``, waiting out sessions the test role does not own.

    FORCE signals sessions of every role, which the test role may not do to autovacuum. Terminate
    only this role's sessions, then retry while foreign sessions still hold the database.
    """
    for attempt in range(1, SCRATCH_DROP_ATTEMPTS + 1):
        admin.execute(
            "SELECT pg_terminate_backend(pid) FROM pg_stat_activity "
            "WHERE datname = %s AND usename = current_user AND pid <> pg_backend_pid()",
            (name,),
        )
        try:
            admin.execute(f'DROP DATABASE IF EXISTS "{name}"')
            return
        except psycopg.errors.ObjectInUse:
            if attempt == SCRATCH_DROP_ATTEMPTS:
                raise
        time.sleep(0.1)


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
