from __future__ import annotations

import pytest
from required_database import source_database_url

URL = "postgres://workhorse:workhorse@localhost:5432/workhorse_test"


@pytest.mark.parametrize(
    "environ",
    [
        {"CI": "true"},
        {"CI": "true", "DATABASE_URL_TEST": ""},
        {"WORKHORSE_REQUIRE_DATABASE": "1"},
        {"WORKHORSE_REQUIRE_DATABASE": "1", "DATABASE_URL_TEST": ""},
        {"CI": "yes"},
        {"WORKHORSE_REQUIRE_DATABASE": "yes"},
        {"CI": "true", "WORKHORSE_REQUIRE_DATABASE": "0"},
        {"CI": "false", "WORKHORSE_REQUIRE_DATABASE": "1"},
    ],
)
def test_required_run_fails_without_database_url(environ: dict[str, str]) -> None:
    with pytest.raises(pytest.fail.Exception, match="requires PostgreSQL"):
        source_database_url(environ)


@pytest.mark.parametrize(
    "environ",
    [
        {},
        {"DATABASE_URL_TEST": ""},
        {"CI": "", "WORKHORSE_REQUIRE_DATABASE": "0"},
        {"CI": "false", "WORKHORSE_REQUIRE_DATABASE": "false"},
    ],
)
def test_optional_run_skips_without_database_url(environ: dict[str, str]) -> None:
    with pytest.raises(pytest.skip.Exception, match="DATABASE_URL_TEST is required"):
        source_database_url(environ)


@pytest.mark.parametrize("environ", [{}, {"CI": "true"}, {"WORKHORSE_REQUIRE_DATABASE": "1"}])
def test_database_url_is_returned_when_set(environ: dict[str, str]) -> None:
    assert source_database_url({**environ, "DATABASE_URL_TEST": URL}) == URL
