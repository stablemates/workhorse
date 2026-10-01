from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from workhorse._contracts import compile_contract_schema
from workhorse._ecma_pattern import compile_ecma_pattern
from workhorse._ecma_pattern_properties import BINARY_PROPERTIES, GENERAL_CATEGORIES, SCRIPTS

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
    ("pattern", "value", "valid"),
    [
        ("^a$", "a", True),
        # ^ and $ do not match at line ends.
        ("^a$", "a\nb", False),
        ("^a$", "a\n", False),
        # . excludes every line terminator.
        ("^.$", "\r", False),
        ("^.$", "\u2028", False),
        # \s excludes NEL and includes the byte order mark.
        ("^\\s$", "\u0085", False),
        ("^\\s$", "﻿", True),
        # \d, \w and \b use ASCII characters.
        ("^\\d$", "٣", False),
        ("^\\w$", "é", False),
        ("\\bb", "éb", True),
        ("^[\\w-]+$", "a-b", True),
        ("^[^]$", "\n", True),
        ("^[]$", "", False),
        ("^(?<x>a)(b)$", "ab", True),
        ("^\\p{Lu}$", "A", True),
        ("^\\p{gc=Lu}$", "A", True),
        ("^\\p{Script=Greek}\\p{sc=Grek}$", "\u03b1\u03b2", True),
        # digit is Decimal_Number, not a POSIX class.
        ("^\\p{digit}$", "٣", True),
        ("^\\P{gc=L}$", "\u03b1", False),
        ("^[\\p{Lu}&&a]$", "&", True),
        ("^\\u{1F600}\\uD83D\\uDE00$", "\U0001f600\U0001f600", True),
        ("^\\cJ\\x41\\0$", "\nA\0", True),
        # A surrogate escape names that code unit, alone or in a range.
        ("^[^\\uD800-\\uDFFF]*$", "abc", True),
        ("^[^\\uD800-\\uDFFF]*$", "\ud800", False),
        ("^\\uD800$", "\ud800", True),
        # U+0342 is in the Inherited script and lists Greek among its script extensions.
        ("^\\p{scx=Grek}$", "\u0342", True),
        ("^\\p{Script_Extensions=Greek}$", "\u0342", True),
        ("^\\p{sc=Grek}$", "\u0342", False),
        # A group name may be written with escapes.
        ("^(?<\\u0061>a)(?<\\u{62}c>b)(?<d\\uD835\\uDC00>c)$", "abc", True),
        # Groups in different alternatives may share a name.
        ("^(?:(?<x>a)|(?<x>b))$", "b", True),
        ("^(?:(?<x>a)|(?:c|(?<x>b)))$", "b", True),
        # A modifier group sets its flags until its ), and a nested group can remove one.
        ("^(?i:a)$", "A", True),
        ("^(?i:a)a$", "AA", False),
        ("^(?i:a(?-i:b)c)$", "AbC", True),
        ("^(?i:a(?-i:b)c)$", "ABC", False),
        ("(?m:^b$)", "a\nb\nc", True),
        ("(?m:(?-m:^b))", "a\nb", False),
        ("^(?s:.)$", "\n", True),
        ("^(?s:(?-s:.).)$", "\n\n", False),
        ("^(?ims-:a.$)", "A\n", True),
        # Case is ignored with simple case folding, so U+017F, which folds to s, matches \w.
        ("^(?i:ß)$", "ẞ", True),
        ("^(?i:ß)$", "ss", False),
        ("^(?i:\\w)$", "\u017f", True),
        ("^(?i:\\p{Lu})$", "a", True),
        # Simple case folding pairs I with i and leaves U+0130 and U+0131 alone.
        ("^(?i:I)$", "i", True),
        ("^(?i:i)$", "\u0130", False),
        ("^(?i:I)$", "\u0131", False),
        ("^(?i:\\u0131)$", "I", False),
        ("^(?i:[a-z])$", "\u0130", False),
        ("^(?i:[^i])$", "I", False),
        ("^(?i:[^a-z])$", "\u0130", True),
        ("^(?i:\\w)$", "\u0131", False),
        ("^(?i:\\W)$", "\u0131", True),
        ("^(?i:a\\B.)$", "a\u0131", False),
        ("^(?i:a\\B.)$", "a\u017f", True),
        # A property matches every character that folds like one of its members, as /iu does.
        ("^(?i:\\p{ASCII})$", "\u212a", True),
        ("^(?i:\\p{sc=Greek})$", "\u00b5", True),
        ("^(?i:\\p{scx=Grek})$", "\u00b5", True),
        ("^(?i:\\p{Changes_When_Lowercased})$", "a", True),
        ("^(?i:\\p{Lowercase})$", "\u212a", True),
        ("^(?i:\\p{Lt})$", "A", False),
        ("^(?i:\\p{Lt})$", "\u01c4", True),
        ("^(?i:\\p{Lu})$", "\u01c5", True),
        ("^(?i:[\\p{ASCII}])$", "\u212a", True),
        ("^(?i:[^\\p{ASCII}])$", "\u212a", False),
        ("^(?i:[^\\p{ASCII}])$", "k", False),
        # \P is the complement, folded the same way.
        ("^(?i:\\P{Lu})$", "A", True),
        ("^(?i:\\P{Ll})$", "a", True),
        ("^(?i:\\P{ASCII})$", "k", True),
        ("^(?i:\\P{ASCII})$", "\u212a", True),
        ("^(?i:\\P{sc=Latn})$", "k", False),
        ("^(?i:\\P{Lowercase})$", "a", True),
        ("^(?i:[\\P{Lu}])$", "A", True),
        ("^(?i:[^\\P{Lu}])$", "a", False),
        ("^(?i:[^\\P{Lu}])$", "1", False),
        # A negated class refuses each character that folds like one of its members.
        ("^(?i:[^k])$", "\u212a", False),
        ("^(?i:[^k])$", "K", False),
        ("^(?i:\\W)$", "\u017f", False),
        ("^(?i:[\\W])$", "k", False),
        ("^(?i:[^\\W])$", "\u212a", True),
        # A negated class holding a set and its complement matches nothing.
        ("^[^\\p{Lu}\\P{Lu}]$", "a", False),
        ("^[^\\P{Lu}\\p{Lu}]$", "A", False),
        ("^[^\\w\\W]$", "a", False),
        ("^[^\\d\\D]$", "1", False),
        ("^[^\\p{ASCII}\\P{ASCII}]$", "\u00e9", False),
        ("^[^\\p{sc=Latn}\\P{sc=Latn}a]$", "b", False),
        ("^(?i:[^\\p{Lu}\\P{Lu}])$", "a", False),
        ("^(?i:[^\\w\\W])$", "\u212a", False),
        ("^[\\p{Lu}\\P{Lu}]$", "a", True),
        ("^[^\\P{Lu}a]$", "B", True),
        ("^[^\\P{Lu}a]$", "b", False),
    ],
)
def test_contract_pattern_matches_with_ecma_262_semantics(
    pattern: str, value: str, valid: bool
) -> None:
    assert compile_contract_schema({"pattern": pattern}).is_valid(value) is valid


