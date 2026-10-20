from __future__ import annotations

import json
import math
import re
from collections.abc import Callable, Iterator, Mapping, Sequence
from decimal import Decimal
from fractions import Fraction
from typing import Any, cast

from jsonschema import Draft202012Validator, ValidationError, validators
from jsonschema.protocols import Validator

from .errors import TaskContractValidationError
from .types import Json, TaskTypeContracts

DIALECT = "https://json-schema.org/draft/2020-12/schema"
DEFINITION_NAME = re.compile(r"[A-Za-z_][-A-Za-z0-9._]*")
DEFINITION_REFERENCE_PREFIX = "#/$defs/"
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
SCHEMA_MAPS = {"$defs", "dependentSchemas", "properties"}
ANNOTATIONS = {
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
    "required",
    "type",
    "uniqueItems",
}


def check_contract_schema(schema: Json) -> None:
    # A reference names the root schema or one root definition. The libraries behind the five
    # SDKs resolve those two forms alike, and both name a schema position the profile walk checked.
    references: list[tuple[str, str]] = []
    _check_profile(schema, "$", references)
    for path, reference in references:
        if not _references_subschema(schema, reference):
            raise TypeError(f"{path} must point at a subschema of the contract")


def _references_subschema(root: Json, reference: str) -> bool:
    if reference == "#":
        return True
    if not reference.startswith(DEFINITION_REFERENCE_PREFIX) or not isinstance(root, dict):
        return False
    definitions = root.get("$defs")
    name = reference[len(DEFINITION_REFERENCE_PREFIX) :]
    return isinstance(definitions, dict) and name in definitions


def _check_profile(schema: Json, path: str, references: list[tuple[str, str]]) -> None:
    if isinstance(schema, bool):
        return
    if not isinstance(schema, dict):
        raise TypeError(f"{path} must be an object or boolean JSON Schema")
    for keyword, value in schema.items():
        keyword_path = f"{path}.{keyword}"
        if keyword == "$ref":
            if not isinstance(value, str) or not value.startswith("#"):
                raise TypeError(f"{keyword_path} must be a bundled local reference")
            references.append((keyword_path, value))
        elif keyword == "$schema":
            if value != DIALECT:
                raise TypeError(f"{keyword_path} must select Draft 2020-12")
        elif keyword == "$defs" and path != "$":
            raise TypeError(f"{keyword_path} must appear only on the root schema")
        elif keyword in SCHEMA_VALUES:
            _check_profile(value, keyword_path, references)
        elif keyword in SCHEMA_ARRAYS:
            if not isinstance(value, list):
                raise TypeError(f"{keyword_path} must be an array")
            for index, child in enumerate(value):
                _check_profile(child, f"{keyword_path}[{index}]", references)
        elif keyword in SCHEMA_MAPS:
            if not isinstance(value, dict):
                raise TypeError(f"{keyword_path} must be an object")
            for name, child in value.items():
                if keyword == "$defs" and not DEFINITION_NAME.fullmatch(name):
                    raise TypeError(
                        f"{keyword_path}.{name} must be a definition name matching "
                        f"^{DEFINITION_NAME.pattern}$"
                    )
                _check_profile(child, f"{keyword_path}.{name}", references)
        elif keyword not in ANNOTATIONS and keyword not in VALIDATION:
            raise TypeError(f"{keyword_path} is outside the Workhorse contract profile")


def _is_number(value: object) -> bool:
    return isinstance(value, int | float) and not isinstance(value, bool)


def _decimal(value: int | float) -> Decimal | float:
    """The decimal that json.dumps writes to PostgreSQL for a number.

    repr gives the shortest decimal that reads back as the same float. A non-finite float stays a
    float, so it compares as before.
    """
    if isinstance(value, int):
        return Decimal(value)
    return Decimal(repr(value)) if math.isfinite(value) else value


def _canonical(value: object) -> object:
    """A hashable key that is equal for two JSON values when the contract treats them as equal."""
    if isinstance(value, bool) or value is None:
        return ("literal", value)
    if _is_number(value):
        return ("number", _decimal(cast(int | float, value)))
    if isinstance(value, list):
        return ("array", tuple(_canonical(item) for item in value))
    if isinstance(value, dict):
        return ("object", frozenset((key, _canonical(item)) for key, item in value.items()))
    return ("string", value)


# jsonschema calls each keyword function with the validator, the keyword value, the instance, and
# the schema, in that order.
_Keyword = Callable[[Validator, Any, Any, Any], Iterator[ValidationError]]


def _bound(holds: Callable[[Decimal | float, Decimal | float], bool], message: str) -> _Keyword:
    def keyword(
        validator: Validator, bound: Any, instance: Any, _schema: Any
    ) -> Iterator[ValidationError]:
        if not validator.is_type(instance, "number"):
            return
        value, limit = _decimal(instance), _decimal(bound)
        if isinstance(value, float) or isinstance(limit, float):
            value, limit = instance, bound
        if not holds(value, limit):
            yield ValidationError(f"{instance!r} {message} {bound!r}")

    return keyword


def _multiple_of(
    validator: Validator, divisor: Any, instance: Any, _schema: Any
) -> Iterator[ValidationError]:
    if not validator.is_type(instance, "number"):
        return
    value, unit = _decimal(instance), _decimal(divisor)
    # Fraction divides exactly. Decimal % would round to the context precision and raise
    # DivisionImpossible for an integer of more than 28 digits.
    if (
        isinstance(value, float)
        or isinstance(unit, float)
        or (Fraction(value) / Fraction(unit)).denominator != 1
    ):
        yield ValidationError(f"{instance!r} is not a multiple of {divisor!r}")


def _const(
    _validator: Validator, const: Any, instance: Any, _schema: Any
) -> Iterator[ValidationError]:
    if _canonical(instance) != _canonical(const):
        yield ValidationError(f"{const!r} was expected")


def _enum(
    _validator: Validator, enums: Any, instance: Any, _schema: Any
) -> Iterator[ValidationError]:
    key = _canonical(instance)
    if all(_canonical(each) != key for each in enums):
        yield ValidationError(f"{instance!r} is not one of {enums!r}")


def _unique_items(
    validator: Validator, unique: Any, instance: Any, _schema: Any
) -> Iterator[ValidationError]:
    if (
        unique
        and validator.is_type(instance, "array")
        and len({_canonical(item) for item in instance}) != len(instance)
    ):
        yield ValidationError(f"{instance!r} has non-unique elements")


# A contract compares the decimal of each number that json.dumps writes to PostgreSQL. The
# library compares an int with the binary value of a float and divides floats in multipleOf, so
# these keywords compare decimals instead.
_ContractValidator = cast(Any, validators.extend)(
    Draft202012Validator,
    {
        "const": _const,
        "enum": _enum,
        "exclusiveMaximum": _bound(lambda value, bound: value < bound, "is not less than"),
        "exclusiveMinimum": _bound(lambda value, bound: value > bound, "is not greater than"),
        "maximum": _bound(lambda value, bound: value <= bound, "is greater than the maximum of"),
        "minimum": _bound(lambda value, bound: value >= bound, "is less than the minimum of"),
        "multipleOf": _multiple_of,
        "uniqueItems": _unique_items,
    },
)


def compile_contract_schema(schema: Json) -> Validator:
    check_contract_schema(schema)
    Draft202012Validator.check_schema(cast(Any, schema))
    return cast(Validator, _ContractValidator(cast(Any, schema)))


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
