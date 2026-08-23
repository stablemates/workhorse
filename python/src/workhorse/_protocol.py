from __future__ import annotations

import json
from collections.abc import Mapping, Sequence
from datetime import datetime, timezone
from typing import cast

from .errors import CompatibilityCode, ProtocolCompatibilityError
from .types import (
    ClaimedJob,
    Debounce,
    Dependencies,
    EnqueueOptions,
    EnqueueRequest,
    Idempotency,
    Json,
    ScheduleDefinition,
    Throttle,
)

PROTOCOL_VERSION = 1
MINIMUM_PROTOCOL_VERSION = 1
MAXIMUM_PROTOCOL_VERSION = 1
MINIMUM_SCHEMA_VERSION = 1
MAXIMUM_SCHEMA_VERSION = 1
DEFAULT_VALUE_MAX_BYTES = 1_048_576
MAX_BATCH_SIZE = 1_000


def compatibility_refusal(
    installed_schema_version: int | None,
    client_protocol_version: int = PROTOCOL_VERSION,
) -> CompatibilityCode | None:
    if installed_schema_version is None:
        return "schema-not-installed"
    if installed_schema_version < MINIMUM_SCHEMA_VERSION:
        return "schema-too-old"
    if installed_schema_version > MAXIMUM_SCHEMA_VERSION:
        return "schema-too-new"
    if client_protocol_version < MINIMUM_PROTOCOL_VERSION:
        return "client-protocol-too-old"
    if client_protocol_version > MAXIMUM_PROTOCOL_VERSION:
        return "client-protocol-too-new"
    return None


def assert_compatible(rows: Sequence[Mapping[str, object]]) -> None:
    installed = rows[0].get("version") if len(rows) == 1 else None
    refusal = compatibility_refusal(installed if isinstance(installed, int) else None)
    if refusal is not None:
        raise ProtocolCompatibilityError(refusal)


def serialize_requests(requests: Sequence[EnqueueRequest], default_queue: str) -> str:
    if len(requests) > MAX_BATCH_SIZE:
        raise ValueError(f"enqueue_many accepts at most {MAX_BATCH_SIZE} requests")
    return json.dumps(
        [serialize_request(request, default_queue) for request in requests],
        separators=(",", ":"),
        ensure_ascii=False,
    )


def serialize_schedules(definitions: Sequence[ScheduleDefinition], default_queue: str) -> str:
    values: list[dict[str, Json]] = []
    for definition in definitions:
        job = definition.job
        _validate_priority(job.priority)
        values.append(
            {
                "name": definition.name,
                "schedule": definition.schedule,
                "timezone": definition.timezone,
                "enabled": definition.enabled,
                "queue": job.queue or default_queue,
                "priority": job.priority,
                "concurrencyKey": job.concurrency_key,
                "type": job.type,
                "payload": job.payload,
                "maxAttempts": job.max_attempts,
                "retryPolicy": dict(job.retry_policy) if job.retry_policy is not None else None,
                "contractVersion": None,
                "payloadMaxBytes": DEFAULT_VALUE_MAX_BYTES,
                "resultMaxBytes": DEFAULT_VALUE_MAX_BYTES,
                "sensitivePayloadKeys": [],
                "sensitiveResultKeys": [],
            }
        )
    return json.dumps(values, separators=(",", ":"), ensure_ascii=False)


def serialize_request(request: EnqueueRequest, default_queue: str) -> dict[str, Json]:
    options = request.options
    _validate_options(options)
    dependencies = _dependencies(options.dependencies)
    value: dict[str, Json] = {
        "queue": options.queue or default_queue,
        "type": request.type,
        "payload": request.payload,
        "priority": options.priority,
        "contractVersion": None,
        "payloadMaxBytes": DEFAULT_VALUE_MAX_BYTES,
        "resultMaxBytes": DEFAULT_VALUE_MAX_BYTES,
        "sensitivePayloadKeys": [],
        "sensitiveResultKeys": [],
        "deadline": _timestamp(options.deadline),
        "concurrencyKey": options.concurrency_key,
        "executionTimeoutMs": options.execution_timeout_ms,
        "maxAttempts": options.max_attempts,
        "retryPolicy": dict(options.retry_policy) if options.retry_policy is not None else None,
        "prerequisiteJobId": None,
        "dependencies": dependencies,
        "tags": list(options.tags),
    }
    keyed = options.idempotency or options.debounce or options.throttle
    if options.run_at is not None or keyed is None:
        value["runAt"] = _timestamp(options.run_at or datetime.now(timezone.utc))
    if options.idempotency is not None:
        value["idempotency"] = _idempotency(options.idempotency)
    if options.debounce is not None:
        value["debounce"] = _debounce(options.debounce)
    if options.throttle is not None:
        value["throttle"] = _throttle(options.throttle)
    return value


