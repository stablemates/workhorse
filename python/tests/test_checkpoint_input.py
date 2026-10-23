from __future__ import annotations

import json
from typing import Any

import pytest
from protocol_fixtures import read_protocol_fixture

from workhorse import checkpoint_input_fingerprint
from workhorse._checkpoint_input import _number

# protocol/v1/checkpoint-fingerprints.json holds the vectors that every SDK must give.
VECTORS: list[dict[str, Any]] = read_protocol_fixture("checkpoint-fingerprints.json")["vectors"]

REFUSALS = {
    "loneSurrogate": "lone surrogate",
    "nonFinite": "only finite numbers",
    "unsafeNumber": "numbers must be at most 2\\*\\*53 - 1",
}


def test_the_fixture_has_vectors() -> None:
    assert VECTORS


@pytest.mark.parametrize("vector", VECTORS, ids=[vector["id"] for vector in VECTORS])
def test_the_fingerprint_gives_the_shared_vectors(vector: dict[str, Any]) -> None:
    input = json.loads(vector["input"])
    if "roundedDigest" in vector:
        # json.loads decodes each number to a float, so this SDK gives roundedDigest. An SDK that
        # keeps the exact number text refuses the vector (ADR 0098).
        assert vector["refusal"] == "unsafeNumber"
        assert checkpoint_input_fingerprint(input) == vector["roundedDigest"]
    elif "refusal" in vector:
        with pytest.raises(ValueError, match=REFUSALS[vector["refusal"]]):
            checkpoint_input_fingerprint(input)
    else:
        assert checkpoint_input_fingerprint(input) == vector["digest"]


def test_a_tuple_has_the_fingerprint_of_a_list() -> None:
    assert checkpoint_input_fingerprint((1, "x")) == checkpoint_input_fingerprint([1, "x"])
    assert checkpoint_input_fingerprint({"amountCents": 1000.0}) == (
        checkpoint_input_fingerprint({"amountCents": 1000})
    )


@pytest.mark.parametrize(
    ("value", "text"),
    [
        (1, "1"),
        (-1.5, "-1.5"),
        (100.0, "100"),
        (123.456, "123.456"),
        (0.1, "0.1"),
        (1e16, "10000000000000000"),
        (1e20, "100000000000000000000"),
        (123456789012345680000.0, "123456789012345680000"),
        (1e21, "1e+21"),
        (1.25e22, "1.25e+22"),
        (0.000001, "0.000001"),
        (1.234e-6, "0.000001234"),
        (1e-7, "1e-7"),
        (-2.5e-8, "-2.5e-8"),
        (5e-324, "5e-324"),
        (1.7976931348623157e308, "1.7976931348623157e+308"),
        (9_007_199_254_740_991, "9007199254740991"),
        (-9_007_199_254_740_991, "-9007199254740991"),
        # The exact value ends in .25, between two shortest forms. ECMAScript takes the even
        # digit, .2.
        (-1010086764207289.2, "-1010086764207289.2"),
    ],
)
def test_numbers_use_the_ecmascript_form(value: float, text: str) -> None:
    # The fingerprint refuses a magnitude above 2**53 - 1, so this test calls the number form.
    assert _number(float(value)) == text


@pytest.mark.parametrize(
    ("input", "error", "message"),
    [
        ({"amount": float("nan")}, ValueError, "only finite numbers"),
        ([float("inf")], ValueError, "only finite numbers"),
        (-float("inf"), ValueError, "only finite numbers"),
        (float(2**53), ValueError, "numbers must be at most 2\\*\\*53 - 1"),
        ({1: "x"}, TypeError, "keys must be strings"),
        ({"at": object()}, TypeError, "contains object, which is not a JSON value"),
        ({1, 2}, TypeError, "contains set, which is not a JSON value"),
    ],
)
def test_an_input_that_is_not_json_with_finite_numbers_is_refused(
    input: object, error: type[Exception], message: str
) -> None:
    with pytest.raises(error, match=message):
        checkpoint_input_fingerprint(input)


class _Small(int):
    def __abs__(self) -> int:
        return 0


class _SmallFloat(float):
    def __abs__(self) -> float:
        return 0.0

    def __repr__(self) -> str:
        return "1.0"


class _Text(str):
    def encode(self, encoding: str = "utf-8", errors: str = "strict") -> bytes:
        del encoding, errors
        return b""

    def __str__(self) -> str:
        return "other"


def test_a_subclass_cannot_change_the_fingerprint_or_the_limit() -> None:
    # The base type of each value decides its form, so an override in a subclass has no effect.
    with pytest.raises(ValueError, match="numbers must be at most 2\\*\\*53 - 1"):
        checkpoint_input_fingerprint(_Small(2**53))
    with pytest.raises(ValueError, match="numbers must be at most 2\\*\\*53 - 1"):
        checkpoint_input_fingerprint({"id": _SmallFloat(1e21)})
    assert checkpoint_input_fingerprint(_SmallFloat(1.5)) == checkpoint_input_fingerprint(1.5)
    assert checkpoint_input_fingerprint({_Text("a"): _Text("b")}) == (
        checkpoint_input_fingerprint({"a": "b"})
    )
    with pytest.raises(ValueError, match="lone surrogate"):
        checkpoint_input_fingerprint(_Text("\ud800"))
