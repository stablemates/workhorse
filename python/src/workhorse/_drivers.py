from __future__ import annotations

import json
from collections.abc import Mapping, Sequence
from typing import Any, Protocol, cast

from psycopg.rows import tuple_row

from ._statements import SQL_STATEMENTS, DriverDialect, DriverStatement

Row = Mapping[str, object]


class SyncCursor(Protocol):
    description: Sequence[Sequence[object]] | None

    def __enter__(self) -> SyncCursor: ...

    def __exit__(self, *args: object) -> object: ...

    def execute(self, sql: str, parameters: Sequence[object] = ()) -> object: ...

    def fetchall(self) -> Sequence[Sequence[object]]: ...


class PsycopgConnection(Protocol):
    def cursor(self, *, row_factory: Any) -> SyncCursor: ...


class AsyncPsycopgCursor(Protocol):
    description: Sequence[Sequence[object]] | None

    async def __aenter__(self) -> AsyncPsycopgCursor: ...

    async def __aexit__(self, *args: object) -> object: ...

    async def execute(self, sql: str, parameters: Sequence[object] = ()) -> object: ...

    async def fetchall(self) -> Sequence[Sequence[object]]: ...


class AsyncPsycopgConnection(Protocol):
    autocommit: bool

    def cursor(self, *, row_factory: Any) -> AsyncPsycopgCursor: ...


class AsyncpgConnection(Protocol):
    async def fetch(self, query: str, *args: object) -> Sequence[Mapping[str, object]]: ...

    def is_in_transaction(self) -> bool: ...


class PsycopgPool(Protocol):
    @property
    def max_size(self) -> int: ...

    def connection(self) -> Any: ...


class AsyncPsycopgPool(Protocol):
    @property
    def max_size(self) -> int: ...

    def connection(self) -> Any: ...


class AsyncpgPool(Protocol):
    async def acquire(self) -> Any: ...

    async def release(self, connection: Any) -> None: ...

    def get_max_size(self) -> int: ...


class SyncExecutor:
    dialect: DriverDialect = "psycopg"

    def __init__(self, connection: PsycopgConnection) -> None:
        self.connection = connection

    def rows(self, statement: DriverStatement, parameters: Sequence[object] = ()) -> list[Row]:
        # The caller may configure any row factory; the SDK reads positional rows.
        with self.connection.cursor(row_factory=tuple_row) as cursor:
            cursor.execute(statement.for_dialect(self.dialect), parameters)
            return _mapping_rows(cursor.description, cursor.fetchall())


class AsyncPsycopgExecutor:
    dialect: DriverDialect = "psycopg"

    def __init__(self, connection: AsyncPsycopgConnection) -> None:
        self.connection = connection

    async def rows(
        self, statement: DriverStatement, parameters: Sequence[object] = ()
    ) -> list[Row]:
        async with self.connection.cursor(row_factory=tuple_row) as cursor:
            await cursor.execute(statement.for_dialect(self.dialect), parameters)
            return _mapping_rows(cursor.description, await cursor.fetchall())


class AsyncpgExecutor:
    dialect: DriverDialect = "asyncpg"

    def __init__(self, connection: AsyncpgConnection) -> None:
        self.connection = connection

    async def rows(
        self, statement: DriverStatement, parameters: Sequence[object] = ()
    ) -> list[Row]:
        records = await self.connection.fetch(statement.for_dialect(self.dialect), *parameters)
        if not records:
            return []
        json_columns = _JSON_COLUMNS.intersection(records[0].keys())
        if statement.asyncpg in _TEXT_RESULT_STATEMENTS:
            json_columns -= {"result"}
        rows: list[Row] = []
        for record in records:
            row = dict(record.items())
            for column in json_columns:
                value = row[column]
                if isinstance(value, str):
                    row[column] = json.loads(value)
            rows.append(row)
        return rows


class PooledSyncExecutor:
    dialect: DriverDialect = "psycopg"

    def __init__(self, pool: PsycopgPool) -> None:
        self.pool = pool

    def rows(self, statement: DriverStatement, parameters: Sequence[object] = ()) -> list[Row]:
        with self.pool.connection() as connection:
            return SyncExecutor(connection).rows(statement, parameters)


class PooledAsyncPsycopgExecutor:
    dialect: DriverDialect = "psycopg"

    def __init__(self, pool: AsyncPsycopgPool) -> None:
        self.pool = pool

    async def rows(
        self, statement: DriverStatement, parameters: Sequence[object] = ()
    ) -> list[Row]:
        async with self.pool.connection() as connection:
            return await AsyncPsycopgExecutor(connection).rows(statement, parameters)


class PooledAsyncpgExecutor:
    dialect: DriverDialect = "asyncpg"

    def __init__(self, pool: AsyncpgPool) -> None:
        self.pool = pool

    async def rows(
        self, statement: DriverStatement, parameters: Sequence[object] = ()
    ) -> list[Row]:
        connection = await self.pool.acquire()
        try:
            return await AsyncpgExecutor(connection).rows(statement, parameters)
        finally:
            await self.pool.release(connection)


_JSON_COLUMNS = frozenset(
    {
        "checkpoint_value",
        "children",
        "context",
        "details",
        "error",
        "payload",
        "progress_value",
        "result",
        "results",
        "retry_dimensions",
        "retry_policy",
        "trace_context",
    }
)

# Statements whose result column is text, not JSON: the result of a task group snapshot.
_TEXT_RESULT_STATEMENTS = frozenset(
    SQL_STATEMENTS[name][1]
    for name in (
        "cancel_task_group_v1",
        "get_task_group_v1",
        "seal_task_group_v1",
        "task_group_for_task_v1",
    )
)


def _mapping_rows(
    description: Sequence[Sequence[object]] | None,
    rows: Sequence[Sequence[object]],
) -> list[Row]:
    columns = [str(column[0]) for column in description or ()]
    return [dict(zip(columns, cast(Sequence[Any], row), strict=True)) for row in rows]
