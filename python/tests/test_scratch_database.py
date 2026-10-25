"""The scratch database that the ``database_url`` fixture copies for each test."""

from __future__ import annotations

import psycopg
import pytest

pytestmark = pytest.mark.integration


def test_commits_without_waiting_for_the_wal_flush(database_url: str) -> None:
    # A host I/O stall can make a WAL flush take seconds, so a commit in a test does not wait for
    # it (SM-1809). A new session of the scratch database takes the setting.
    with psycopg.connect(database_url) as connection:
        row = connection.execute("SHOW synchronous_commit").fetchone()
    assert row == ("off",)
