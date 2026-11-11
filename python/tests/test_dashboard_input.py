from __future__ import annotations

import io
import json
import re
from collections.abc import Iterable
from typing import Any, cast

import psycopg
import pytest

from workhorse.dashboard import DashboardHost, DashboardPrincipal
from workhorse.dashboard_v1 import (
    _INPUT_SCHEMAS,
    DashboardInputValidationError,
    _ecma_pattern,
    validate_input,
)

TASK_ID = "00000000-0000-4000-8000-00000000dead"
AUDIT = {"actor": "operator", "reason": "test", "requestId": "request-1"}


class _Connection:
    autocommit = True

    def cursor(self, **_options: object) -> object:
        raise AssertionError("the input test must not query PostgreSQL")


def _post(host: DashboardHost, procedure: str, input_value: object) -> tuple[int, Any]:
    payload = json.dumps({"json": input_value}).encode()
    environ: dict[str, object] = {
        "REQUEST_METHOD": "POST",
        "PATH_INFO": f"/workhorse/rpc/dashboard/{procedure}",
        "wsgi.url_scheme": "https",
        "HTTP_HOST": "example.test",
        "HTTP_ORIGIN": "https://example.test",
        "CONTENT_LENGTH": str(len(payload)),
        "CONTENT_TYPE": "application/json",
        "wsgi.input": io.BytesIO(payload),
    }
    captured: dict[str, object] = {}

    def start_response(status: str, _headers: list[tuple[str, str]]) -> None:
        captured["status"] = int(status.split(maxsplit=1)[0])

    body = b"".join(cast(Iterable[bytes], host(environ, start_response)))
    return cast(int, captured["status"]), json.loads(body)


def _host(**procedures: object) -> DashboardHost:
    return DashboardHost(
        cast(object, _Connection()),
        authorize=lambda _: DashboardPrincipal("operator"),
        _procedures=cast(Any, procedures),
        _skip_compatibility_check=True,
    )


def _patterns(schema: object) -> Iterable[str]:
    if isinstance(schema, dict):
        if isinstance(schema.get("pattern"), str):
            yield schema["pattern"]
        for child in schema.values():
            yield from _patterns(child)
    elif isinstance(schema, list):
        for child in schema:
            yield from _patterns(child)


def _maintenance(local_time: str) -> dict[str, object]:
    return {"definition": {"historyRetentionLocalTime": local_time}, "audit": AUDIT}


def test_a_task_identity_with_a_final_line_feed_does_not_match() -> None:
    validate_input("taskDetail", {"id": TASK_ID})
    with pytest.raises(DashboardInputValidationError):
        validate_input("taskDetail", {"id": TASK_ID + "\n"})


@pytest.mark.parametrize("local_time", ["12:30\n", "1٢:30", "١٢:30"])
def test_a_local_time_with_a_final_line_feed_or_a_non_ascii_digit_does_not_match(
    local_time: str,
) -> None:
    validate_input("overrideMaintenancePolicy", _maintenance("12:30"))
    with pytest.raises(DashboardInputValidationError):
        validate_input("overrideMaintenancePolicy", _maintenance(local_time))


def test_no_contract_pattern_matches_before_a_final_line_feed_or_takes_a_non_ascii_digit() -> None:
    # An ECMA-262 dollar sign matches only at the end of the string, and its digit class has
    # only ASCII digits. Each anchored pattern of the contract must keep both rules.
    patterns = set(_patterns(_INPUT_SCHEMAS))
    assert patterns
    for source in patterns:
        compiled = _ecma_pattern(source)
        assert compiled.flags & re.ASCII, source
        assert "$" not in compiled.pattern.replace("\\$", ""), source


def test_the_host_answers_400_for_a_task_identity_with_a_final_line_feed() -> None:
    def task_detail(_input: object, _actor: str) -> object:
        raise AssertionError("an input that does not match must not reach SQL")

    status, body = _post(_host(taskDetail=task_detail), "taskDetail", {"id": TASK_ID + "\n"})

    assert status == 400
    assert body["json"]["code"] == "BAD_REQUEST"


def test_the_host_drops_an_undeclared_key_before_the_procedure() -> None:
    received: list[object] = []

    def system(input_value: object, _actor: str) -> object:
        received.append(input_value)
        return {}

    status, _ = _post(_host(system=system), "system", {"window": "1h", "health": {}})

    assert status == 200
    assert received == [{"window": "1h"}]


