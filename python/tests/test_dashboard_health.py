from __future__ import annotations

import json
from collections.abc import Sequence

from workhorse._statements import DriverStatement
from workhorse.dashboard._backend import DashboardBackend


class _HealthExecutor:
    """Answer the health read with a sentinel document and record every statement."""

    dialect = "psycopg"

    def __init__(self) -> None:
        self.statements: list[str] = []
        self.inputs: list[str] = []

    def rows(
        self, statement: DriverStatement, parameters: Sequence[object] = ()
    ) -> list[dict[str, object]]:
        sql = statement.for_dialect("psycopg")
        self.statements.append(sql)
        if parameters:
            self.inputs.append(str(parameters[0]))
        if "queue_health_v1()" in sql:
            return [{"result": '{"level":"healthy","pending_human_waits":42}'}]
        return [{"result": '{"ok":true}'}]


def test_human_waits_and_task_detail_share_one_health_document() -> None:
    executor = _HealthExecutor()
    backend = DashboardBackend(
        executor,  # type: ignore[arg-type]
        environment="test",
        configured_workers=(),
        maintenance_loops={},
        read_only=False,
    )

    backend.human_waits(None, "operator")
    backend.task_detail({"id": "task-1"}, "operator")

    health_reads = [sql for sql in executor.statements if "queue_health_v1()" in sql]
    assert len(health_reads) == 1
    assert len(executor.inputs) == 2
    for raw in executor.inputs:
        assert json.loads(raw)["health"] == {"level": "healthy", "pending_human_waits": 42}
