from __future__ import annotations

from collections.abc import Mapping, Sequence
from typing import Any, Protocol, cast

from ._statements import DriverDialect, DriverStatement

Row = Mapping[str, object]


class SyncCursor(Protocol):
    description: Sequence[Sequence[object]] | None

    def __enter__(self) -> SyncCursor: ...

    def __exit__(self, *args: object) -> object: ...

    def execute(self, sql: str, parameters: Sequence[object] = ()) -> object: ...

    def fetchall(self) -> Sequence[Sequence[object]]: ...


class PsycopgConnection(Protocol):
    def cursor(self) -> SyncCursor: ...


class AsyncPsycopgCursor(Protocol):
    description: Sequence[Sequence[object]] | None

    async def __aenter__(self) -> AsyncPsycopgCursor: ...

    async def __aexit__(self, *args: object) -> object: ...

    async def execute(self, sql: str, parameters: Sequence[object] = ()) -> object: ...

    async def fetchall(self) -> Sequence[Sequence[object]]: ...


class AsyncPsycopgConnection(Protocol):
    def cursor(self) -> AsyncPsycopgCursor: ...


class AsyncpgConnection(Protocol):
    async def fetch(self, query: str, *args: object) -> Sequence[Mapping[str, object]]: ...


class SyncExecutor:
    dialect: DriverDialect = "psycopg"

    def __init__(self, connection: PsycopgConnection) -> None:
        self.connection = connection

    def rows(self, statement: DriverStatement, parameters: Sequence[object] = ()) -> list[Row]:
        with self.connection.cursor() as cursor:
            cursor.execute(statement.for_dialect(self.dialect), parameters)
            return _mapping_rows(cursor.description, cursor.fetchall())


class AsyncPsycopgExecutor:
    dialect: DriverDialect = "psycopg"

    def __init__(self, connection: AsyncPsycopgConnection) -> None:
        self.connection = connection

    async def rows(
        self, statement: DriverStatement, parameters: Sequence[object] = ()
    ) -> list[Row]:
        async with self.connection.cursor() as cursor:
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
        return [dict(record) for record in records]


def _mapping_rows(
    description: Sequence[Sequence[object]] | None,
    rows: Sequence[Sequence[object]],
) -> list[Row]:
    columns = [str(column[0]) for column in description or ()]
    return [dict(zip(columns, cast(Sequence[Any], row), strict=True)) for row in rows]
