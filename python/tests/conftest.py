from __future__ import annotations

import hashlib
import os
from collections.abc import Iterator
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit

import psycopg
import pytest

REPOSITORY = Path(__file__).parents[2]


@pytest.fixture
def database_url(request: pytest.FixtureRequest) -> Iterator[str]:
    source = os.environ.get("WORKHORSE_TEST_DATABASE_URL")
    if source is None:
        pytest.skip("WORKHORSE_TEST_DATABASE_URL is required for integration tests")
    parsed = urlsplit(source)
    if parsed.hostname not in {"localhost", "127.0.0.1", "::1"}:
        pytest.fail("Python integration tests refuse a non-loopback database")
    source_name = parsed.path.removeprefix("/")
    if "test" not in source_name:
        pytest.fail("WORKHORSE_TEST_DATABASE_URL must name a test database")
    digest = hashlib.sha256(f"{request.node.nodeid}\0{os.getpid()}".encode()).hexdigest()[:10]
    database_name = f"{source_name[:45]}_py_{digest}"
    admin_url = urlunsplit(parsed._replace(path="/postgres"))
    isolated_url = urlunsplit(parsed._replace(path=f"/{database_name}"))
    with psycopg.connect(admin_url, autocommit=True) as admin:
        admin.execute(f'DROP DATABASE IF EXISTS "{database_name}"')
        admin.execute(f'CREATE DATABASE "{database_name}"')
    try:
        with psycopg.connect(isolated_url, autocommit=True) as connection:
            connection.execute((REPOSITORY / "sql/schema.sql").read_text())
        yield isolated_url
    finally:
        with psycopg.connect(admin_url, autocommit=True) as admin:
            admin.execute(
                "SELECT pg_terminate_backend(pid) FROM pg_stat_activity "
                "WHERE datname = %s AND usename = current_user AND pid <> pg_backend_pid()",
                (database_name,),
            )
            admin.execute(f'DROP DATABASE IF EXISTS "{database_name}"')
