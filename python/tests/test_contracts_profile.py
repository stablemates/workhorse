from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

import pytest

from workhorse._contracts import compile_contract_schema
from workhorse.types import Json

FIXTURES: list[dict[str, Any]] = json.loads(
    (Path(__file__).resolve().parents[2] / "protocol" / "v1" / "contracts.json").read_text()
)


# Fixtures Python does not pass yet, each with the Issue that owns the gap. A listed fixture that
# passes fails the run, so an entry cannot outlive its gap.
UNSUPPORTED: dict[str, str] = {}


@pytest.mark.parametrize(
    "fixture",
    [
        pytest.param(
            fixture,
            id=fixture["id"],
            marks=[pytest.mark.xfail(reason=UNSUPPORTED[fixture["id"]], strict=True)]
            if fixture["id"] in UNSUPPORTED
            else [],
        )
        for fixture in FIXTURES
    ],
)
def test_contract_schema_profile(fixture: dict[str, Any]) -> None:
    if fixture.get("schemaError"):
        with pytest.raises((TypeError, ValueError)):
            compile_contract_schema(fixture["schema"])
        return
    validator = compile_contract_schema(fixture["schema"])
    for instance in fixture.get("instances", []):
        assert validator.is_valid(instance["value"]) is instance["valid"]


@pytest.mark.parametrize(
    ("path", "schema"),
    [
        ("$.properties.a.pattern", {"properties": {"a": {"type": "string", "pattern": "^a$"}}}),
        ("$.items.patternProperties", {"items": {"patternProperties": {"^a": True}}}),
    ],
)
def test_contract_schema_names_the_pattern_keyword_it_refuses(path: str, schema: Json) -> None:
    with pytest.raises(
        TypeError, match=re.escape(f"{path} is outside the Workhorse contract profile")
    ):
        compile_contract_schema(schema)


def test_contract_schema_refuses_a_reference_outside_the_schema_tree() -> None:
    schema: Json = {"default": {"pattern": "^a$"}, "properties": {"a": {"$ref": "#/default"}}}
    with pytest.raises(
        TypeError, match=re.escape("$.properties.a.$ref must point at a subschema of the contract")
    ):
        compile_contract_schema(schema)


def test_contract_schema_names_the_duplicate_anchor() -> None:
    schema: Json = {"$defs": {"one": {"$anchor": "same"}, "two": {"$anchor": "same"}}}
    with pytest.raises(
        TypeError, match=re.escape("$.$defs.two.$anchor must declare a unique anchor")
    ):
        compile_contract_schema(schema)
