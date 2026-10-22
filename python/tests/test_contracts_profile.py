from __future__ import annotations

import json
import re
from decimal import Decimal
from pathlib import Path
from typing import Any, cast

import pytest

from workhorse._contracts import compile_contract_schema, parse_stored_schema
from workhorse.types import Json

FIXTURES: list[dict[str, Any]] = json.loads(
    (Path(__file__).resolve().parents[2] / "protocol" / "v1" / "contracts.json").read_text()
)


# Fixtures Python does not pass yet, each with the Issue that owns the gap. A listed fixture that
# passes fails the run, so an entry cannot outlive its gap.
UNSUPPORTED: dict[str, str] = {}

# A Python value holds an exact int, but json.loads reads a fraction as a float, so Python cannot
# hold a fraction that a double cannot hold. The shared table marks those instances.
UNHELD_NUMBERS = frozenset({"exactFraction"})


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
    # A schema in JSON text reads the way a schema that PostgreSQL stores does.
    schema = (
        parse_stored_schema(fixture["schemaJson"]) if "schemaJson" in fixture else fixture["schema"]
    )
    if fixture.get("schemaError"):
        with pytest.raises((TypeError, ValueError)):
            compile_contract_schema(schema)
        return
    validator = compile_contract_schema(schema)
    for instance in fixture.get("instances", []):
        if instance.get("needs") in UNHELD_NUMBERS:
            continue
        value = json.loads(instance["json"]) if "json" in instance else instance["value"]
        assert validator.is_valid(value) is instance["valid"], instance


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


@pytest.mark.parametrize(
    ("schema", "message"),
    [
        ({"items": {"$anchor": "a"}}, "$.items.$anchor is outside the Workhorse contract profile"),
        ({"items": {"$defs": {}}}, "$.items.$defs must appear only on the root schema"),
        (
            {"$defs": {"a b": True}},
            "$.$defs.a b must be a definition name matching ^[A-Za-z_][-A-Za-z0-9._]*$",
        ),
    ],
)
def test_contract_schema_names_the_anchor_and_definition_forms_it_refuses(
    schema: Json, message: str
) -> None:
    with pytest.raises(TypeError, match=re.escape(message)):
        compile_contract_schema(schema)


def test_multiple_of_divides_exactly_beyond_the_decimal_context_precision() -> None:
    assert compile_contract_schema({"multipleOf": 3}).is_valid(123456789012345678901234567890)
    assert not compile_contract_schema({"multipleOf": 11}).is_valid(123456789012345678901234567890)
    assert compile_contract_schema({"multipleOf": 0.01}).is_valid(10**40 + 0.0)


def test_parse_stored_schema_keeps_a_fraction_a_float_cannot_hold() -> None:
    schema = parse_stored_schema('{"minimum": 0.30000000000000000001, "maximum": 1.5}')
    assert schema == {"minimum": Decimal("0.30000000000000000001"), "maximum": 1.5}
    assert isinstance(cast(dict[str, Json], schema)["maximum"], float)
    validator = compile_contract_schema(schema)
    assert not validator.is_valid(0.3)
    assert validator.is_valid(0.30000000000000004)
