from __future__ import annotations

import json

from .types import Json

MAX_EXTERNAL_WAIT_NAME_CHARACTERS = 200
MAX_EXTERNAL_WAIT_TIMEOUT_MS = 604_800_000
MAX_EXTERNAL_WAIT_VALUE_BYTES = 65_536


def validate_wait_name(name: str, label: str) -> str:
    if not isinstance(name, str) or not name:
        raise TypeError(f"{label} name must be a non-empty string")
    if name != name.strip():
        raise ValueError(f"{label} name must not have leading or trailing whitespace")
    if len(name) > MAX_EXTERNAL_WAIT_NAME_CHARACTERS:
        raise ValueError(
            f"{label} name must contain at most {MAX_EXTERNAL_WAIT_NAME_CHARACTERS} characters"
        )
    return name


def validate_wait_timeout(timeout_ms: int | None, label: str) -> int | None:
    if timeout_ms is None:
        return None
    if isinstance(timeout_ms, bool) or not isinstance(timeout_ms, int):
        raise TypeError(f"{label} timeout_ms must be an integer number of milliseconds")
    if not 1 <= timeout_ms <= MAX_EXTERNAL_WAIT_TIMEOUT_MS:
        raise ValueError(f"{label} timeout_ms must be between 1 and {MAX_EXTERNAL_WAIT_TIMEOUT_MS}")
    return timeout_ms


def encode_wait_value(value: Json, label: str) -> str:
    encoded = json.dumps(value, separators=(",", ":"), allow_nan=False, ensure_ascii=False)
    if len(encoded.encode()) > MAX_EXTERNAL_WAIT_VALUE_BYTES:
        raise ValueError(f"{label} must encode to at most {MAX_EXTERNAL_WAIT_VALUE_BYTES} bytes")
    return encoded


def validate_idempotency_key(value: str, label: str) -> str:
    if not isinstance(value, str) or not value:
        raise TypeError(f"{label} must be a non-empty string")
    if len(value.encode()) > 512:
        raise ValueError(f"{label} must contain at most 512 UTF-8 bytes")
    return value


def validate_requested_by(value: str, label: str) -> str:
    if not isinstance(value, str) or not 1 <= len(value) <= 200:
        raise ValueError(f"{label} must contain between 1 and 200 characters")
    return value
