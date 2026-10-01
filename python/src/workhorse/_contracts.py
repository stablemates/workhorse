from __future__ import annotations

import json
import re
from collections.abc import Iterator, Mapping, Sequence
from functools import lru_cache
from typing import Any, cast

import regex
from jsonschema import Draft202012Validator, FormatChecker, ValidationError
from jsonschema.validators import extend

from ._ecma_pattern import BackreferenceError, compile_ecma_pattern
from .errors import TaskContractValidationError
from .types import Json, TaskTypeContracts

DIALECT = "https://json-schema.org/draft/2020-12/schema"
SCHEMA_VALUES = {
    "additionalProperties",
    "contains",
    "else",
    "if",
    "items",
    "not",
    "propertyNames",
    "then",
}
SCHEMA_ARRAYS = {"allOf", "anyOf", "oneOf", "prefixItems"}
SCHEMA_MAPS = {"$defs", "dependentSchemas", "patternProperties", "properties"}
ANNOTATIONS = {
    "$anchor",
    "$comment",
    "$schema",
    "default",
    "deprecated",
    "description",
    "examples",
    "format",
    "readOnly",
    "title",
    "writeOnly",
}
VALIDATION = {
    "const",
    "dependentRequired",
    "enum",
    "exclusiveMaximum",
    "exclusiveMinimum",
    "maxContains",
    "maximum",
    "maxItems",
    "maxLength",
    "maxProperties",
    "minContains",
    "minimum",
    "minItems",
    "minLength",
    "minProperties",
    "multipleOf",
    "pattern",
    "required",
    "type",
    "uniqueItems",
}


def check_contract_schema(schema: Json, path: str = "$") -> None:
    if isinstance(schema, bool):
        return
    if not isinstance(schema, dict):
        raise TypeError(f"{path} must be an object or boolean JSON Schema")
    for keyword, value in schema.items():
        keyword_path = f"{path}.{keyword}"
        if keyword == "$ref":
            if not isinstance(value, str) or not value.startswith("#"):
                raise TypeError(f"{keyword_path} must be a bundled local reference")
        elif keyword == "$schema":
            if value != DIALECT:
                raise TypeError(f"{keyword_path} must select Draft 2020-12")
        elif keyword in SCHEMA_VALUES:
            check_contract_schema(value, keyword_path)
        elif keyword in SCHEMA_ARRAYS:
            if not isinstance(value, list):
                raise TypeError(f"{keyword_path} must be an array")
            for index, child in enumerate(value):
                check_contract_schema(child, f"{keyword_path}[{index}]")
        elif keyword in SCHEMA_MAPS:
            if not isinstance(value, dict):
                raise TypeError(f"{keyword_path} must be an object")
            for name, child in value.items():
                if keyword == "patternProperties":
                    _check_pattern(name, f"{keyword_path}.{name}")
                check_contract_schema(child, f"{keyword_path}.{name}")
        elif keyword == "pattern" and isinstance(value, str):
            _check_pattern(value, keyword_path)
        elif keyword not in ANNOTATIONS and keyword not in VALIDATION:
            raise TypeError(f"{keyword_path} is outside the Workhorse contract profile")


def compile_contract_schema(schema: Json) -> Draft202012Validator:
    """Compile a contract schema, raising TypeError or ValueError for one outside the profile.

    A pattern is an ECMA-262 regular expression under the ``u`` flag, as the TypeScript reference
    compiles it, so a pattern outside that grammar raises ValueError.
    """
    check_contract_schema(schema)
    _ContractValidator.check_schema(cast(Any, schema), format_checker=_META_FORMATS)
    return _ContractValidator(cast(Any, _without_dialect(schema)))


