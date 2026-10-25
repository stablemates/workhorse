"""The schema template lock that keeps ``pnpm db:sweep`` away from a copy in progress."""

from __future__ import annotations

import hashlib
import os
import secrets
from collections.abc import Iterator
from urllib.parse import urlsplit, urlunsplit

import conftest
import psycopg
import pytest
from required_database import source_database_url

pytestmark = pytest.mark.integration


@pytest.fixture
def admin_and_source() -> Iterator[tuple[psycopg.Connection, str, str]]:
    source = source_database_url(os.environ)
    parsed = urlsplit(source)
    if parsed.hostname not in {"localhost", "127.0.0.1", "::1"}:
        pytest.fail("Python integration tests refuse a non-loopback database")
    admin_url = urlunsplit(parsed._replace(path="/postgres"))
    with psycopg.connect(admin_url, autocommit=True) as admin:
        yield admin, admin_url, source


def test_sweep_cannot_take_the_template_lock_during_the_copy(
    admin_and_source: tuple[psycopg.Connection, str, str], monkeypatch: pytest.MonkeyPatch
) -> None:
    admin, admin_url, source = admin_and_source
    parsed = urlsplit(source)
    # A template of this test only, so the test never touches a template a checkout uses.
    template = f"{conftest.SCHEMA_TEMPLATE_PREFIX}{secrets.token_hex(8)}_00000000"
    digest = hashlib.sha256(f"{template}\0{os.getpid()}".encode()).hexdigest()[:10]
    target = f"{parsed.path.removeprefix('/')[:45]}_py_{digest}"
    monkeypatch.setattr(conftest, "schema_template_name", lambda: template)

    sweep_locked: list[bool] = []
    drop_scratch_database = conftest.drop_scratch_database

    def drop_then_sweep(connection: psycopg.Connection, name: str) -> None:
        drop_scratch_database(connection, name)
        if name != target:
            return
        # The harness drops the target right before `CREATE DATABASE ... TEMPLATE`, after its
        # existence check. The sweep takes this lock with no wait before it drops a template.
        with psycopg.connect(admin_url, autocommit=True) as sweep:
            row = sweep.execute(
                "SELECT pg_try_advisory_lock(hashtextextended(%s, 0))", (template,)
            ).fetchone()
            assert row is not None
            sweep_locked.append(row[0])
            if row[0]:
                sweep.execute("SELECT pg_advisory_unlock(hashtextextended(%s, 0))", (template,))

    monkeypatch.setattr(conftest, "drop_scratch_database", drop_then_sweep)
    admin.execute(f'CREATE DATABASE "{template}"')
    try:
        conftest.copy_schema_template(admin, parsed, target)

        assert sweep_locked == [False]
        exists = admin.execute("SELECT 1 FROM pg_database WHERE datname = %s", (target,))
        assert exists.fetchone() is not None
    finally:
        drop_scratch_database(admin, target)
        drop_scratch_database(admin, template)


def test_sweep_cannot_take_the_lease_of_a_live_scratch_database(database_url: str) -> None:
    # No session of the test is on the scratch database now. The sweep takes this lock with no
    # wait before it drops a scratch database, so the lease of the fixture must make it fail.
    parsed = urlsplit(database_url)
    name = parsed.path.removeprefix("/")
    with psycopg.connect(urlunsplit(parsed._replace(path="/postgres")), autocommit=True) as sweep:
        row = sweep.execute(
            "SELECT pg_try_advisory_lock(hashtextextended(%s, 0))", (name,)
        ).fetchone()
        assert row is not None
        if row[0]:
            sweep.execute("SELECT pg_advisory_unlock(hashtextextended(%s, 0))", (name,))
        assert row[0] is False
