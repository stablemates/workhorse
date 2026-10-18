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

    def execute(
        self, sql: str, parameters: Sequence[object] = (), *, prepare: bool | None = None
    ) -> object: ...

    def fetchall(self) -> Sequence[Sequence[object]]: ...


class PsycopgConnection(Protocol):
    def cursor(self, *, row_factory: Any) -> SyncCursor: ...


class AsyncPsycopgCursor(Protocol):
    description: Sequence[Sequence[object]] | None

    async def __aenter__(self) -> AsyncPsycopgCursor: ...

    async def __aexit__(self, *args: object) -> object: ...

    async def execute(
        self, sql: str, parameters: Sequence[object] = (), *, prepare: bool | None = None
    ) -> object: ...

    async def fetchall(self) -> Sequence[Sequence[object]]: ...


class AsyncPsycopgConnection(Protocol):
    autocommit: bool

    def cursor(self, *, row_factory: Any) -> AsyncPsycopgCursor: ...


class AsyncpgPreparedStatement(Protocol):
    async def fetch(self, *args: object) -> Sequence[Mapping[str, object]]: ...


class AsyncpgConnection(Protocol):
    async def fetch(self, query: str, *args: object) -> Sequence[Mapping[str, object]]: ...

    async def execute(self, query: str, *args: object) -> str: ...

    async def prepare(self, query: str) -> AsyncpgPreparedStatement: ...

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


def _execute_options(prepare: bool | None) -> dict[str, bool]:
    # Without a value, the call stays as before, so a cursor class that does not take prepare works.
    return {} if prepare is None else {"prepare": prepare}


class SyncExecutor:
    """Run statements on one psycopg connection.

    With ``prepare=False``, psycopg never prepares a statement in a cycle of its own. PostgreSQL
    then parses each statement in the cycle that runs it, under its ``statement_timeout``.
    ``None`` keeps the connection's ``prepare_threshold``.
    """

    dialect: DriverDialect = "psycopg"

    def __init__(self, connection: PsycopgConnection, *, prepare: bool | None = None) -> None:
        self.connection = connection
        self._options = _execute_options(prepare)

    def rows(self, statement: DriverStatement, parameters: Sequence[object] = ()) -> list[Row]:
        # The caller may configure any row factory; the SDK reads positional rows.
        with self.connection.cursor(row_factory=tuple_row) as cursor:
            cursor.execute(statement.for_dialect(self.dialect), parameters, **self._options)
            return _mapping_rows(cursor.description, cursor.fetchall())

    def command(self, statement: DriverStatement, parameters: Sequence[object] = ()) -> None:
        """Send a statement that returns no rows, such as BEGIN."""
        with self.connection.cursor(row_factory=tuple_row) as cursor:
            cursor.execute(statement.for_dialect(self.dialect), parameters, **self._options)


class AsyncPsycopgExecutor:
    """Run statements on one async psycopg connection. ``prepare`` is as for `SyncExecutor`."""

    dialect: DriverDialect = "psycopg"

    def __init__(self, connection: AsyncPsycopgConnection, *, prepare: bool | None = None) -> None:
        self.connection = connection
        self._options = _execute_options(prepare)

    async def rows(
        self, statement: DriverStatement, parameters: Sequence[object] = ()
    ) -> list[Row]:
        async with self.connection.cursor(row_factory=tuple_row) as cursor:
            await cursor.execute(statement.for_dialect(self.dialect), parameters, **self._options)
            return _mapping_rows(cursor.description, await cursor.fetchall())

    async def command(self, statement: DriverStatement, parameters: Sequence[object] = ()) -> None:
        """Send a statement that returns no rows, such as BEGIN."""
        async with self.connection.cursor(row_factory=tuple_row) as cursor:
            await cursor.execute(statement.for_dialect(self.dialect), parameters, **self._options)


class AsyncpgExecutor:
    dialect: DriverDialect = "asyncpg"

    def __init__(self, connection: AsyncpgConnection) -> None:
        self.connection = connection
        self._prepared: dict[str, AsyncpgPreparedStatement] = {}

    async def command(self, statement: DriverStatement, parameters: Sequence[object] = ()) -> None:
        """Send a statement that returns no rows, such as BEGIN."""
        sql = statement.for_dialect(self.dialect)
        if parameters:
            await self.connection.fetch(sql, *parameters)
        else:
            # Without arguments, asyncpg sends a simple query, which it does not prepare first.
            await self.connection.execute(sql)

    async def prepare(self, statement: DriverStatement) -> None:
        """Prepare `statement` now, so that `rows` runs it without a preparation of its own.

        asyncpg otherwise prepares a statement in a cycle of its own on its first use on each
        connection, and on every use without a statement cache. A heartbeat round calls this
        before it sets its server budgets. The statement stays prepared on this connection.
        """
        sql = statement.for_dialect(self.dialect)
        if sql not in self._prepared:
            self._prepared[sql] = await self.connection.prepare(sql)

    async def rows(
        self, statement: DriverStatement, parameters: Sequence[object] = ()
    ) -> list[Row]:
        sql = statement.for_dialect(self.dialect)
        prepared = self._prepared.get(sql)
        records = await (
            prepared.fetch(*parameters)
            if prepared is not None
            else self.connection.fetch(sql, *parameters)
        )
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
