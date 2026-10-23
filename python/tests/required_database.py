"""Decide whether a PostgreSQL test runs, skips, or fails when ``DATABASE_URL_TEST`` is missing.

A local run without a database skips the database tests. CI, or ``WORKHORSE_REQUIRE_DATABASE=1``,
turns that skip into a failure, so a CI job that loses its database URL cannot report a pass. The
Rust, Ruby, JVM, and Go test helpers use the same rule. The .NET helper reads the two variables in
a different way.
"""

from __future__ import annotations

from collections.abc import Mapping

import pytest

REQUIRED_DATABASE_KEYS = ("CI", "WORKHORSE_REQUIRE_DATABASE")


def database_required(environ: Mapping[str, str]) -> bool:
    """Return whether ``CI`` or ``WORKHORSE_REQUIRE_DATABASE`` has a value other than off."""
    return any(environ.get(key, "") not in {"", "0", "false"} for key in REQUIRED_DATABASE_KEYS)


def source_database_url(environ: Mapping[str, str]) -> str:
    """Return ``DATABASE_URL_TEST``, or skip or fail the test when it is absent or empty."""
    source = environ.get("DATABASE_URL_TEST", "")
    if source:
        return source
    if database_required(environ):
        pytest.fail(
            "DATABASE_URL_TEST is unset, but this run requires PostgreSQL"
            " (CI or WORKHORSE_REQUIRE_DATABASE=1)"
        )
    pytest.skip("DATABASE_URL_TEST is required for integration tests")