def serialize_child_request(
    parent: ClaimedJob,
    type: str,
    payload: Json,
    options: EnqueueOptions,
    default_queue: str,
) -> dict[str, Json]:
    _validate_options(options)
    if any((options.idempotency, options.debounce, options.throttle, options.dependencies)):
        raise TypeError("Child jobs cannot use coalescing or dependency enqueue options")
    value: dict[str, Json] = {
        "queue": options.queue or default_queue,
        "type": type,
        "payload": payload,
        "priority": options.priority,
        "contractVersion": None,
        "payloadMaxBytes": DEFAULT_VALUE_MAX_BYTES,
        "resultMaxBytes": DEFAULT_VALUE_MAX_BYTES,
        "sensitivePayloadKeys": [],
        "sensitiveResultKeys": [],
        "deadline": _timestamp(options.deadline),
        "concurrencyKey": options.concurrency_key,
        "executionTimeoutMs": options.execution_timeout_ms,
        "maxAttempts": options.max_attempts,
        "retryPolicy": dict(options.retry_policy) if options.retry_policy is not None else None,
        "prerequisiteJobId": None,
        "dependencies": None,
        "tags": list(options.tags),
    }
    if parent.trace_context is not None:
        value["traceContext"] = parent.trace_context
    if options.run_at is not None:
        value["runAt"] = _timestamp(options.run_at)
    return value


def _validate_options(options: EnqueueOptions) -> None:
    keyed_modes = (options.idempotency, options.debounce, options.throttle)
    modes = sum(mode is not None for mode in keyed_modes)
    if modes > 1:
        raise ValueError("enqueue options cannot combine idempotency, debounce, or throttle")
    _validate_priority(options.priority)
    if options.max_attempts < 1:
        raise ValueError("max_attempts must be positive")
    if options.debounce is not None and options.run_at is not None:
        raise ValueError("debounced enqueue uses its PostgreSQL-owned window instead of run_at")
    if (options.debounce is not None or options.throttle is not None) and options.dependencies:
        raise ValueError("enqueue options cannot combine debounce or throttle with dependencies")


def _validate_priority(priority: int) -> None:
    if not 0 <= priority <= 100:
        raise ValueError("priority must be between 0 and 100")


def _timestamp(value: datetime | None) -> str | None:
    if value is None:
        return None
    if value.tzinfo is None or value.utcoffset() is None:
        raise ValueError("timestamps must include a timezone")
    return value.astimezone(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _idempotency(value: Idempotency) -> dict[str, Json]:
    return {"key": value.key, "scope": value.scope, "ttlMs": value.ttl_ms}


def _debounce(value: Debounce) -> dict[str, Json]:
    return {
        "key": value.key,
        "scope": value.scope,
        "windowMs": value.window_ms,
        "schedule": value.schedule,
    }


def _throttle(value: Throttle) -> dict[str, Json]:
    return {"key": value.key, "scope": value.scope, "windowMs": value.window_ms}


def _dependencies(value: Dependencies | None) -> dict[str, Json] | None:
    if value is None:
        return None
    ids = sorted(value.prerequisite_job_ids)
    if not ids or len(ids) != len(set(ids)):
        raise ValueError("dependencies must contain unique prerequisite_job_ids")
    return {
        "prerequisiteJobIds": cast(list[Json], ids),
        "onSuccess": value.on_success,
        "onFailure": value.on_failure,
        "onCancellation": value.on_cancellation,
    }