@pytest.mark.parametrize(
    "pattern",
    [
        "\\p{greek}",
        "\\p{Greek}",
        "\\p{Script=Lu}",
        "\\p{General_Category=Greek}",
        "\\p{gc=ASCII}",
        "\\p{Other_Alphabetic}",
        "\\p{Alnum}",
        "(?i)a",
        "\\A",
        "\\h",
        "a{2,1}",
        "a**",
        "(?<x>a)(?<x>b)",
        "(?:(?<x>a)|b)(?<x>c)",
        "(?<x>(?<x>a)|b)",
        "(?<\\u0031>a)",
        "(?<\\x61>a)",
        "\\p{scx=Lu}",
        "(?-:a)",
        "(?ii:a)",
        "(?i-i:a)",
        "(?x:a)",
        "(?I:a)",
        # A pattern the regex module refuses under i raises ValueError too.
        "(?i:[z-a])",
        "(?i:\\p{Changes_When_NFKC_Casefolded})",
        # The profile refuses backreferences.
        "(a)\\1",
        "\\1(a)",
        "(?<x>a)\\k<x>",
    ],
)
def test_contract_pattern_outside_ecma_262_u_flag_grammar_is_refused(pattern: str) -> None:
    with pytest.raises(ValueError):
        compile_contract_schema({"pattern": pattern})


