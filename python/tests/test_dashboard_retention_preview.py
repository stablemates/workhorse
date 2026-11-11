from __future__ import annotations

import json
from collections.abc import Sequence
from types import SimpleNamespace

from psycopg.pq import TransactionStatus

from workhorse._statements import DriverStatement
from workhorse.dashboard._backend import DashboardBackend


class _RetentionPreviewExecutor:
    """Record each statement and its parameters, and answer with an empty impact document."""

    dialect = "psycopg"
    # The driver reports an idle connection, so the host owns the transaction of each read.
    connection = SimpleNamespace(info=SimpleNamespace(transaction_status=TransactionStatus.IDLE))

    def __init__(self) -> None:
        self.statements: list[str] = []
        self.parameters: list[object] = []

    def command(self, statement: DriverStatement, _parameters: Sequence[object] = ()) -> None:
        self.statements.append(statement.psycopg)

    def rows(
        self, statement: DriverStatement, parameters: Sequence[object] = ()
    ) -> list[dict[str, object]]:
        self.statements.append(statement.psycopg)
        if "set_config" in statement.psycopg:
            return [{"set_config": parameters[0]}]
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

    # The preview is a read, so it runs in a read-only transaction under the statement timeout.
    assert executor.statements == [
        "BEGIN READ ONLY",
        "SELECT set_config('statement_timeout', %s, true)",
        "SELECT workhorse.dashboard_retention_preview_v1(%s::jsonb) AS result",
        "COMMIT",
    ]
    # The function merges the definition, so the explicit null reaches it unchanged.
    assert [json.loads(str(value)) for value in executor.parameters] == [document]


class _UnknownStateExecutor(_RetentionPreviewExecutor):
    """A connection whose transaction state the driver does not report."""

    connection = None


def test_a_read_on_a_connection_of_unknown_state_runs_directly() -> None:
    executor = _UnknownStateExecutor()
    backend = DashboardBackend(
        executor,  # type: ignore[arg-type]
        environment="test",
        configured_workers=(),
        maintenance_loops={},
        read_only=False,
    )

    backend.preview_retention_policy({"definition": {}}, "operator")

    # The host cannot prove that no caller transaction is open, so it sends no BEGIN and no COMMIT.
    assert executor.statements == [
        "SELECT workhorse.dashboard_retention_preview_v1(%s::jsonb) AS result"
    ]
