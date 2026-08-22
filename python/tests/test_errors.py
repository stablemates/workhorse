from __future__ import annotations

import json
from collections.abc import Sequence

import pytest

from workhorse import (
    DependencyCycleError,
    DependencyLimitExceededError,
    EnqueueIdempotencyConflictError,
    ProtocolCompatibilityError,
    Queue,
)


class Diagnostic:
    def __init__(self, detail: dict[str, object]) -> None:
        self.message_detail = json.dumps(detail)


class DatabaseError(Exception):
    def __init__(self, sqlstate: str, detail: dict[str, object]) -> None:
        self.sqlstate = sqlstate
        self.diag = Diagnostic(detail)
        super().__init__("database rejected the request")


class Cursor:
    def __init__(self, error: Exception, fail_compatibility: bool = False) -> None:
        self.error = error
        self.fail_compatibility = fail_compatibility
        self.sql = ""
        self.description = [("version",)]

    def __enter__(self) -> Cursor:
        return self

    def __exit__(self, *_args: object) -> None:
        return None

    def execute(self, sql: str, _parameters: Sequence[object] = ()) -> None:
        self.sql = sql
        if self.fail_compatibility or "enqueue_many_v1" in sql:
            raise self.error

    def fetchall(self) -> list[tuple[int]]:
        return [(1,)]


class Connection:
    def __init__(self, error: Exception, fail_compatibility: bool = False) -> None:
        self.error = error
        self.fail_compatibility = fail_compatibility

    def cursor(self) -> Cursor:
        return Cursor(self.error, self.fail_compatibility)


@pytest.mark.parametrize(
    ("sqlstate", "exception_type"),
    [
        ("P1001", EnqueueIdempotencyConflictError),
        ("P1003", DependencyCycleError),
        ("P1005", DependencyLimitExceededError),
    ],
)
def test_maps_structured_postgres_failures(sqlstate: str, exception_type: type[Exception]) -> None:
    detail = {"jobId": "00000000-0000-4000-8000-000000000001", "ordinal": 1}

    with pytest.raises(exception_type) as raised:
        Queue(Connection(DatabaseError(sqlstate, detail))).enqueue("email.send", {"id": 1})

    assert raised.value.details == detail


def test_reports_an_unreadable_schema_as_a_compatibility_refusal() -> None:
    connection = Connection(DatabaseError("42P01", {}), fail_compatibility=True)

    with pytest.raises(ProtocolCompatibilityError) as raised:
        Queue(connection).enqueue("email.send", {"id": 1})

    assert raised.value.code == "schema-not-installed"


def test_preserves_operational_compatibility_query_errors() -> None:
    error = DatabaseError("42501", {})

    with pytest.raises(DatabaseError) as raised:
        Queue(Connection(error, fail_compatibility=True)).enqueue("email.send", {"id": 1})

    assert raised.value is error
