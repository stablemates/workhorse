from __future__ import annotations

import json
import math
import re
import uuid
from collections.abc import Mapping, Sequence
from datetime import datetime
from decimal import Decimal
from pathlib import Path
from typing import Any

import psycopg
import pytest
from protocol_fixtures import assert_fixture_execution
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb

from workhorse._protocol import compatibility_refusal

REPOSITORY = Path(__file__).parents[2]
PARAMETER = re.compile(r"\$(\d+)")
UUID_VALUE = re.compile(r"^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$", re.IGNORECASE)
TIMESTAMP_VALUE = re.compile(
    r"^(?P<date>\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})"
    r"(?:\.(?P<fraction>\d{1,9}))?(?P<offset>Z|[+-]\d{2}:\d{2})$"
)
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


def test_python_runs_every_shared_interpreter_self_test() -> None:
    fixtures = read_json("protocol/v1/interpreter.json")
    executed: set[str] = set()
    for fixture in fixtures:
        references: dict[str, Any] = {}
        for step in fixture["steps"]:
            actual = normalize(materialize_interpreter_value(step["actual"]))
            if step.get("rejects", False):
                with pytest.raises(AssertionError):
                    assert_value(
                        step["expect"], actual, references, f"{fixture['id']}/{step['id']}"
                    )
            else:
                assert_value(step["expect"], actual, references, f"{fixture['id']}/{step['id']}")
            for name, pointer in step.get("capture", {}).items():
                references[name] = read_pointer(actual, pointer)
        for error in fixture["errors"]:
            assert_error_value(
                error["expect"],
                normalize(error["actual"]),
                references,
                f"{fixture['id']}/{error['id']}",
            )
        executed.add(fixture["id"])
    assert_fixture_execution("interpreter", fixtures, executed)


def test_python_conformance_rejects_missing_manifest_coverage() -> None:
    manifest = {"coverage": ["enqueue", "claim"], "runtimeCoverage": []}

    with pytest.raises(AssertionError, match="SQL protocol fixtures lack coverage: claim"):
        assert_manifest_coverage(manifest, {"enqueue"})


def test_python_conformance_rejects_an_unexecuted_declared_fixture() -> None:
    fixtures = read_json("protocol/v1/requests.json")

    with pytest.raises(AssertionError, match="minimal-enqueue-request"):
        assert_fixture_execution("requests", fixtures, {fixtures[0]["id"]})


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
        formatted = value.isoformat()
        offset_start = max(formatted.rfind("+"), formatted.rfind("-", 10))
        main = formatted if offset_start < 0 else formatted[:offset_start]
        offset = "" if offset_start < 0 else formatted[offset_start:]
        if "." in main:
            main = main.rstrip("0").rstrip(".")
        return main + ("Z" if offset == "+00:00" else offset)
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
        or (
            kind == "number"
            and isinstance(actual, (int, float))
            and not isinstance(actual, bool)
            and math.isfinite(actual)
        )
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
    actual: dict[str, Any] = {
        "code": error.sqlstate,
        "message": error.diag.message_primary,
    }
    if error.diag.message_detail is not None:
        actual["detail"] = json.loads(error.diag.message_detail)
    assert_error_value(expected, actual, references, f"{scenario}/{step}")


def assert_error_value(
    expected: Mapping[str, Any],
    actual: Mapping[str, Any],
    references: Mapping[str, Any],
    location: str,
) -> None:
    assert actual.get("code") == expected["code"], f"{location} SQLSTATE"
    assert actual.get("message") == expected["message"], f"{location} message"
    if "detail" in expected:
        assert "detail" in actual, f"{location} detail"
        assert_value(expected["detail"], actual["detail"], references, f"{location}.detail")


def read_pointer(value: Any, pointer: str) -> Any:
    current = value
    for segment in pointer.split("."):
        current = current[int(segment)] if isinstance(current, list) else current[segment]
    return current


def _is_uuid(value: str) -> bool:
    if UUID_VALUE.fullmatch(value) is None:
        return False
    try:
        uuid.UUID(value)
    except ValueError:
        return False
    return True


def _is_timestamp(value: str) -> bool:
    match = TIMESTAMP_VALUE.fullmatch(value)
    if match is None:
        return False
    fraction = match.group("fraction")
    normalized = match.group("date")
    if fraction is not None:
        normalized += f".{fraction[:6].ljust(6, '0')}"
    offset = match.group("offset")
    normalized += "+00:00" if offset == "Z" else offset
    try:
        datetime.fromisoformat(normalized)
    except ValueError:
        return False
    return True


@pytest.mark.parametrize(
    "value",
    ["2026-08-31T03:19:19.56288+00:00", "2026-08-31T03:19:19.123456789Z"],
)
def test_timestamp_matcher_accepts_contract_fractional_precision(value: str) -> None:
    assert _is_timestamp(value)


def materialize_interpreter_value(value: Any) -> Any:
    if isinstance(value, list):
        return [materialize_interpreter_value(item) for item in value]
    if isinstance(value, dict):
        if set(value) == {"$native", "value"}:
            native = value["$native"]
            if native == "integer":
                return Decimal(value["value"])
            if native == "number":
                return float(value["value"])
            if native == "timestamp":
                return datetime.fromisoformat(value["value"].replace("Z", "+00:00"))
            if native == "uuid":
                return uuid.UUID(value["value"])
            if native == "json":
                return value["value"]
            raise AssertionError(f"unknown interpreter native value {native}")
        return {key: materialize_interpreter_value(item) for key, item in value.items()}
    return value


def read_json(relative: str) -> Any:
    return json.loads((REPOSITORY / relative).read_text())
