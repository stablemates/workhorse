"""A worker needs a pool with a known maximum size of at least 3 connections (ADR 0071).

The listener and the dedicated heartbeat connection each hold one pooled connection, and claims
and completions need at least one more. 0.11.0 removed the ``shared_heartbeats`` opt-out, so a
caller that still passes it gets an error that names the removal.
"""

from __future__ import annotations

import re
from collections.abc import Callable
from typing import Any

import pytest

from workhorse import AsyncWorker, Worker

REMOVED = (
    "shared_heartbeats was removed in 0.11.0. Every worker now reserves a dedicated heartbeat "
    "connection. Remove the option, and give the worker a pool with a known maximum size of at "
    "least 3."
)


def too_small(found: str) -> str:
    return (
        f"Worker needs a pool with a known maximum size of at least 3 connections (found "
        f"{found}). Give the worker a pool with a maximum size of at least 3."
    )


class SizedPool:
    """A pool the worker never draws a connection from at construction."""

    def __init__(self, max_size: object) -> None:
        self.max_size = max_size


class GetterPool:
    """An asyncpg-shaped pool that reports its size through ``get_max_size()``."""

    def __init__(self, max_size: object) -> None:
        self._max_size = max_size

    def get_max_size(self) -> object:
        return self._max_size


class UnsizedPool:
    """A pool that reports no maximum size."""


def sync_worker(pool: object, **options: Any) -> Worker:
    return Worker(pool, queue="pool-size", **options)  # type: ignore[arg-type]


def psycopg_worker(pool: object, **options: Any) -> AsyncWorker:
    return AsyncWorker.from_psycopg(pool, queue="pool-size", **options)  # type: ignore[arg-type]


def asyncpg_worker(pool: object, **options: Any) -> AsyncWorker:
    return AsyncWorker.from_asyncpg(pool, queue="pool-size", **options)  # type: ignore[arg-type]


CONSTRUCTORS = [
    pytest.param(sync_worker, SizedPool, id="Worker"),
    pytest.param(psycopg_worker, SizedPool, id="AsyncWorker.from_psycopg"),
    pytest.param(asyncpg_worker, GetterPool, id="AsyncWorker.from_asyncpg"),
]


OWNED_CONSTRUCTORS = [
    pytest.param("Worker.__init__", sync_worker, SizedPool, id="Worker"),
    pytest.param(
        "AsyncWorker.from_psycopg", psycopg_worker, SizedPool, id="AsyncWorker.from_psycopg"
    ),
    pytest.param(
        "AsyncWorker.from_asyncpg", asyncpg_worker, GetterPool, id="AsyncWorker.from_asyncpg"
    ),
]


@pytest.mark.parametrize(
    ("size", "found"),
    [(1, "1"), (2, "2"), (None, "unknown"), ("5", "unknown"), (True, "unknown")],
    ids=["max-size-1", "max-size-2", "no-size", "non-int-size", "bool-size"],
)
@pytest.mark.parametrize(("construct", "pool_type"), CONSTRUCTORS)
def test_a_worker_on_a_pool_below_three_fails_at_construction(
    construct: Callable[..., object],
    pool_type: Callable[[object], object],
    size: object,
    found: str,
) -> None:
    pool = UnsizedPool() if size is None else pool_type(size)
    with pytest.raises(ValueError) as refused:
        construct(pool)
    assert str(refused.value) == too_small(found)
    assert "shared_heartbeats" not in str(refused.value)


@pytest.mark.parametrize(("construct", "pool_type"), CONSTRUCTORS)
def test_every_constructor_accepts_a_pool_of_three(
    construct: Callable[..., object], pool_type: Callable[[object], object]
) -> None:
    construct(pool_type(3))


@pytest.mark.parametrize("value", [True, False])
@pytest.mark.parametrize(("construct", "pool_type"), CONSTRUCTORS)
def test_the_removed_opt_out_raises_a_type_error_that_names_the_removal(
    construct: Callable[..., object],
    pool_type: Callable[[object], object],
    value: bool,
) -> None:
    with pytest.raises(TypeError) as refused:
        construct(pool_type(5), shared_heartbeats=value)
    assert str(refused.value) == REMOVED


def test_the_removed_opt_out_is_named_even_on_a_small_pool() -> None:
    # The removal error comes first, so a caller who relied on the opt-out learns why.
    with pytest.raises(TypeError, match=re.escape(REMOVED)):
        sync_worker(SizedPool(1), shared_heartbeats=True)


@pytest.mark.parametrize(
    ("owner", "construct", "pool_type"),
    [
        ("Worker.__init__", sync_worker, SizedPool),
        ("AsyncWorker.from_psycopg", psycopg_worker, SizedPool),
        ("AsyncWorker.from_asyncpg", asyncpg_worker, GetterPool),
    ],
    ids=["Worker", "AsyncWorker.from_psycopg", "AsyncWorker.from_asyncpg"],
)
def test_another_unknown_keyword_raises_the_usual_type_error(
    owner: str, construct: Callable[..., object], pool_type: Callable[[object], object]
) -> None:
    with pytest.raises(TypeError) as refused:
        construct(pool_type(5), polling_only=True)
    assert str(refused.value) == f"{owner}() got an unexpected keyword argument 'polling_only'"


@pytest.mark.parametrize(
    ("owner", "construct", "pool_type"),
    [
        ("Worker.__init__", sync_worker, SizedPool),
        ("AsyncWorker.from_psycopg", psycopg_worker, SizedPool),
        ("AsyncWorker.from_asyncpg", asyncpg_worker, GetterPool),
    ],
    ids=["Worker", "AsyncWorker.from_psycopg", "AsyncWorker.from_asyncpg"],
)
def test_a_misspelled_keyword_names_itself_and_not_the_removed_option(
    owner: str, construct: Callable[..., object], pool_type: Callable[[object], object]
) -> None:
    # The variadic that catches shared_heartbeats must not hide a typo behind the removal error.
    with pytest.raises(TypeError) as refused:
        construct(pool_type(5), capacty=3)
    assert str(refused.value) == f"{owner}() got an unexpected keyword argument 'capacty'"
    assert "shared_heartbeats" not in str(refused.value)


@pytest.mark.parametrize(
    "options",
    [
        {"capacty": 3, "shared_heartbeats": True},
        {"shared_heartbeats": True, "capacty": 3},
    ],
    ids=["typo-first", "removed-first"],
)
@pytest.mark.parametrize(("owner", "construct", "pool_type"), OWNED_CONSTRUCTORS)
def test_a_misspelled_keyword_wins_over_the_removed_option(
    owner: str,
    construct: Callable[..., object],
    pool_type: Callable[[object], object],
    options: dict[str, object],
) -> None:
    # A caller fixes the typo first, then meets the removal error, then the pool size.
    with pytest.raises(TypeError) as refused:
        construct(pool_type(1), **options)
    assert str(refused.value) == f"{owner}() got an unexpected keyword argument 'capacty'"


def test_the_default_cohorts_keep_one_connection_each_for_the_listener_and_heartbeat() -> None:
    # A pool of 3 leaves one connection for claims, so a busy worker dispatches as one cohort.
    assert sync_worker(SizedPool(3), concurrency=64).cohorts == 1
    assert sync_worker(SizedPool(5), concurrency=64).cohorts == 3
    assert sync_worker(GetterPool(12), concurrency=64).cohorts == 8
