from __future__ import annotations

import json
from collections.abc import Sequence

from workhorse._statements import DriverStatement
from workhorse.dashboard._backend import DashboardBackend


class _RetentionPreviewExecutor:
    """Record each statement and its parameters, and answer with an empty impact document."""

    dialect = "psycopg"

    def __init__(self) -> None:
        self.statements: list[str] = []
        self.parameters: list[object] = []

    def rows(
        self, statement: DriverStatement, parameters: Sequence[object] = ()
    ) -> list[dict[str, object]]:
        self.statements.append(statement.psycopg)
        self.parameters = list(parameters)
        return [{"result": {"eligible": {}, "capped": {}}}]


def test_preview_calls_the_dashboard_function_with_the_input() -> None:
    executor = _RetentionPreviewExecutor()
    backend = DashboardBackend(
        executor,  # type: ignore[arg-type]
        environment="test",
        configured_workers=(),
        maintenance_loops={},
        read_only=False,
    )
    document = {"definition": {"terminalOutcomeRetentionDays": None, "statisticsRetentionDays": 3}}

    backend.preview_retention_policy(document, "operator")

    assert executor.statements == [
        "SELECT workhorse.dashboard_retention_preview_v1(%s::jsonb) AS result"
    ]
    # The function merges the definition, so the explicit null reaches it unchanged.
    assert [json.loads(str(value)) for value in executor.parameters] == [document]
