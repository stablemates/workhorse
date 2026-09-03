from __future__ import annotations

import json
from collections.abc import Mapping, Sequence
from datetime import UTC, datetime, timedelta
from typing import TYPE_CHECKING, Any, Literal, NoReturn, cast

from ._compatibility import (
    assert_async_compatible as _assert_async_compatible,
    assert_sync_compatible as _assert_sync_compatible,
)
from ._contracts import (
    compile_contract_schema as _compile_contract_schema,
    serialize_contracts as _serialize_contracts,
)
from ._drivers import (
    AsyncpgConnection as _AsyncpgConnection,
    AsyncpgExecutor as _AsyncpgExecutor,
    AsyncPsycopgConnection as _AsyncPsycopgConnection,
    AsyncPsycopgExecutor as _AsyncPsycopgExecutor,
    PsycopgConnection as _PsycopgConnection,
    Row as _Row,
    SyncExecutor as _SyncExecutor,
)
from ._external_waits import (
    encode_wait_value as _encode_wait_value,
    validate_idempotency_key as _validate_idempotency_key,
    validate_requested_by as _validate_requested_by,
    validate_wait_name as _validate_wait_name,
)
from ._protocol import (
    serialize_requests as _serialize_requests,
    serialize_schedules as _serialize_schedules,
)
from ._statements import STATEMENTS as _STATEMENTS
from ._telemetry import inject_trace_context as _inject_trace_context
from .errors import (
    HumanWaitIdempotencyConflictError,
    JobContractValidationError,
    SignalIdempotencyConflictError,
    _translate_database_error,
)
from .types import (
    CancelResult,
    ConcurrencyPolicy,
    ConcurrencyPolicyDefinition,
    EnqueueOptions,
    EnqueueRequest,
    EnqueueResult,
    HumanWaitCompletionResult,
    JobTypeContracts,
    Json,
    QueueHealth,
    RateLimit,
    RateLimitPolicy,
    RateLimitPolicyDefinition,
    ScheduleDefinition,
    SignalDeliveryResult,
)

if TYPE_CHECKING:
    import psycopg

    _SyncConnection = psycopg.Connection[Any]
    _AsyncPsycopgConnectionInput = psycopg.AsyncConnection[Any]
else:
    _SyncConnection = _PsycopgConnection
    _AsyncPsycopgConnectionInput = _AsyncPsycopgConnection