def test_the_host_keeps_every_key_of_a_free_json_value() -> None:
    received: list[object] = []

    def signal_task(input_value: object, _actor: str) -> object:
        received.append(input_value)
        return {}

    request = {
        "id": TASK_ID,
        "name": "approval",
        "payload": {"health": {}, "nested": {"anyKey": [1]}},
        "idempotencyKey": "key-1",
        "audit": AUDIT,
        "undeclared": True,
    }
    status, _ = _post(_host(signalTask=signal_task), "signalTask", request)

    assert status == 200
    sent = {key: value for key, value in request.items() if key != "undeclared"}
    assert received == [{**sent, "audit": {**AUDIT, "actor": "operator"}}]


def test_the_host_drops_an_undeclared_key_of_a_nested_object() -> None:
    received: list[object] = []

    def tasks_cursor(input_value: object, _actor: str) -> object:
        received.append(input_value)
        return {}

    declared = {"id": TASK_ID, "updatedAt": "2026-09-30T09:00:00.000000Z", "priority": 0}
    cursor = {**declared, "extra": 1}
    status, _ = _post(_host(tasksCursor=tasks_cursor), "tasksCursor", {"cursor": cursor})

    assert status == 200, received
    assert received == [{"cursor": declared}]


@pytest.mark.parametrize("timeout", [0, -1, 1.5, True])
def test_the_host_refuses_a_statement_timeout_that_is_not_a_positive_integer(
    timeout: object,
) -> None:
    with pytest.raises(ValueError, match="statement_timeout_ms"):
        DashboardHost(
            cast(object, _Connection()),
            authorize=lambda _: True,
            statement_timeout_ms=cast(int, timeout),
        )


def _show_statement_timeout(connection: psycopg.Connection[Any]) -> str:
    row = connection.execute("SHOW statement_timeout").fetchone()
    assert row is not None
    return cast(str, row[0])


@pytest.mark.integration
def test_the_host_owns_the_transaction_of_a_read_on_an_idle_connection(database_url: str) -> None:
    with psycopg.connect(database_url, autocommit=True) as connection:
        host = DashboardHost(
            connection,
            authorize=lambda _: DashboardPrincipal("operator"),
            statement_timeout_ms=1234,
        )
        before = _show_statement_timeout(connection)

        status, body = _post(host, "queues", None)

        assert status == 200, body
        # The host ended its own transaction, and its local setting ended with it.
        assert connection.info.transaction_status == psycopg.pq.TransactionStatus.IDLE
        assert _show_statement_timeout(connection) == before


@pytest.mark.integration
def test_a_read_inside_a_caller_transaction_commits_nothing(database_url: str) -> None:
    with psycopg.connect(database_url, autocommit=True) as connection:
        host = DashboardHost(
            connection,
            authorize=lambda _: DashboardPrincipal("operator"),
            statement_timeout_ms=1234,
        )
        connection.execute("CREATE TEMPORARY TABLE caller_transaction_marker (id integer)")
        before = _show_statement_timeout(connection)
        with pytest.raises(_Rollback), connection.transaction():
            connection.execute("INSERT INTO caller_transaction_marker VALUES (1)")

            status, body = _post(host, "queues", None)

            assert status == 200, body
            # The read ran inside the caller's transaction with no bound and did not end it.
            assert connection.info.transaction_status == psycopg.pq.TransactionStatus.INTRANS
            assert _show_statement_timeout(connection) == before
            raise _Rollback
        row = connection.execute("SELECT count(*) FROM caller_transaction_marker").fetchone()
        assert row == (0,)


@pytest.mark.integration
def test_a_caller_timeout_that_cancels_a_read_answers_timeout(database_url: str) -> None:
    with psycopg.connect(database_url, autocommit=True) as connection:
        host = DashboardHost(connection, authorize=lambda _: DashboardPrincipal("operator"))
        assert _post(host, "meta", None)[0] == 200
        with pytest.raises(_Rollback), connection.transaction():
            # The slow read exists only inside this transaction, so other tests never see it.
            connection.execute(
                """
                ALTER FUNCTION workhorse.dashboard_events_v1(jsonb)
                  RENAME TO dashboard_events_v1_before_slow_read;
                CREATE FUNCTION workhorse.dashboard_events_v1(p_input jsonb) RETURNS jsonb
                  LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(5); RETURN '{}'::jsonb; END $$;
                SET LOCAL statement_timeout = '50ms';
                """
            )

            status, body = _post(host, "events", {"window": "1h"})

            assert status == 408, body
            assert body["json"]["code"] == "TIMEOUT"
            # PostgreSQL aborted the caller's transaction; the host did not roll it back.
            assert connection.info.transaction_status == psycopg.pq.TransactionStatus.INERROR
            raise _Rollback


class _Rollback(Exception):
    """Leave a ``connection.transaction()`` block with a rollback."""
