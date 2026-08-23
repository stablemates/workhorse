from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from workhorse._contracts import compile_contract_schema

FIXTURES: list[dict[str, Any]] = json.loads(
    (Path(__file__).resolve().parents[2] / "protocol" / "v1" / "contracts.json").read_text()
)


@pytest.mark.parametrize("fixture", FIXTURES, ids=[fixture["id"] for fixture in FIXTURES])
def test_contract_schema_profile(fixture: dict[str, Any]) -> None:
    if fixture.get("schemaError"):
        with pytest.raises((TypeError, ValueError)):
            compile_contract_schema(fixture["schema"])
        return
    validator = compile_contract_schema(fixture["schema"])
    for instance in fixture.get("instances", []):
        assert validator.is_valid(instance["value"]) is instance["valid"]
