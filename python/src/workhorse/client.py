from __future__ import annotations

from collections.abc import Sequence
from typing import TYPE_CHECKING, Any, Literal, NoReturn, cast

from ._drivers import (
    AsyncpgConnection,
    AsyncpgExecutor,
    AsyncPsycopgConnection,
    AsyncPsycopgExecutor,
    PsycopgConnection,
    Row,
    SyncExecutor,
)
from ._protocol import assert_compatible, serialize_requests, serialize_schedules
from .errors import ProtocolCompatibilityError, translate_database_error
from .types import EnqueueOptions, EnqueueRequest, EnqueueResult, Json, ScheduleDefinition

if TYPE_CHECKING:
    import psycopg

    SyncConnection = psycopg.Connection[Any]
    AsyncPsycopgConnectionInput = psycopg.AsyncConnection[Any]
else:
    SyncConnection = PsycopgConnection
    AsyncPsycopgConnectionInput = AsyncPsycopgConnection

COMPATIBILITY_SQL = "SELECT version FROM workhorse.schema_version ORDER BY version"
ENQUEUE_SQL = (
    "SELECT ordinal, job_id, outcome, reason "
    "FROM workhorse.enqueue_many_v2(%s::jsonb) ORDER BY ordinal"
)
SCHEDULES_SQL = "SELECT workhorse.sync_schedule_definitions_v1(%s::text, %s::jsonb, %s::boolean)"


class Queue:
    """Synchronous enqueue client over a caller-owned Psycopg connection."""

    def __init__(self, connection: SyncConnection, default_queue: str = "default") -> None:
        self._executor = SyncExecutor(cast(PsycopgConnection, connection))
        self.default_queue = default_queue

    def enqueue(self, type: str, payload: Json, options: EnqueueOptions | None = None) -> str:
        return self.enqueue_with_result(type, payload, options).job_id

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
        payload = serialize_requests(requests, self.default_queue)
        try:
            return _results(self._executor.rows(ENQUEUE_SQL, (payload,)))
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
        payload = serialize_schedules(definitions, self.default_queue)
        self._executor.rows(SCHEDULES_SQL, (namespace, payload, prune))


class AsyncQueue:
    """Asynchronous enqueue client over a caller-owned Psycopg or asyncpg connection."""

    def __init__(
        self,
        executor: AsyncPsycopgExecutor | AsyncpgExecutor,
        default_queue: str = "default",
    ) -> None:
        self._executor = executor
        self.default_queue = default_queue

    @classmethod
    def from_psycopg(
        cls, connection: AsyncPsycopgConnectionInput, default_queue: str = "default"
    ) -> AsyncQueue:
        return cls(AsyncPsycopgExecutor(cast(AsyncPsycopgConnection, connection)), default_queue)

    @classmethod
    def from_asyncpg(
        cls, connection: AsyncpgConnection, default_queue: str = "default"
    ) -> AsyncQueue:
        return cls(AsyncpgExecutor(connection), default_queue)

    async def enqueue(self, type: str, payload: Json, options: EnqueueOptions | None = None) -> str:
        return (await self.enqueue_with_result(type, payload, options)).job_id

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
        payload = serialize_requests(requests, self.default_queue)
        sql = ENQUEUE_SQL.replace("%s", self._executor.placeholder)
        try:
            return _results(await self._executor.rows(sql, (payload,)))
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
        payload = serialize_schedules(definitions, self.default_queue)
        if self._executor.placeholder == "$1":
            sql = SCHEDULES_SQL.replace("%s", "$1", 1)
            sql = sql.replace("%s", "$2", 1).replace("%s", "$3", 1)
        else:
            sql = SCHEDULES_SQL
        await self._executor.rows(sql, (namespace, payload, prune))


def _assert_sync_compatible(executor: SyncExecutor) -> None:
    try:
        rows = executor.rows(COMPATIBILITY_SQL)
    except Exception as error:
        if _is_missing_schema(error):
            raise ProtocolCompatibilityError("schema-not-installed") from error
        raise
    assert_compatible(rows)


async def _assert_async_compatible(executor: AsyncPsycopgExecutor | AsyncpgExecutor) -> None:
    try:
        rows = await executor.rows(COMPATIBILITY_SQL)
    except Exception as error:
        if _is_missing_schema(error):
            raise ProtocolCompatibilityError("schema-not-installed") from error
        raise
    assert_compatible(rows)


def _is_missing_schema(error: Exception) -> bool:
    sqlstate = getattr(error, "sqlstate", None) or getattr(error, "code", None)
    return sqlstate in {"42P01", "3F000"}


def _raise_translated(error: Exception) -> NoReturn:
    translated = translate_database_error(error)
    if translated is not None:
        raise translated from error
    raise error


def _results(rows: Sequence[Row]) -> list[EnqueueResult]:
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
