from __future__ import annotations

import json
from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import Any

REPOSITORY = Path(__file__).parents[2]


def read_protocol_fixture(name: str) -> Any:
    return json.loads((REPOSITORY / "protocol" / "v1" / name).read_text())


def assert_fixture_execution(
    kind: str, fixtures: Sequence[Mapping[str, Any]], executed: set[str]
) -> None:
    manifest = read_protocol_fixture("manifest.json")
    expected = set(manifest["fixtureCoverage"][kind])
    defined = {fixture["id"] for fixture in fixtures}
    assert defined == expected, f"{kind} fixture manifest differs: {defined ^ expected}"
    assert executed == expected, f"{kind} fixtures were not executed: {expected - executed}"
