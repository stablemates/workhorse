from __future__ import annotations

from typing import TYPE_CHECKING, Any, cast

from ._compatibility import assert_async_compatible, assert_sync_compatible
from ._drivers import (
    AsyncpgConnection,
    AsyncpgExecutor,
    AsyncPsycopgConnection,
    AsyncPsycopgExecutor,
    PsycopgConnection,
    SyncExecutor,
)

if TYPE_CHECKING:
    import psycopg

    SyncConnection = psycopg.Connection[Any]
    AsyncPsycopgConnectionInput = psycopg.AsyncConnection[Any]
else:
    SyncConnection = PsycopgConnection
    AsyncPsycopgConnectionInput = AsyncPsycopgConnection


def assert_schema_compatible(connection: SyncConnection) -> None:
    """Refuse to start when the installed schema cannot serve this client.

    Call this once from a synchronous Psycopg application or worker process at startup. It reads
    the installed schema version and creates or changes nothing. An incompatible or missing schema
    raises `ProtocolCompatibilityError`, whose `code` names the refusal.
    """
    assert_sync_compatible(SyncExecutor(cast(PsycopgConnection, connection)))


async def assert_schema_compatible_psycopg(connection: AsyncPsycopgConnectionInput) -> None:
    """Assert schema compatibility over an asynchronous Psycopg connection."""
    await assert_async_compatible(AsyncPsycopgExecutor(cast(AsyncPsycopgConnection, connection)))


async def assert_schema_compatible_asyncpg(connection: AsyncpgConnection) -> None:
    """Assert schema compatibility over an asyncpg connection."""
    await assert_async_compatible(AsyncpgExecutor(connection))
