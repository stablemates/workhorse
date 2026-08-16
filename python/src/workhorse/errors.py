from __future__ import annotations

import json
from collections.abc import Mapping
from typing import Literal

CompatibilityCode = Literal[
    "schema-not-installed",
    "schema-too-old",
    "schema-too-new",
    "client-protocol-too-old",
    "client-protocol-too-new",
]


class WorkhorseError(Exception):
    """Base class for failures translated by the Workhorse client."""


class ProtocolCompatibilityError(WorkhorseError):
    def __init__(self, code: CompatibilityCode) -> None:
        self.code = code
        super().__init__(f"SQL protocol compatibility check refused mutation: {code}")


class EnqueueIdempotencyConflictError(WorkhorseError):
    def __init__(self, details: Mapping[str, object]) -> None:
        self.details = details
        super().__init__("PostgreSQL rejected a materially different idempotent enqueue")


class DependencyCycleError(WorkhorseError):
    def __init__(self, details: Mapping[str, object]) -> None:
        self.details = details
        super().__init__("PostgreSQL rejected a cyclic job dependency")


class DependencyLimitExceededError(WorkhorseError):
    def __init__(self, details: Mapping[str, object]) -> None:
        self.details = details
        super().__init__("PostgreSQL rejected a job dependency limit")


def translate_database_error(error: Exception) -> WorkhorseError | None:
    sqlstate = getattr(error, "sqlstate", None) or getattr(error, "code", None)
    if sqlstate not in {"P1001", "P1003", "P1005"}:
        return None
    diagnostic = getattr(error, "diag", None)
    raw_detail = getattr(diagnostic, "message_detail", None) or getattr(error, "detail", None)
    details: Mapping[str, object] = {}
    if isinstance(raw_detail, str):
        try:
            parsed = json.loads(raw_detail)
            if isinstance(parsed, dict):
                details = parsed
        except json.JSONDecodeError:
            pass
    elif isinstance(raw_detail, Mapping):
        details = raw_detail
    if sqlstate == "P1001":
        return EnqueueIdempotencyConflictError(details)
    if sqlstate == "P1005":
        return DependencyLimitExceededError(details)
    return DependencyCycleError(details)
