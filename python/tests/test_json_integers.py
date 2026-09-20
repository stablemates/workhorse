"""The documented integer bound, held against the Python decoder.

`docs/parity.md` states the bound: an integer keeps its exact value across the three SDKs only up
to 2^53 - 1 in magnitude. Python itself decodes further, and these tests record exactly that, so
the published bound cannot drift away from what the runtime does.
"""

from __future__ import annotations

import json

import pytest

PORTABLE_INTEGER_BOUND = 9_007_199_254_740_991


@pytest.mark.parametrize(
    "value", [0, 1, -1, 2**31, PORTABLE_INTEGER_BOUND, -PORTABLE_INTEGER_BOUND]
)
def test_round_trips_every_integer_inside_the_portable_bound_exactly(value: int) -> None:
    assert json.loads(json.dumps({"id": value}))["id"] == value


def test_decodes_beyond_the_bound_where_typescript_and_go_cannot() -> None:
    # Python keeps this exactly. A TypeScript or Go worker reads the same row as a double and sees
    # 9007199254740992, which is why the bound is documented rather than enforced.
    assert json.loads('{"id":9007199254740993}')["id"] == 9_007_199_254_740_993
    assert isinstance(json.loads('{"id":9007199254740993}')["id"], int)