class Queue:
    """Synchronous enqueue client over a caller-owned Psycopg connection."""

    def __init__(self, connection: _SyncConnection, default_queue: str = "default") -> None:
        self._executor = _SyncExecutor(cast(_PsycopgConnection, connection))
        self.default_queue = default_queue
        self._contract_validators: dict[tuple[str, str], Any] = {}
        self._contracts_enabled = False

    def enqueue(self, type: str, payload: Json, options: EnqueueOptions | None = None) -> str:
        return self.enqueue_with_result(type, payload, options).job_id

    def health(self) -> QueueHealth:
        """Read PostgreSQL's database-authoritative queue health snapshot."""
        _assert_sync_compatible(self._executor)
        row = _one_row(
            self._executor.rows(_STATEMENTS.health, (_health_window_start(),)),
            "workhorse.queue_health_v1",
        )
        return _health_document(row.get("snapshot"))

    def cancel(
        self,
        job_id: str,
        *,
        requested_by: str | None = None,
        reason: str | None = None,
    ) -> CancelResult:
        """Request cooperative cancellation with optional audit attribution."""
        _assert_sync_compatible(self._executor)
        row = _one_row(
            self._executor.rows(_STATEMENTS.cancel, (job_id, requested_by, reason)),
            "workhorse.cancel_v1",
        )
        return _cancel_result(row, job_id)

    def enqueue_with_result(
        self, type: str, payload: Json, options: EnqueueOptions | None = None
    ) -> EnqueueResult:
        return self.enqueue_many_with_results(
            [EnqueueRequest(type, payload, options or EnqueueOptions())]
        )[0]

    def enqueue_many(self, requests: Sequence[EnqueueRequest]) -> list[str]:
        return [result.job_id for result in self.enqueue_many_with_results(requests)]

    def enqueue_many_with_results(self, requests: Sequence[EnqueueRequest]) -> list[EnqueueResult]:
        if not requests:
            return []
        _assert_sync_compatible(self._executor)
        values = cast(
            list[dict[str, Json]],
            json.loads(_serialize_requests(requests, self.default_queue, _inject_trace_context())),
        )
        if self._contracts_enabled:
            for request, value in zip(requests, values, strict=True):
                rows = self._executor.rows(_STATEMENTS.get_contract, (request.type, None))
                if rows:
                    _apply_contract(
                        rows[0], request.type, request.payload, value, self._contract_validators
                    )
        payload = json.dumps(values, separators=(",", ":"), ensure_ascii=False)
        try:
            return _results(self._executor.rows(_STATEMENTS.enqueue_many, (payload,)))
        except Exception as error:
            _raise_translated(error)

    def sync_schedules(
        self,
        namespace: str,
        definitions: Sequence[ScheduleDefinition],
        *,
        prune: bool = True,
    ) -> None:
        _assert_sync_compatible(self._executor)
        payload = _serialize_schedules(definitions, self.default_queue)
        self._executor.rows(_STATEMENTS.sync_schedules, (namespace, payload, prune))

    def sync_concurrency_policies(
        self,
        namespace: str,
        definitions: Sequence[ConcurrencyPolicyDefinition],
        *,
        prune: bool = True,
    ) -> list[ConcurrencyPolicy]:
        _assert_sync_compatible(self._executor)
        rows = self._executor.rows(
            _STATEMENTS.sync_concurrency_policies,
            (namespace, _concurrency_policy_payload(definitions), prune),
        )
        return [_concurrency_policy(row) for row in rows]

    def list_concurrency_policies(self, queue_names: Sequence[str] = ()) -> list[ConcurrencyPolicy]:
        rows = self._executor.rows(_STATEMENTS.list_concurrency_policies, (list(queue_names),))
        return [_concurrency_policy(row) for row in rows]

    def sync_rate_limit_policies(
        self,
        namespace: str,
        definitions: Sequence[RateLimitPolicyDefinition],
        *,
        prune: bool = True,
    ) -> list[RateLimitPolicy]:
        _assert_sync_compatible(self._executor)
        rows = self._executor.rows(
            _STATEMENTS.sync_rate_limit_policies,
            (namespace, _rate_limit_policy_payload(definitions), prune),
        )
        return [_rate_limit_policy(row) for row in rows]

    def list_rate_limit_policies(self, queue_names: Sequence[str] = ()) -> list[RateLimitPolicy]:
        names = list(queue_names)
        rows = self._executor.rows(_STATEMENTS.list_rate_limit_policies, (names,))
        return [_rate_limit_policy(row) for row in rows]

    def sync_contracts(self, contracts: Mapping[str, JobTypeContracts]) -> None:
        _assert_sync_compatible(self._executor)
        payload = json.dumps(_serialize_contracts(contracts), separators=(",", ":"))
        self._executor.rows(_STATEMENTS.sync_contracts, (payload,))
        self._contracts_enabled = True

    def send_signal(
        self,
        job_id: str,
        name: str,
        payload: Json,
        *,
        idempotency_key: str,
        requested_by: str,
    ) -> SignalDeliveryResult:
        _assert_sync_compatible(self._executor)
        row = _one_row(
            self._executor.rows(
                _STATEMENTS.send_signal,
                _signal_parameters(job_id, name, payload, idempotency_key, requested_by),
            ),
            "workhorse.send_signal_v1",
        )
        return _signal_result(row, job_id, name)

    def complete_human_wait(
        self,
        job_id: str,
        name: str,
        result: Json,
        *,
        idempotency_key: str,
        requested_by: str,
    ) -> HumanWaitCompletionResult:
        _assert_sync_compatible(self._executor)
        row = _one_row(
            self._executor.rows(
                _STATEMENTS.complete_human_wait,
                _human_parameters(job_id, name, result, idempotency_key, requested_by),
            ),
            "workhorse.complete_human_wait_v1",
        )
        return _human_result(row, job_id, name)


