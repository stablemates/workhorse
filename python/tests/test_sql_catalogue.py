from __future__ import annotations

import ast
import json
import re
from pathlib import Path
from typing import Any

from workhorse._statements import SQL_STATEMENTS

REPOSITORY = Path(__file__).parents[2]
PACKAGE = REPOSITORY / "python" / "src" / "workhorse"
PARAMETER = re.compile(r"\$(\d+)")
SQL_LITERAL = re.compile(r"^\s*(?:SELECT|INSERT|UPDATE|DELETE|WITH)\b", re.IGNORECASE)


def test_generated_sql_catalogue_matches_protocol_manifest() -> None:
    manifest: dict[str, Any] = json.loads(
        (REPOSITORY / "protocol" / "v1" / "manifest.json").read_text()
    )
    statements: list[dict[str, Any]] = manifest["statements"]
    names = [statement["name"] for statement in statements]
    assert len(names) == len(set(names)), "manifest contains duplicate SQL statement names"

    expected = {
        statement["name"]: (
            PARAMETER.sub("%s", statement["contract"]),
            statement["contract"],
        )
        for statement in statements
    }
    assert expected == SQL_STATEMENTS

    for statement in statements:
        parameters = [int(match) for match in PARAMETER.findall(statement["contract"])]
        assert max(parameters, default=0) == statement["arity"], statement["name"]


def test_production_sql_literals_live_in_the_generated_catalogue() -> None:
    allowed = {
        Path("_statements.py"),
        Path("dashboard_v1.py"),
        Path("dashboard/_backend.py"),
    }
    violations: list[str] = []

    for path in sorted(PACKAGE.rglob("*.py")):
        if path.relative_to(PACKAGE) in allowed:
            continue
        tree = ast.parse(path.read_text(), filename=str(path))
        for node in ast.walk(tree):
            if (
                isinstance(node, ast.Constant)
                and isinstance(node.value, str)
                and SQL_LITERAL.match(node.value)
            ):
                violations.append(f"{path.relative_to(REPOSITORY)}:{node.lineno}")

    assert not violations, "Python SQL must come from SQL_STATEMENTS:\n" + "\n".join(violations)
