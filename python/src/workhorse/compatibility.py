from __future__ import annotations

from typing import TYPE_CHECKING, Any, cast

from ._compatibility import (
    assert_async_compatible as _assert_async_compatible,
    assert_sync_compatible as _assert_sync_compatible,
)
from ._drivers import (
    AsyncpgConnection as _AsyncpgConnection,
    AsyncpgExecutor as _AsyncpgExecutor,
    AsyncPsycopgConnection as _AsyncPsycopgConnection,
    AsyncPsycopgExecutor as _AsyncPsycopgExecutor,
    PsycopgConnection as _PsycopgConnection,
    SyncExecutor as _SyncExecutor,
)

if TYPE_CHECKING:
    import psycopg

    _SyncConnection = psycopg.Connection[Any]
    _AsyncPsycopgConnectionInput = psycopg.AsyncConnection[Any]
else:
    _SyncConnection = _PsycopgConnection
    _AsyncPsycopgConnectionInput = _AsyncPsycopgConnection


def assert_schema_compatible(connection: _SyncConnection) -> None:
    """Refuse to start when the installed schema cannot serve this client.

    Call this once from a synchronous Psycopg application or worker process at startup. It reads
    the installed schema version and creates or changes nothing. An incompatible or missing schema
    raises `ProtocolCompatibilityError`, whose `code` names the refusal.
    """
    _assert_sync_compatible(_SyncExecutor(cast(_PsycopgConnection, connection)))


async def assert_schema_compatible_psycopg(connection: _AsyncPsycopgConnectionInput) -> None:
    """Assert schema compatibility over an asynchronous Psycopg connection."""
    await _assert_async_compatible(_AsyncPsycopgExecutor(cast(_AsyncPsycopgConnection, connection)))


async def assert_schema_compatible_asyncpg(connection: _AsyncpgConnection) -> None:
    """Assert schema compatibility over an asyncpg connection."""
    await _assert_async_compatible(_AsyncpgExecutor(connection))


__all__ = [
    "assert_schema_compatible",
    "assert_schema_compatible_asyncpg",
    "assert_schema_compatible_psycopg",
]
