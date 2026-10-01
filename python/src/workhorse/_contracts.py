from __future__ import annotations

import json
import re
from collections.abc import Mapping, Sequence
from typing import Any, cast
from urllib.parse import unquote

from jsonschema import Draft202012Validator

from .errors import TaskContractValidationError
from .types import Json, TaskTypeContracts

DIALECT = "https://json-schema.org/draft/2020-12/schema"
_MISSING = object()
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
    "required",
    "type",
    "uniqueItems",
}


def check_contract_schema(schema: Json) -> None:
    # Every reference must name a schema position the profile walk checked. A reference into
    # `default` or `examples` would otherwise apply a schema the walk never saw.
    anchors: set[str] = set()
    references: list[tuple[str, str]] = []
    _check_profile(schema, "$", anchors, references)
    for path, reference in references:
        if not _references_subschema(schema, reference, anchors):
            raise TypeError(f"{path} must point at a subschema of the contract")


def _references_subschema(root: Json, reference: str, anchors: set[str]) -> bool:
    fragment = reference[1:]
    if fragment == "":
        return True
    if not fragment.startswith("/"):
        return fragment in anchors
    try:
        decoded = [unquote(token, errors="strict") for token in fragment.split("/")[1:]]
    except UnicodeDecodeError:
        return False
    # Libraries disagree on whether `%2F` separates tokens, so the walk could check a
    # different schema.
    if any("/" in token for token in decoded):
        return False
    tokens = [token.replace("~1", "/").replace("~0", "~") for token in decoded]
    node: object = root
    index = 0
    while index < len(tokens):
        if not isinstance(node, dict):
            return False
        keyword = tokens[index]
        value = node.get(keyword, _MISSING)
        if keyword in SCHEMA_VALUES:
            node = value
        elif keyword in SCHEMA_ARRAYS and isinstance(value, list):
            index += 1
            if index == len(tokens) or not re.fullmatch(r"0|[1-9][0-9]*", tokens[index]):
                return False
            position = int(tokens[index])
            node = value[position] if position < len(value) else _MISSING
        elif keyword in SCHEMA_MAPS and isinstance(value, dict):
            index += 1
            if index == len(tokens):
                return False
            node = value.get(tokens[index], _MISSING)
        else:
            return False
        if node is _MISSING:
            return False
        index += 1
    return True


def _check_profile(
    schema: Json, path: str, anchors: set[str], references: list[tuple[str, str]]
) -> None:
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
        elif keyword == "$anchor":
            # Libraries disagree on which of two equal anchors a reference names.
            if isinstance(value, str):
                if value in anchors:
                    raise TypeError(f"{keyword_path} must declare a unique anchor")
                anchors.add(value)
        elif keyword == "$schema":
            if value != DIALECT:
                raise TypeError(f"{keyword_path} must select Draft 2020-12")
        elif keyword in SCHEMA_VALUES:
            _check_profile(value, keyword_path, anchors, references)
        elif keyword in SCHEMA_ARRAYS:
            if not isinstance(value, list):
                raise TypeError(f"{keyword_path} must be an array")
            for index, child in enumerate(value):
                _check_profile(child, f"{keyword_path}[{index}]", anchors, references)
        elif keyword in SCHEMA_MAPS:
            if not isinstance(value, dict):
                raise TypeError(f"{keyword_path} must be an object")
            for name, child in value.items():
                _check_profile(child, f"{keyword_path}.{name}", anchors, references)
        elif keyword not in ANNOTATIONS and keyword not in VALIDATION:
            raise TypeError(f"{keyword_path} is outside the Workhorse contract profile")


def compile_contract_schema(schema: Json) -> Draft202012Validator:
    check_contract_schema(schema)
    Draft202012Validator.check_schema(cast(Any, schema))
    return Draft202012Validator(cast(Any, schema))


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
