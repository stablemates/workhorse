from __future__ import annotations

import asyncio
from collections.abc import Mapping, Sequence
from threading import Lock
from typing import Protocol

from ._protocol import assert_compatible
from ._statements import STATEMENTS, DriverStatement
from .errors import ProtocolCompatibilityError


class SyncRowExecutor(Protocol):
    def rows(
        self, statement: DriverStatement, parameters: Sequence[object] = ()
    ) -> list[Mapping[str, object]]: ...


class AsyncRowExecutor(Protocol):
    async def rows(
        self, statement: DriverStatement, parameters: Sequence[object] = ()
    ) -> list[Mapping[str, object]]: ...


def assert_sync_compatible(executor: SyncRowExecutor) -> None:
    try:
        rows = executor.rows(STATEMENTS.compatibility)
    except Exception as error:
        _raise_if_missing_schema(error)
        raise
    assert_compatible(rows)


async def assert_async_compatible(executor: AsyncRowExecutor) -> None:
    try:
        rows = await executor.rows(STATEMENTS.compatibility)
    except Exception as error:
        _raise_if_missing_schema(error)
        raise
    assert_compatible(rows)


class CachedCompatibilityCheck:
    """Run one synchronous compatibility query and reuse its result."""

    def __init__(self, executor: SyncRowExecutor) -> None:
        self._executor = executor
        self._lock = Lock()
        self._checked = False
        self._error: Exception | None = None

    def assert_compatible(self) -> None:
        with self._lock:
            if not self._checked:
                try:
                    assert_sync_compatible(self._executor)
                except Exception as error:
                    self._error = error
                self._checked = True
        if self._error is not None:
            raise self._error


class AsyncCachedCompatibilityCheck:
    """Run one asynchronous compatibility query and reuse its result."""

    def __init__(self, executor: AsyncRowExecutor) -> None:
        self._executor = executor
        self._lock = asyncio.Lock()
        self._checked = False
        self._error: Exception | None = None

    async def assert_compatible(self) -> None:
        async with self._lock:
            if not self._checked:
                try:
                    await assert_async_compatible(self._executor)
                except Exception as error:
                    self._error = error
                self._checked = True
        if self._error is not None:
            raise self._error


def _raise_if_missing_schema(error: Exception) -> None:
    sqlstate = getattr(error, "sqlstate", None) or getattr(error, "code", None)
    if sqlstate in {"42P01", "3F000"}:
        raise ProtocolCompatibilityError("schema-not-installed") from error
