from __future__ import annotations

import json
import re
import uuid
from collections.abc import Mapping, Sequence
from datetime import datetime
from decimal import Decimal
from pathlib import Path
from typing import Any

import psycopg
import pytest
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb

from workhorse._protocol import compatibility_refusal

REPOSITORY = Path(__file__).parents[2]
PARAMETER = re.compile(r"\$(\d+)")
pytestmark = pytest.mark.integration


def test_python_compatibility_matches_the_shared_fixtures() -> None:
    fixtures = read_json("protocol/v1/compatibility.json")

    for fixture in fixtures:
        refusal = compatibility_refusal(
            fixture["installedSchemaVersion"], fixture["clientProtocolVersion"]
        )
        assert (refusal is None) is fixture["compatible"], fixture["id"]
        assert refusal == fixture.get("refusalCode"), fixture["id"]


def test_psycopg_satisfies_every_shared_sql_scenario(database_url: str) -> None:
    manifest = read_json("protocol/v1/manifest.json")
    scenarios = read_json("protocol/v1/scenarios.json")
    coverage: set[str] = set()
    with psycopg.connect(database_url, row_factory=dict_row, autocommit=True) as connection:
        for scenario in scenarios:
            references: dict[str, Any] = {}
            for step in scenario["steps"]:
                execute_step(connection, scenario["id"], step, references)
                coverage.update(step.get("covers", []))
    assert_manifest_coverage(manifest, coverage)


@pytest.mark.parametrize(
    ("kind", "actual"),
    [
        ("any", None),
        ("any", {"nested": [True, 1, "value"]}),
        ("number", 1),
        ("number", 1.5),
        ("boolean", True),
        ("boolean", False),
    ],
)
def test_python_value_matcher_supports_shared_types(kind: str, actual: Any) -> None:
    assert_matcher(kind, actual, "fixture")


def test_python_conformance_rejects_missing_manifest_coverage() -> None:
    manifest = {"coverage": ["enqueue", "claim"], "runtimeCoverage": []}

    with pytest.raises(AssertionError, match="SQL protocol fixtures lack coverage: claim"):
        assert_manifest_coverage(manifest, {"enqueue"})


def execute_step(
    connection: psycopg.Connection[dict[str, Any]],
    scenario: str,
    step: Mapping[str, Any],
    references: dict[str, Any],
) -> None:
    parameters = [resolve(value, references) for value in step.get("parameters", [])]
    sql, bound = bind_psycopg(step["sql"], parameters)
    expected_error = step.get("error")
    if expected_error is not None:
        with pytest.raises(psycopg.Error) as raised:
            connection.execute(sql, bound).fetchall()
        assert_database_error(raised.value, expected_error, references, scenario, step["id"])
        return

    rows = normalize(connection.execute(sql, bound).fetchall())
    expected_rows = step.get("expect", {}).get("rows", [])
    assert_value(expected_rows, rows, references, f"{scenario}/{step['id']}")
    for name, pointer in step.get("capture", {}).items():
        references[name] = read_pointer(rows, pointer)


def bind_psycopg(sql: str, parameters: Sequence[Any]) -> tuple[str, tuple[object, ...]]:
    bound: list[object] = []

    def replace(match: re.Match[str]) -> str:
        value = parameters[int(match.group(1)) - 1]
        bound.append(Jsonb(value) if isinstance(value, (dict, list)) else value)
        return "%s"

    return PARAMETER.sub(replace, sql), tuple(bound)


def resolve(value: Any, references: Mapping[str, Any]) -> Any:
    if isinstance(value, list):
        return [resolve(item, references) for item in value]
    if isinstance(value, dict):
        if set(value) == {"$ref"}:
            return references[value["$ref"]]
        return {key: resolve(item, references) for key, item in value.items()}
    return value


def normalize(value: Any) -> Any:
    if isinstance(value, Mapping):
        return {key: normalize(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [normalize(item) for item in value]
    if isinstance(value, uuid.UUID):
        return str(value)
    if isinstance(value, datetime):
        return value.isoformat()
    if isinstance(value, Decimal):
        return int(value) if value == value.to_integral_value() else float(value)
    return value


def assert_value(expected: Any, actual: Any, references: Mapping[str, Any], location: str) -> None:
    if isinstance(expected, dict):
        if "$ref" in expected:
            assert actual == references[expected["$ref"]], location
            return
        if "$type" in expected:
            assert_matcher(expected["$type"], actual, location)
            return
        assert isinstance(actual, dict), location
        assert set(actual) == set(expected), location
        for key, value in expected.items():
            assert_value(value, actual[key], references, f"{location}.{key}")
        return
    if isinstance(expected, list):
        assert isinstance(actual, list) and len(actual) == len(expected), location
        for index, value in enumerate(expected):
            assert_value(value, actual[index], references, f"{location}[{index}]")
        return
    assert actual == expected, location


def assert_matcher(kind: str, actual: Any, location: str) -> None:
    accepted = (
        kind == "any"
        or (kind == "uuid" and isinstance(actual, str) and _is_uuid(actual))
        or (kind == "timestamp" and isinstance(actual, str) and _is_timestamp(actual))
        or (kind == "string" and isinstance(actual, str))
        or (kind == "integer" and isinstance(actual, int) and not isinstance(actual, bool))
        or (kind == "number" and isinstance(actual, (int, float)) and not isinstance(actual, bool))
        or (kind == "boolean" and isinstance(actual, bool))
    )
    assert accepted, f"{location} expected {kind}, received {actual!r}"


def assert_manifest_coverage(manifest: Mapping[str, Any], coverage: set[str]) -> None:
    runtime_coverage = set(manifest["runtimeCoverage"])
    missing = [
        capability
        for capability in manifest["coverage"]
        if capability not in runtime_coverage and capability not in coverage
    ]
    assert not missing, f"SQL protocol fixtures lack coverage: {', '.join(missing)}"


def assert_database_error(
    error: psycopg.Error,
    expected: Mapping[str, Any],
    references: Mapping[str, Any],
    scenario: str,
    step: str,
) -> None:
    assert error.sqlstate == expected["code"], f"{scenario}/{step} SQLSTATE"
    assert error.diag.message_primary == expected["message"], f"{scenario}/{step} message"
    if "detail" in expected:
        assert error.diag.message_detail is not None
        assert_value(
            expected["detail"],
            json.loads(error.diag.message_detail),
            references,
            f"{scenario}/{step}.detail",
        )


def read_pointer(value: Any, pointer: str) -> Any:
    current = value
    for segment in pointer.split("."):
        current = current[int(segment)] if isinstance(current, list) else current[segment]
    return current


def _is_uuid(value: str) -> bool:
    try:
        uuid.UUID(value)
    except ValueError:
        return False
    return True


def _is_timestamp(value: str) -> bool:
    try:
        datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return False
    return True


def read_json(relative: str) -> Any:
    return json.loads((REPOSITORY / relative).read_text())
