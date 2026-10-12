from __future__ import annotations

import pytest

from workhorse import Json, checkpoint_input_fingerprint
from workhorse._checkpoint_input import _canonical

# The vectors of typescript/core/test/checkpoint-fingerprint.test.ts, which every SDK must match.
# The last vector orders keys by UTF-16 code units: U+1F600 encodes as D83D DE00, before U+FB33.
VECTORS: list[tuple[Json, str]] = [
    (None, "74234e98afe7498fb5daf1f36ac2d78acc339464f950703b8c019892f982b90b"),
    (True, "b5bea41b6c623f7c09f1bf24dcae58ebab3c0cdd90ad966bc43a45b44867e12b"),
    (0, "5feceb66ffc86f38d952786c6d696c79c2dbc239dd4e91b46729d73a27fb57e9"),
    (1.5, "9f29a130438b81170b92a42650f9a94291ecad60bd47af2a3886e75f7f728725"),
    (1e21, "241c4643fa70b1dcde1205b71be4e3bebb17e9f880c8e1a33d0ead6c27271d3c"),
    (1e-7, "5b33e02f2c5103a05d32f6ba9cb058294452bfbf393967f68bb30c1bdcbbab22"),
    ("é", "f2886017e9c7abacf804b54d64787dce2b611c9544ba21f3affdd126a6e50086"),
    ([], "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945"),
    ({}, "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a"),
    (
        {"amountCents": 1000, "currency": "EUR"},
        "f5e4dce1a6a38b7186257335fb274c4221391505f139b60596c5f57ce4924471",
    ),
    (
        {"b": [1, {"d": 2, "c": 3}], "a": "x"},
        "4bc2f0faf907fa5fdaedde9cbf7002e3cbf041208b96a4ab4ce6693fbf4bea67",
    ),
    (
        {"\U0001f600": 1, "דּ": 2},
        "2aa3f5086e32bb90ce39c508a6f40fd72e792684f130d0f3b896ea191368f1e3",
    ),
]


@pytest.mark.parametrize(("input", "digest"), VECTORS)
def test_the_fingerprint_gives_the_shared_vectors(input: Json, digest: str) -> None:
    assert checkpoint_input_fingerprint(input) == digest


def test_key_order_and_number_form_do_not_change_the_fingerprint() -> None:
    charge = {"amountCents": 1000, "currency": "EUR"}
    fingerprint = checkpoint_input_fingerprint(charge)
    assert checkpoint_input_fingerprint({"currency": "EUR", "amountCents": 1000}) == fingerprint
    assert checkpoint_input_fingerprint({"amountCents": 1000.0, "currency": "EUR"}) == fingerprint
    assert checkpoint_input_fingerprint({"amountCents": 900, "currency": "EUR"}) != fingerprint
    assert checkpoint_input_fingerprint(-0.0) == checkpoint_input_fingerprint(0)
    assert checkpoint_input_fingerprint((1, "x")) == checkpoint_input_fingerprint([1, "x"])


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
    assert _canonical(value) == text


def test_strings_use_the_json_stringify_escapes() -> None:
    assert _canonical('a"\\\b\f\n\r\t\x01\x1f\x7f\u2028é') == (
        '"a\\"\\\\\\b\\f\\n\\r\\t\\u0001\\u001f\x7f\u2028é"'
    )


@pytest.mark.parametrize(
    ("input", "error", "message"),
    [
        ({"amount": float("nan")}, ValueError, "only finite numbers"),
        ([float("inf")], ValueError, "only finite numbers"),
        (-float("inf"), ValueError, "only finite numbers"),
        (2**53, ValueError, "at most 2\\*\\*53 - 1"),
        (-(2**53), ValueError, "at most 2\\*\\*53 - 1"),
        ("\ud800", ValueError, "lone surrogate"),
        (["\ude00x"], ValueError, "lone surrogate"),
        ({"\ud83d": 1}, ValueError, "lone surrogate"),
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