class AsyncQueue:
    """Asynchronous enqueue client over a caller-owned Psycopg or asyncpg connection."""

    def __init__(
        self,
        executor: _AsyncPsycopgExecutor | _AsyncpgExecutor,
        default_queue: str = "default",
    ) -> None:
        self._executor = executor
        self.default_queue = default_queue
        self._contract_validators: dict[tuple[str, str], Any] = {}
        self._contracts_enabled = False

    @classmethod
    def from_psycopg(
        cls, connection: _AsyncPsycopgConnectionInput, default_queue: str = "default"
    ) -> AsyncQueue:
        return cls(_AsyncPsycopgExecutor(cast(_AsyncPsycopgConnection, connection)), default_queue)

    @classmethod
    def from_asyncpg(
        cls, connection: _AsyncpgConnection, default_queue: str = "default"
    ) -> AsyncQueue:
        return cls(_AsyncpgExecutor(connection), default_queue)

    async def enqueue(self, type: str, payload: Json, options: EnqueueOptions | None = None) -> str:
        return (await self.enqueue_with_result(type, payload, options)).job_id

    async def health(self) -> QueueHealth:
        """Read PostgreSQL's database-authoritative queue health snapshot."""
        await _assert_async_compatible(self._executor)
        row = _one_row(
            await self._executor.rows(_STATEMENTS.health, (_health_window_start(),)),
            "workhorse.queue_health_v1",
        )
        return _health_document(row.get("snapshot"))

    async def cancel(
        self,
        job_id: str,
        *,
        requested_by: str | None = None,
        reason: str | None = None,
    ) -> CancelResult:
        """Request cooperative cancellation with optional audit attribution."""
        await _assert_async_compatible(self._executor)
        row = _one_row(
            await self._executor.rows(_STATEMENTS.cancel, (job_id, requested_by, reason)),
            "workhorse.cancel_v1",
        )
        return _cancel_result(row, job_id)

    async def enqueue_with_result(
        self, type: str, payload: Json, options: EnqueueOptions | None = None
    ) -> EnqueueResult:
        return (
            await self.enqueue_many_with_results(
                [EnqueueRequest(type, payload, options or EnqueueOptions())]
            )
        )[0]

    async def enqueue_many(self, requests: Sequence[EnqueueRequest]) -> list[str]:
        return [result.job_id for result in await self.enqueue_many_with_results(requests)]

    async def enqueue_many_with_results(
        self, requests: Sequence[EnqueueRequest]
    ) -> list[EnqueueResult]:
        if not requests:
            return []
        await _assert_async_compatible(self._executor)
        values = cast(
            list[dict[str, Json]],
            json.loads(_serialize_requests(requests, self.default_queue, _inject_trace_context())),
        )
        if self._contracts_enabled:
            for request, value in zip(requests, values, strict=True):
                rows = await self._executor.rows(_STATEMENTS.get_contract, (request.type, None))
                if rows:
                    _apply_contract(
                        rows[0], request.type, request.payload, value, self._contract_validators
                    )
        payload = json.dumps(values, separators=(",", ":"), ensure_ascii=False)
        try:
            return _results(await self._executor.rows(_STATEMENTS.enqueue_many, (payload,)))
        except Exception as error:
            _raise_translated(error)

    async def sync_schedules(
        self,
        namespace: str,
        definitions: Sequence[ScheduleDefinition],
        *,
        prune: bool = True,
    ) -> None:
        await _assert_async_compatible(self._executor)
        payload = _serialize_schedules(definitions, self.default_queue)
        await self._executor.rows(_STATEMENTS.sync_schedules, (namespace, payload, prune))

    async def sync_concurrency_policies(
        self,
        namespace: str,
        definitions: Sequence[ConcurrencyPolicyDefinition],
        *,
        prune: bool = True,
    ) -> list[ConcurrencyPolicy]:
        await _assert_async_compatible(self._executor)
        rows = await self._executor.rows(
            _STATEMENTS.sync_concurrency_policies,
            (namespace, _concurrency_policy_payload(definitions), prune),
        )
        return [_concurrency_policy(row) for row in rows]

    async def list_concurrency_policies(
        self, queue_names: Sequence[str] = ()
    ) -> list[ConcurrencyPolicy]:
        names = list(queue_names)
        rows = await self._executor.rows(_STATEMENTS.list_concurrency_policies, (names,))
        return [_concurrency_policy(row) for row in rows]

    async def sync_rate_limit_policies(
        self,
        namespace: str,
        definitions: Sequence[RateLimitPolicyDefinition],
        *,
        prune: bool = True,
    ) -> list[RateLimitPolicy]:
        await _assert_async_compatible(self._executor)
        rows = await self._executor.rows(
            _STATEMENTS.sync_rate_limit_policies,
            (namespace, _rate_limit_policy_payload(definitions), prune),
        )
        return [_rate_limit_policy(row) for row in rows]

    async def list_rate_limit_policies(
        self, queue_names: Sequence[str] = ()
    ) -> list[RateLimitPolicy]:
        names = list(queue_names)
        rows = await self._executor.rows(_STATEMENTS.list_rate_limit_policies, (names,))
        return [_rate_limit_policy(row) for row in rows]

    async def sync_contracts(self, contracts: Mapping[str, JobTypeContracts]) -> None:
        await _assert_async_compatible(self._executor)
        payload = json.dumps(_serialize_contracts(contracts), separators=(",", ":"))
        await self._executor.rows(_STATEMENTS.sync_contracts, (payload,))
        self._contracts_enabled = True

    async def send_signal(
        self,
        job_id: str,
        name: str,
        payload: Json,
        *,
        idempotency_key: str,
        requested_by: str,
    ) -> SignalDeliveryResult:
        await _assert_async_compatible(self._executor)
        row = _one_row(
            await self._executor.rows(
                _STATEMENTS.send_signal,
                _signal_parameters(job_id, name, payload, idempotency_key, requested_by),
            ),
            "workhorse.send_signal_v1",
        )
        return _signal_result(row, job_id, name)

    async def complete_human_wait(
        self,
        job_id: str,
        name: str,
        result: Json,
        *,
        idempotency_key: str,
        requested_by: str,
    ) -> HumanWaitCompletionResult:
        await _assert_async_compatible(self._executor)
        row = _one_row(
            await self._executor.rows(
                _STATEMENTS.complete_human_wait,
                _human_parameters(job_id, name, result, idempotency_key, requested_by),
            ),
            "workhorse.complete_human_wait_v1",
        )
        return _human_result(row, job_id, name)


