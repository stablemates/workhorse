"""Execute the shared cron occurrence table.

`protocol/v1/cron-occurrences.json` fixes the cron dialect and time zone semantics every runtime
must agree on. TypeScript and Go both run it; Python previously duplicated four of its twelve rows
by hand, leaving `L`, `<DOW>L`, the leap-century gap, the catch-up limit, and both null
`lastOccurrenceAt` cases unverified here. This module runs the table itself, so the three runtimes
are held to one source.

`_due_occurrences` reads the evaluation zone from `tzlocal()` rather than taking a parameter, so
each fixture's zone is supplied the way the worker would see it: as the process zone.
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from unittest.mock import patch

import pytest
from dateutil.tz import gettz

from workhorse.worker import _due_occurrences

FIXTURES: list[dict[str, Any]] = json.loads(
    (Path(__file__).resolve().parents[2] / "protocol" / "v1" / "cron-occurrences.json").read_text()
)


def _instant(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone(timezone.utc)


# The one row the three runtimes do not agree on. TypeScript seeds its parser at `now + 1000ms`
# and returns the previous occurrence unbounded, so a `now` carrying milliseconds yields an instant
# in the future; Python bounds the result at `now`. The table currently records TypeScript's
# answer. WH-353 fixes the rounding and updates the fixture; `strict` makes this marker fail once
# that lands, so it cannot outlive the bug.
KNOWN_DIVERGENCE = {"new-every-second-definition": "WH-353: TypeScript rounds a sub-second now up"}


@pytest.mark.parametrize(
    "fixture",
    [
        pytest.param(
            fixture,
            marks=pytest.mark.xfail(reason=KNOWN_DIVERGENCE[fixture["id"]], strict=True),
        )
        if fixture["id"] in KNOWN_DIVERGENCE
        else fixture
        for fixture in FIXTURES
    ],
    ids=[fixture["id"] for fixture in FIXTURES],
)
def test_matches_the_shared_cron_table(fixture: dict[str, Any]) -> None:
    zone = gettz(fixture["timezone"])
    assert zone is not None, f"unknown time zone {fixture['timezone']}"

    last_occurrence_at = fixture["lastOccurrenceAt"]
    with patch("workhorse.worker.tzlocal", return_value=zone):
        occurrences = _due_occurrences(
            fixture["expression"],
            None if last_occurrence_at is None else _instant(last_occurrence_at),
            _instant(fixture["now"]),
            fixture["limit"],
        )

    assert [occurrence.astimezone(timezone.utc) for occurrence in occurrences] == [
        _instant(expected) for expected in fixture["expected"]
    ]
