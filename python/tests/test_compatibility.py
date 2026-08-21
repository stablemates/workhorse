from __future__ import annotations

from collections.abc import Mapping, Sequence

import pytest

from workhorse import ProtocolCompatibilityError
from workhorse._compatibility import (
    AsyncCachedCompatibilityCheck,
    CachedCompatibilityCheck,
    assert_async_compatible,
    assert_sync_compatible,
)


class SyncExecutor:
    def __init__(self, rows: Sequence[Mapping[str, object]]) -> None:
        self.rows_result = rows
        self.calls = 0

    def rows(self, _statement: object) -> list[Mapping[str, object]]:
        self.calls += 1
        return list(self.rows_result)


class AsyncExecutor:
    def __init__(self, rows: Sequence[Mapping[str, object]]) -> None:
        self.rows_result = rows
        self.calls = 0

    async def rows(self, _statement: object) -> list[Mapping[str, object]]:
        self.calls += 1
        return list(self.rows_result)


def test_sync_compatibility_check_queries_on_every_call() -> None:
    executor = SyncExecutor([{"version": 47}])

    assert_sync_compatible(executor)
    assert_sync_compatible(executor)

    assert executor.calls == 2


def test_sync_cached_compatibility_check_queries_once() -> None:
    executor = SyncExecutor([{"version": 47}])
    check = CachedCompatibilityCheck(executor)

    check.assert_compatible()
    check.assert_compatible()

    assert executor.calls == 1


def test_sync_cached_compatibility_check_reuses_a_refusal() -> None:
    executor = SyncExecutor([{"version": 42}])
    check = CachedCompatibilityCheck(executor)

    for _ in range(2):
        with pytest.raises(ProtocolCompatibilityError) as raised:
            check.assert_compatible()
        assert raised.value.code == "schema-too-old"

    assert executor.calls == 1


@pytest.mark.asyncio
async def test_async_compatibility_check_queries_on_every_call() -> None:
    executor = AsyncExecutor([{"version": 47}])

    await assert_async_compatible(executor)
    await assert_async_compatible(executor)

    assert executor.calls == 2


@pytest.mark.asyncio
async def test_async_cached_compatibility_check_queries_once() -> None:
    executor = AsyncExecutor([{"version": 47}])
    check = AsyncCachedCompatibilityCheck(executor)

    await check.assert_compatible()
    await check.assert_compatible()

    assert executor.calls == 1


@pytest.mark.asyncio
async def test_async_cached_compatibility_check_reuses_a_refusal() -> None:
    executor = AsyncExecutor([{"version": 42}])
    check = AsyncCachedCompatibilityCheck(executor)

    for _ in range(2):
        with pytest.raises(ProtocolCompatibilityError) as raised:
            await check.assert_compatible()
        assert raised.value.code == "schema-too-old"

    assert executor.calls == 1
