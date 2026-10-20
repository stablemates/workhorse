from __future__ import annotations

from collections.abc import Sequence

from workhorse._statements import SQL_STATEMENTS, DriverStatement
from workhorse.dashboard._backend import DashboardBackend

_COLUMNS = (
    "task_identity_retention_days",
    "terminal_outcome_retention_days",
    "task_event_retention_days",
    "attempt_history_retention_days",
    "schedule_occurrence_retention_days",
    "statistics_retention_days",
)


class _RetentionPreviewExecutor:
    """Answer the policy read with 14 days for every setting and record the preview statement."""

    dialect = "psycopg"

    def __init__(self) -> None:
        self.statement: DriverStatement | None = None
        self.parameters: list[object] = []

    def rows(
        self, statement: DriverStatement, parameters: Sequence[object] = ()
    ) -> list[dict[str, object]]:
        if "get_retention_policy_v1()" in statement.psycopg:
            return [dict.fromkeys(_COLUMNS, 14)]
        self.statement = statement
        self.parameters = list(parameters)
        return [
            {
                "terminal_tasks": 0,
                "task_events": 0,
                "attempt_history": 0,
                "schedule_occurrences": 0,
                "statistics": 0,
            }
        ]


def test_preview_sends_the_shared_statement_and_keeps_an_explicit_null() -> None:
    executor = _RetentionPreviewExecutor()
    backend = DashboardBackend(
        executor,  # type: ignore[arg-type]
        environment="test",
        configured_workers=(),
        maintenance_loops={},
        read_only=False,
    )

    backend.preview_retention_policy(
        {"definition": {"terminalOutcomeRetentionDays": None, "statisticsRetentionDays": 3}},
        "operator",
    )

    assert executor.statement == DriverStatement(*SQL_STATEMENTS["retention_policy_preview"])
    # An absent setting keeps the current value. The explicit null stays null, so the statement
    # counts no terminal tasks. Psycopg takes one value for each use of a parameter.
    assert executor.parameters == [14, None, 14, None, 14, 14, 14, 14, 14, 14, 3, 3, 3, 3, 3, 3]