def _without_dialect(schema: Json) -> Json:
    """Copy a checked schema without its ``$schema`` keywords, each of which names DIALECT.

    jsonschema builds a fresh validator for each subschema that declares ``$schema``, and it would
    build its registered Draft 2020-12 validator, which matches patterns with re.
    """
    if not isinstance(schema, dict):
        return schema
    copy: dict[str, Json] = {}
    for keyword, value in schema.items():
        if keyword == "$schema":
            continue
        if keyword in SCHEMA_VALUES:
            copy[keyword] = _without_dialect(value)
        elif keyword in SCHEMA_ARRAYS:
            copy[keyword] = [_without_dialect(child) for child in cast(list[Json], value)]
        elif keyword in SCHEMA_MAPS:
            children = cast(dict[str, Json], value)
            copy[keyword] = {name: _without_dialect(child) for name, child in children.items()}
        else:
            copy[keyword] = value
    return copy


# Compiled patterns, shared by every schema that repeats one.
_ecma_pattern = lru_cache(maxsize=1024)(compile_ecma_pattern)


def _check_pattern(pattern: str, path: str) -> None:
    try:
        _ecma_pattern(pattern)
    except BackreferenceError:
        message = f"{path} uses a backreference, which is outside the Workhorse contract profile"
        raise ValueError(message) from None


# Each keyword function takes the (validator, value, instance, schema) arguments jsonschema passes.
def _pattern(
    validator: Any, pattern: str, instance: Any, _schema: Any
) -> Iterator[ValidationError]:
    if validator.is_type(instance, "string") and not _ecma_pattern(pattern).search(instance):
        yield ValidationError(f"{instance!r} does not match {pattern!r}")


def _pattern_properties(
    validator: Any, patterns: Mapping[str, Any], instance: Any, _schema: Any
) -> Iterator[ValidationError]:
    if not validator.is_type(instance, "object"):
        return
    for pattern, subschema in patterns.items():
        compiled = _ecma_pattern(pattern)
        for name, value in instance.items():
            if compiled.search(name):
                yield from validator.descend(value, subschema, path=name, schema_path=pattern)


def _additional_properties(
    validator: Any, additional: Any, instance: Any, schema: Mapping[str, Any]
) -> Iterator[ValidationError]:
    if not validator.is_type(instance, "object"):
        return
    properties = schema.get("properties", {})
    patterns: list[regex.Pattern[str]] = [
        _ecma_pattern(pattern) for pattern in schema.get("patternProperties", {})
    ]
    extras = [
        name
        for name in instance
        if name not in properties and not any(pattern.search(name) for pattern in patterns)
    ]
    if validator.is_type(additional, "object"):
        for extra in extras:
            yield from validator.descend(instance[extra], additional, path=extra)
    elif not additional and extras:
        listed = ", ".join(repr(extra) for extra in sorted(extras))
        yield ValidationError(f"Additional properties are not allowed ({listed} unexpected)")


# The meta-schema's own format checks, except that check_contract_schema has already compiled every
# pattern as ECMA-262, where the regex format would compile it with re.
_META_FORMATS = FormatChecker(
    [name for name in Draft202012Validator.FORMAT_CHECKER.checkers if name != "regex"]
)

# Draft 2020-12 with every pattern keyword matching under ECMA-262 semantics instead of re's.
_ContractValidator: type[Draft202012Validator] = cast(Any, extend)(
    Draft202012Validator,
    validators={
        "additionalProperties": _additional_properties,
        "pattern": _pattern,
        "patternProperties": _pattern_properties,
    },
)