def _raise_translated(error: Exception) -> NoReturn:
    translated = _translate_database_error(error)
    if translated is not None:
        raise translated from error
    raise error


def _apply_contract(
    row: _Row,
    job_type: str,
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
    validator = cache.get((job_type, version))
    if validator is None:
        validator = _compile_contract_schema(cast(Json, document["payload"]))
        cache[(job_type, version)] = validator
    if not validator.is_valid(payload):
        raise JobContractValidationError(job_type, version, "payload")
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


def _health_window_start() -> datetime:
    return datetime.now(UTC) - timedelta(days=1)


def _health_document(value: object) -> QueueHealth:
    if isinstance(value, str | bytes | bytearray):
        value = json.loads(value)
    if not isinstance(value, Mapping):
        raise RuntimeError(
            f"workhorse.queue_health_v1 returned {type(value).__name__}; expected JSON object"
        )
    return cast(QueueHealth, dict(value))


def _cancel_result(row: _Row, job_id: str) -> CancelResult:
    return CancelResult(
        status=cast(Any, row["status"]),
        job_id=job_id,
        state=cast(Any, row["state"]),
        current_attempt=cast(int | None, row["current_attempt"]),
        requested_at=cast(datetime | None, row["requested_at"]),
        requested_by=cast(str | None, row["requested_by"]),
        reason=cast(str | None, row["reason"]),
        finished_at=cast(datetime | None, row["finished_at"]),
    )


def _results(rows: Sequence[_Row]) -> list[EnqueueResult]:
    results: list[EnqueueResult] = []
    for row in rows:
        outcome = cast(
            Literal["accepted", "replayed", "replaced", "non_replaceable", "coalesced"],
            row["outcome"],
        )
        reason = row.get("reason")
        if outcome == "non_replaceable" and reason not in {
            "incompatible_key_mode",
            "not_pending",
            "window_elapsed_pending",
        }:
            raise RuntimeError("PostgreSQL returned non_replaceable without a valid reason")
        results.append(
            EnqueueResult(
                job_id=str(row["job_id"]),
                outcome=outcome,
                reason=cast(
                    Literal["incompatible_key_mode", "not_pending", "window_elapsed_pending"]
                    | None,
                    reason,
                ),
            )
        )
    return results


def _one_row(rows: Sequence[_Row], operation: str) -> _Row:
    if len(rows) != 1:
        raise RuntimeError(f"{operation} returned {len(rows)} rows; expected one")
    return rows[0]


def _concurrency_policy(row: _Row) -> ConcurrencyPolicy:
    return ConcurrencyPolicy(
        namespace=str(row["namespace"]),
        queue=str(row["queue_name"]),
        max_active=int(cast(Any, row["max_active"])),
        max_active_per_key=(
            None if row["max_active_per_key"] is None else int(cast(Any, row["max_active_per_key"]))
        ),
        updated_at=cast(datetime, row["updated_at"]),
    )


def _concurrency_policy_payload(definitions: Sequence[ConcurrencyPolicyDefinition]) -> str:
    return json.dumps(
        [
            {
                "queue": definition.queue,
                "maxActive": definition.max_active,
                "maxActivePerKey": definition.max_active_per_key,
            }
            for definition in definitions
        ],
        separators=(",", ":"),
    )


def _rate_limit_policy_payload(definitions: Sequence[RateLimitPolicyDefinition]) -> str:
    return json.dumps(
        [
            {
                "queue": definition.queue,
                "rate": _rate_limit_document(definition.rate),
                "perKey": (
                    None if definition.per_key is None else _rate_limit_document(definition.per_key)
                ),
            }
            for definition in definitions
        ],
        separators=(",", ":"),
    )


def _rate_limit_document(rate: RateLimit) -> dict[str, int]:
    return {"limit": rate.limit, "intervalMs": rate.interval_ms, "burst": rate.burst}


def _rate_limit_policy(row: _Row) -> RateLimitPolicy:
    per_key = (
        None
        if row["per_key_limit"] is None
        else RateLimit(
            limit=int(cast(Any, row["per_key_limit"])),
            interval_ms=int(cast(Any, row["per_key_interval_ms"])),
            burst=int(cast(Any, row["per_key_burst"])),
        )
    )
    return RateLimitPolicy(
        namespace=str(row["namespace"]),
        queue=str(row["queue_name"]),
        rate=RateLimit(
            limit=int(cast(Any, row["rate_limit"])),
            interval_ms=int(cast(Any, row["rate_interval_ms"])),
            burst=int(cast(Any, row["rate_burst"])),
        ),
        per_key=per_key,
        updated_at=cast(datetime, row["updated_at"]),
    )


def _signal_parameters(
    job_id: str,
    name: str,
    payload: Json,
    idempotency_key: str,
    requested_by: str,
) -> tuple[object, ...]:
    return (
        job_id,
        _validate_wait_name(name, "Signal"),
        _encode_wait_value(payload, "Signal payload"),
        _validate_idempotency_key(idempotency_key, "Signal idempotency_key"),
        _validate_requested_by(requested_by, "Signal requested_by"),
    )


def _signal_result(row: _Row, job_id: str, name: str) -> SignalDeliveryResult:
    if row["status"] == "conflict":
        raise SignalIdempotencyConflictError(job_id, name)
    return SignalDeliveryResult(
        status=cast(Any, row["status"]),
        job_id=job_id,
        name=name,
        payload=cast(Json, row["payload"]),
        delivered_at=cast(Any, row["delivered_at"]),
        delivered_by=cast(str | None, row["delivered_by"]),
    )


def _human_parameters(
    job_id: str,
    name: str,
    result: Json,
    idempotency_key: str,
    requested_by: str,
) -> tuple[object, ...]:
    return (
        job_id,
        _validate_wait_name(name, "Human wait"),
        _encode_wait_value(result, "Human wait result"),
        _validate_idempotency_key(idempotency_key, "Human wait idempotency_key"),
        _validate_requested_by(requested_by, "Human wait requested_by"),
    )


def _human_result(row: _Row, job_id: str, name: str) -> HumanWaitCompletionResult:
    if row["status"] == "conflict":
        raise HumanWaitIdempotencyConflictError(job_id, name)
    return HumanWaitCompletionResult(
        status=cast(Any, row["status"]),
        job_id=job_id,
        name=name,
        payload=cast(Json, row["result"]),
        completed_at=cast(Any, row["completed_at"]),
        completed_by=cast(str | None, row["completed_by"]),
    )


__all__ = ["AsyncQueue", "Queue"]