@pytest.mark.parametrize(
    ("schema", "path"),
    [
        ({"pattern": "(a)\\1"}, "$.pattern"),
        ({"properties": {"x": {"pattern": "\\k<n>(?<n>a)"}}}, "$.properties.x.pattern"),
        ({"patternProperties": {"(a)\\1": {}}}, "$.patternProperties.(a)\\1"),
    ],
)
def test_backreference_is_refused_with_the_profile_message(schema: Any, path: str) -> None:
    message = f"{path} uses a backreference, which is outside the Workhorse contract profile"
    with pytest.raises(ValueError) as refused:
        compile_contract_schema(schema)
    assert str(refused.value) == message


def test_pattern_property_key_matches_with_ecma_262_semantics() -> None:
    validator = compile_contract_schema(
        {"patternProperties": {"^\\w$": {"type": "integer"}}, "additionalProperties": False}
    )
    assert validator.is_valid({"a": 1})
    assert not validator.is_valid({"é": 1})
    for key in ["\\1", "(?i:[z-a])", "(?i:\\p{CWKCF})"]:
        with pytest.raises(ValueError):
            compile_contract_schema({"patternProperties": {key: {}}})
    caseless = compile_contract_schema(
        {"patternProperties": {"^(?i:\\w)$": {}}, "additionalProperties": False}
    )
    assert caseless.is_valid({"I": 1})
    assert not caseless.is_valid({"\u0131": 1})
    folded = compile_contract_schema(
        {"patternProperties": {"^(?i:\\p{ASCII})$": {}}, "additionalProperties": False}
    )
    assert folded.is_valid({"\u212a": 1})
    negated = compile_contract_schema(
        {"patternProperties": {"^(?i:[^\\p{ASCII}])$": {}}, "additionalProperties": False}
    )
    assert not negated.is_valid({"\u212a": 1})
    complementary = compile_contract_schema(
        {"patternProperties": {"^(?i:[^\\p{Lu}\\P{Lu}])$": False}, "additionalProperties": True}
    )
    assert complementary.is_valid({"a": 1})


# Properties the regex module does not implement, so a pattern that names one is refused.
UNIMPLEMENTED_PROPERTIES = {"Changes_When_NFKC_Casefolded", "CWKCF"}


@pytest.mark.parametrize(
    "escape",
    [f"\\p{{{name}}}" for name in [*GENERAL_CATEGORIES, *BINARY_PROPERTIES]]
    + [f"\\P{{gc={name}}}" for name in GENERAL_CATEGORIES]
    + [f"\\p{{Script={name}}}" for name in SCRIPTS]
    + [f"\\p{{scx={name}}}" for name in SCRIPTS],
)
def test_every_property_spelling_ecma_262_accepts_compiles(escape: str) -> None:
    if escape[3:-1] in UNIMPLEMENTED_PROPERTIES:
        with pytest.raises(ValueError):
            compile_ecma_pattern(escape)
    else:
        compile_ecma_pattern(escape)


DIALECT = "https://json-schema.org/draft/2020-12/schema"


@pytest.mark.parametrize(
    ("place", "value", "valid"),
    [
        ({"pattern": "^\\p{Lu}$"}, "A", True),
        ({"pattern": "^\\p{Lu}$"}, "a", False),
        ({"pattern": "^\\w$"}, "é", False),
        ({"patternProperties": {"^\\w$": {}}, "additionalProperties": False}, {"é": 1}, False),
        ({"patternProperties": {"^\\w$": {}}, "additionalProperties": False}, {"a": 1}, True),
    ],
)
@pytest.mark.parametrize("reach", ["allOf", "ref", "root-ref"])
def test_subschema_declaring_the_dialect_keeps_ecma_262_patterns(
    reach: str, place: dict[str, Any], value: Any, valid: bool
) -> None:
    # jsonschema rebuilds the validator for each subschema that declares $schema.
    inner = {"$schema": DIALECT, **place}
    if reach == "allOf":
        schema, instance = {"allOf": [inner]}, value
    elif reach == "ref":
        schema, instance = {"$defs": {"inner": inner}, "$ref": "#/$defs/inner"}, value
    else:
        schema, instance = {**inner, "properties": {"in": {"$ref": "#"}}}, {"in": value}
    assert compile_contract_schema(schema).is_valid(instance) is valid
