from __future__ import annotations

from collections.abc import Mapping
from typing import Any, cast

from jsonschema import Draft202012Validator

from .errors import JobContractValidationError
from .types import JobTypeContracts, Json

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
                check_contract_schema(child, f"{keyword_path}.{name}")
        elif keyword not in ANNOTATIONS and keyword not in VALIDATION:
            raise TypeError(f"{keyword_path} is outside the Workhorse contract profile")


def compile_contract_schema(schema: Json) -> Draft202012Validator:
    check_contract_schema(schema)
    Draft202012Validator.check_schema(cast(Any, schema))
    return Draft202012Validator(cast(Any, schema))


def validate_contract_value(
    job_type: str, version: str, kind: str, schema: Json, value: Json
) -> None:
    if not compile_contract_schema(schema).is_valid(value):
        raise JobContractValidationError(job_type, version, kind)


def serialize_contracts(contracts: Mapping[str, JobTypeContracts]) -> list[dict[str, Json]]:
    definitions: list[dict[str, Json]] = []
    for job_type, contract in contracts.items():
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
            {"jobType": job_type, "currentVersion": contract.current_version, "versions": versions}
        )
    return definitions