def apply_contract(
    row: Mapping[str, object],
    task_type: str,
    payload: Json,
    request: dict[str, Json],
    cache: dict[tuple[str, str], Any],
) -> None:
    version = str(row["version"])
    document = row["schema"]
    if isinstance(document, str):
        document = json.loads(document)
    if not isinstance(document, Mapping) or "payload" not in document:
        raise RuntimeError("workhorse.get_contract_definition_v1 returned an invalid schema")
    validator = cache.get((task_type, version))
    if validator is None:
        validator = compile_contract_schema(cast(Json, document["payload"]))
        cache[(task_type, version)] = validator
    if not validator.is_valid(payload):
        raise TaskContractValidationError(task_type, version, "payload")
    request.update(
        {
            "contractVersion": version,
            "payloadMaxBytes": cast(int, row["payload_max_bytes"]),
            "resultMaxBytes": cast(int, row["result_max_bytes"]),
            "sensitivePayloadKeys": cast(
                Json, list(cast(Sequence[str], row["payload_redact_keys"]))
            ),
            "sensitiveResultKeys": cast(Json, list(cast(Sequence[str], row["result_redact_keys"]))),
        }
    )


def validate_contract_value(
    task_type: str, version: str, kind: str, schema: Json, value: Json
) -> None:
    if not compile_contract_schema(schema).is_valid(value):
        raise TaskContractValidationError(task_type, version, kind)


def serialize_contracts(contracts: Mapping[str, TaskTypeContracts]) -> list[dict[str, Json]]:
    definitions: list[dict[str, Json]] = []
    for task_type, contract in contracts.items():
        versions: dict[str, Json] = {}
        for version, document in contract.versions.items():
            payload_schema = document.payload_schema
            result_schema = document.result_schema
            compile_contract_schema(payload_schema)
            compile_contract_schema(result_schema)
            versions[version] = {
                "payloadSchema": payload_schema,
                "resultSchema": result_schema,
                "maxPayloadBytes": document.max_payload_bytes,
                "maxResultBytes": document.max_result_bytes,
                "sensitivePayloadKeys": list(document.sensitive_payload_keys),
                "sensitiveResultKeys": list(document.sensitive_result_keys),
            }
        definitions.append(
            {
                "taskType": task_type,
                "currentVersion": contract.current_version,
                "versions": versions,
            }
        )
    return definitions


_EXPONENT_NUMBER = re.compile(r"^(-?)(\d+)(?:\.(\d+))?e([+-]\d+)$")


def jsonb_text_bytes(value: object) -> int:
    """Measure octet_length(value::jsonb::text) for a value json.loads produced.

    PostgreSQL prints jsonb with a space after every separator, keeps non-ASCII characters
    unescaped, and prints numbers as numeric text, which never uses an exponent. The walk keeps
    its own stack, so any nesting json.loads produced measures without reaching the recursion
    limit.
    """
    total = 0
    pending: list[object] = [value]
    while pending:
        item = pending.pop()
        if isinstance(item, list):
            total += 2 + max(0, len(item) - 1) * 2
            pending.extend(item)
        elif isinstance(item, dict):
            total += 2 + max(0, len(item) - 1) * 2
            for key, member in item.items():
                total += _string_bytes(key) + 2
                pending.append(member)
        else:
            total += _scalar_bytes(item)
    return total


def _scalar_bytes(value: object) -> int:
    if value is None or value is True:
        return 4
    if value is False:
        return 5
    if isinstance(value, int):
        return len(str(value))
    if isinstance(value, float):
        return _numeric_text_bytes(value)
    if isinstance(value, str):
        return _string_bytes(value)
    raise TypeError(f"Object of type {type(value).__name__} is not JSON serializable")


def _string_bytes(value: str) -> int:
    # Python escapes exactly the characters PostgreSQL's escape_json escapes, with the same text.
    return len(json.dumps(value, ensure_ascii=False).encode("utf-8"))


def _numeric_text_bytes(value: float) -> int:
    # Numeric text has no negative zero, so -0.0 prints as 0.0.
    token = repr(abs(value) if value == 0 else value)
    match = _EXPONENT_NUMBER.match(token)
    if match is None:
        return len(token)
    sign, integer, fraction, exponent_text = match.groups()
    fraction = fraction or ""
    exponent = int(exponent_text)
    scale = max(0, len(fraction) - exponent)
    integer_length = max(1, len(integer) + exponent)
    return len(sign) + integer_length + (1 + scale if scale > 0 else 0)
